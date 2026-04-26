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
  await testWebCodecsAudioDecodePath();
  console.log('vds-web protocol tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
