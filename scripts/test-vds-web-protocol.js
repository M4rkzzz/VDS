const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');

function loadTsModule(relativePath, globals = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
    },
    fileName: absolutePath
  });

  const module = { exports: {} };
  const fn = new Function(
    'module',
    'exports',
    'require',
    ...Object.keys(globals),
    `${transpiled.outputText}\nreturn module.exports;`
  );
  return fn(
    module,
    module.exports,
    require,
    ...Object.values(globals)
  );
}

function makeFramePayload() {
  return new Uint8Array([
    0, 0, 0, 1,
    0x67, 0x42, 0xe0, 0x1f, 0x89, 0x8b,
    0, 0, 0, 1,
    0x68, 0xce, 0x3c, 0x80,
    0, 0, 0, 1,
    0x65, 0x88, 0x84
  ]).buffer;
}

function makeHevcFramePayload() {
  return new Uint8Array([
    0, 0, 0, 1,
    0x42, 0x01, 0x01, 0x01,
    0, 0, 0, 1,
    0x44, 0x01, 0x01, 0x01, 0x01, 0x5d, 0x5d,
    0, 0, 0, 1,
    0x4e, 0x01, 0x01, 0x01,
    0, 0, 0, 1,
    0x26, 0x01, 0x80, 0x88, 0x84
  ]).buffer;
}

function testDataChannelFrameEnvelope() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const payload = makeFramePayload();
  const encoded = protocol.encodeFrameMessage({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'frame',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 123456,
    sequence: 7,
    keyframe: true,
    config: true
  }, payload);

  const decoded = protocol.decodeFrameMessage(encoded);
  assert.strictEqual(decoded.header.protocol, protocol.ENCODED_MEDIA_PROTOCOL);
  assert.strictEqual(decoded.header.streamType, 'video');
  assert.strictEqual(decoded.header.codec, 'h264');
  assert.strictEqual(decoded.header.timestampUs, 123456);
  assert.strictEqual(decoded.header.sequence, 7);
  assert.strictEqual(decoded.header.keyframe, true);
  assert.deepStrictEqual(Array.from(new Uint8Array(decoded.payload)), Array.from(new Uint8Array(payload)));
}

function testDataChannelFrameRejection() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  assert.throws(
    () => protocol.decodeFrameMessage(new Uint8Array([0x42, 0x41, 0x44, 0x21]).buffer),
    /datachannel-frame-invalid/
  );
}

function testDataChannelFrameChunking() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const payload = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 2 + 17);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index % 251;
  }

  const messages = protocol.encodeFrameMessages({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'frame',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 987654,
    sequence: 9,
    keyframe: true,
    config: true
  }, payload.buffer);
  assert.ok(messages.length > 1);

  const reassembler = new protocol.EncodedFrameReassembler();
  let decoded = null;
  for (const message of messages) {
    decoded = reassembler.push(message) || decoded;
  }
  assert.ok(decoded);
  assert.strictEqual(decoded.header.type, 'frame');
  assert.strictEqual(decoded.header.timestampUs, 987654);
  assert.deepStrictEqual(Array.from(new Uint8Array(decoded.payload)), Array.from(payload));
}

async function testWebCodecsPlayerDecodePath() {
  const decodedChunks = [];
  const renderedFrames = [];
  const states = [];
  const drops = [];
  const formats = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      assert.strictEqual(config.codec, 'avc1.42E01F');
      assert.deepStrictEqual(config.avc, { format: 'annexb' });
      return { supported: true };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        close: () => renderedFrames.push('closed')
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => renderedFrames.push('drawn')
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsH264Player(fakeCanvas, {
      onState: (state) => states.push(state),
      onDecodedFrame: () => renderedFrames.push('decoded'),
      onDroppedFrame: (reason) => drops.push(reason),
      onPayloadFormat: (format) => formats.push(format)
    });

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h264',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeFramePayload());

    assert.strictEqual(decodedChunks.length, 1);
    assert.strictEqual(decodedChunks[0].type, 'key');
    assert.strictEqual(decodedChunks[0].timestamp, 9000);
    assert.strictEqual(fakeCanvas.width, 1280);
    assert.strictEqual(fakeCanvas.height, 720);
    assert.ok(states.includes('webcodecs-configured-avc1.42E01F'));
    assert.ok(renderedFrames.includes('decoded'));
    assert.deepStrictEqual(drops, []);
    assert.ok(formats.includes('annexb'));
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevc2kLevelSelection() {
  const states = [];
  const drops = [];
  const supportedCodecs = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      supportedCodecs.push(config.codec);
      assert.deepStrictEqual(config.hevc, { format: 'annexb' });
      if (config.codec === 'hev1.1.6.L150.B0') {
        assert.strictEqual(config.codedWidth, 2560);
        assert.strictEqual(config.codedHeight, 1440);
        assert.strictEqual(config.displayAspectWidth, 2560);
        assert.strictEqual(config.displayAspectHeight, 1440);
      }
      return { supported: config.codec === 'hev1.1.6.L150.B0' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        displayWidth: 2560,
        displayHeight: 1440,
        codedWidth: 2560,
        codedHeight: 1440,
        visibleRect: { x: 0, y: 0, width: 2560, height: 1440 },
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsH264Player(fakeCanvas, {
      onState: (state) => states.push(state),
      onDecodedFrame: () => {},
      onDroppedFrame: (reason) => drops.push(reason),
      onPayloadFormat: () => {}
    });
    player.setExpectedDisplaySize(2560, 1440);

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.strictEqual(supportedCodecs[0], 'hev1.1.6.L150.B0');
    assert.ok(states.includes('webcodecs-configured-hev1.1.6.L150.B0'));
    assert.strictEqual(fakeCanvas.width, 2560);
    assert.strictEqual(fakeCanvas.height, 1440);
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevc1080pCodedDimensionAlignment() {
  const seenConfigs = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      seenConfigs.push(config);
      return { supported: config.codec === 'hev1.1.6.L123.B0' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        displayWidth: 1920,
        displayHeight: 1080,
        codedWidth: 1920,
        codedHeight: 1088,
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsH264Player(fakeCanvas, {
      onState: () => {},
      onDecodedFrame: () => {},
      onDroppedFrame: () => {},
      onPayloadFormat: () => {}
    });
    player.setExpectedDisplaySize(1920, 1080);

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.strictEqual(seenConfigs[0].codec, 'hev1.1.6.L123.B0');
    assert.strictEqual(seenConfigs[0].codedWidth, 1920);
    assert.strictEqual(seenConfigs[0].codedHeight, 1088);
    assert.strictEqual(seenConfigs[0].displayAspectWidth, 1920);
    assert.strictEqual(seenConfigs[0].displayAspectHeight, 1080);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevcUsesDecodedSizeWhenStreamIsSmallerThanManifest() {
  const frameInfos = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      return { supported: config.codec === 'hev1.1.6.L123.B0' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        codedWidth: 1280,
        codedHeight: 720,
        visibleRect: { x: 0, y: 0, width: 1280, height: 720 },
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsH264Player(fakeCanvas, {
      onState: () => {},
      onDecodedFrame: () => {},
      onDroppedFrame: () => {},
      onPayloadFormat: () => {},
      onVideoFrameInfo: (info) => frameInfos.push(info)
    });
    player.setExpectedDisplaySize(1920, 1080);

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.strictEqual(fakeCanvas.width, 1280);
    assert.strictEqual(fakeCanvas.height, 720);
    assert.strictEqual(frameInfos[0].sourceWidth, 1280);
    assert.strictEqual(frameInfos[0].sourceHeight, 720);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsAudioDecodePath() {
  const decodedChunks = [];
  const states = [];
  const drops = [];
  const decodedBlocks = [];
  const starts = [];

  class FakeEncodedAudioChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeAudioDecoder {
    static async isConfigSupported(config) {
      assert.strictEqual(config.codec, 'opus');
      assert.strictEqual(config.sampleRate, 48000);
      assert.strictEqual(config.numberOfChannels, 2);
      return { supported: true };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        sampleRate: 48000,
        numberOfChannels: 2,
        numberOfFrames: 2,
        copyTo: (target) => {
          target[0] = 0;
          target[1] = 0;
        },
        close: () => decodedBlocks.push('closed')
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  class FakeAudioContext {
    constructor(init) {
      this.sampleRate = init.sampleRate;
      this.destination = {};
      this.state = 'running';
      this.currentTime = 10;
    }

    createBuffer(channels, frames, sampleRate) {
      assert.strictEqual(channels, 2);
      assert.strictEqual(frames, 2);
      assert.strictEqual(sampleRate, 48000);
      return {
        duration: frames / sampleRate,
        getChannelData: () => new Float32Array(frames)
      };
    }

    createBufferSource() {
      return {
        connect: () => {},
        start: (when) => {
          starts.push(when);
          decodedBlocks.push('started');
        }
      };
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect: () => {}
      };
    }
  }

  const previousWindow = global.window;
  const previousAudioContext = global.AudioContext;
  global.window = {
    AudioDecoder: FakeAudioDecoder,
    EncodedAudioChunk: FakeEncodedAudioChunk
  };
  global.AudioContext = FakeAudioContext;

  try {
    const audioModule = loadTsModule('vds_web/src/webcodecs-audio-player.ts');
    const player = new audioModule.WebCodecsAudioPlayer({
      onState: (state) => states.push(state),
      onDecodedBlock: () => decodedBlocks.push('decoded'),
      onDroppedBlock: (reason) => drops.push(reason)
    });
    player.setDelayMs(120);
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'opus',
      payloadFormat: 'raw',
      timestampUs: 20000,
      sequence: 1,
      keyframe: true,
      config: false
    }, new Uint8Array([1, 2, 3, 4]).buffer);
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'opus',
      payloadFormat: 'raw',
      timestampUs: 40000,
      sequence: 2,
      keyframe: true,
      config: false
    }, new Uint8Array([1, 2, 3, 4]).buffer);

    assert.strictEqual(decodedChunks.length, 2);
    assert.strictEqual(decodedChunks[0].timestamp, 20000);
    assert.ok(states.includes('webcodecs-audio-configured-opus'));
    assert.ok(decodedBlocks.includes('decoded'));
    assert.strictEqual(starts[0], 10.12);
    assert.strictEqual(starts[1], 10.12 + (2 / 48000));
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
    global.AudioContext = previousAudioContext;
  }
}

async function main() {
  testDataChannelFrameEnvelope();
  testDataChannelFrameRejection();
  testDataChannelFrameChunking();
  await testWebCodecsPlayerDecodePath();
  await testWebCodecsHevc2kLevelSelection();
  await testWebCodecsHevc1080pCodedDimensionAlignment();
  await testWebCodecsHevcUsesDecodedSizeWhenStreamIsSmallerThanManifest();
  await testWebCodecsAudioDecodePath();
  console.log('vds-web protocol tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
