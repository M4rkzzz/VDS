const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');

function encodeFixture(args) {
  const ffmpeg = process.env.VDS_TEST_FFMPEG || path.join(repoRoot, 'runtime/media-agent/ffmpeg/bin/ffmpeg.exe');
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], {
    windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function aacPackets(buffer) {
  const packets = [];
  for (let offset = 0; offset < buffer.length;) {
    assert.strictEqual(buffer[offset], 0xff);
    const length = ((buffer[offset + 3] & 3) << 11) | (buffer[offset + 4] << 3) | (buffer[offset + 5] >> 5);
    assert.ok(length >= 7 && offset + length <= buffer.length);
    packets.push(buffer.subarray(offset, offset + length).toString('base64'));
    offset += length;
  }
  return packets;
}

function opusPackets(buffer) {
  const packets = [];
  let parts = [];
  for (let offset = 0; offset < buffer.length;) {
    assert.strictEqual(buffer.toString('ascii', offset, offset + 4), 'OggS');
    const segments = buffer[offset + 26];
    let cursor = offset + 27 + segments;
    for (let index = 0; index < segments; index++) {
      const length = buffer[offset + 27 + index];
      parts.push(buffer.subarray(cursor, cursor + length));
      cursor += length;
      if (length < 255) {
        const packet = Buffer.concat(parts);
        parts = [];
        if (!['OpusHead', 'OpusTags'].includes(packet.toString('ascii', 0, 8))) packets.push(packet.toString('base64'));
      }
    }
    offset = cursor;
  }
  assert.strictEqual(parts.length, 0);
  return packets;
}

function playerSource(filename, exportName) {
  const sources = {};
  const directory = path.join(repoRoot, 'vds_web/src');
  const visit = (name) => {
    if (Object.hasOwn(sources, name)) return;
    const source = fs.readFileSync(path.join(directory, name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    sources[name] = compiled;
    for (const match of compiled.matchAll(/require\(["']\.\/([^"']+)["']\)/g)) visit(match[1]);
  };
  const entry = filename.replace(/\.ts$/, '');
  visit(entry);
  return `(() => {
    const sources = ${JSON.stringify(sources)}, cache = new Map();
    function load(name) {
      if (cache.has(name)) return cache.get(name).exports;
      if (!Object.hasOwn(sources, name)) throw new Error('Unknown player dependency: ' + name);
      const module = { exports: {} }; cache.set(name, module);
      new Function('module', 'exports', 'require', sources[name])(module, module.exports, relative => {
        if (!relative.startsWith('./')) throw new Error('Player dependency must be local: ' + relative);
        return load(relative.slice(2));
      });
      return module.exports;
    }
    window.${exportName} = load(${JSON.stringify(entry)}).${exportName};
  })();`;
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const deadline = setTimeout(() => { console.error('real WebCodecs playback timed out'); app.exit(1); }, 30000);
  let tempDirectory;
  let exitCode = 1;
  try {
    const h264 = encodeFixture(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30', '-frames:v', '1', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '1', '-bf', '0', '-f', 'h264']).toString('base64');
    const audioInput = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.12', '-ac', '2'];
    const fixtures = {
      h264,
      aac: aacPackets(encodeFixture([...audioInput, '-c:a', 'aac', '-f', 'adts'])),
      aac8k: aacPackets(encodeFixture(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=0.384', '-ac', '1', '-c:a', 'aac', '-f', 'adts'])),
      opus: opusPackets(encodeFixture([...audioInput, '-c:a', 'libopus', '-frame_duration', '20', '-f', 'opus']))
    };
    fixtures.aacGap = fixtures.aac;
    await app.whenReady();
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'vds-web-playback' } });
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-web-playback-'));
    const htmlPath = path.join(tempDirectory, 'player.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body><canvas id="video"></canvas></body></html>');
    await window.loadFile(htmlPath);
    const result = await window.webContents.executeJavaScript(`(async () => {
      ${playerSource('webcodecs-player.ts', 'WebCodecsVideoPlayer')}
      ${playerSource('webcodecs-audio-player.ts', 'WebCodecsAudioPlayer')}
      const fixtures = ${JSON.stringify(fixtures)};
      const bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0)).buffer;
      const ensure = (value, message) => { if (!value) throw new Error(message); };
      const waitUntil = async (predicate, message) => {
        const deadline = performance.now() + 5000;
        while (!predicate()) {
          if (performance.now() >= deadline) throw new Error(message);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      const header = (streamType, codec, sequence, payloadFormat) => ({
        protocol: 'vds-media-encoded-v1', type: 'frame', streamType, codec, payloadFormat,
        timestampUs: codec === 'aac' ? Math.round(sequence * 1024 * 1000000 / 48000) : sequence * 20000,
        sequence, keyframe: true, config: true
      });
      ensure(window.isSecureContext && window.VideoDecoder && window.AudioDecoder, 'real WebCodecs APIs unavailable');
      const videoResult = { decoded: 0, drops: [], states: [] };
      const video = new window.WebCodecsVideoPlayer(document.getElementById('video'), {
        onState: value => videoResult.states.push(value), onDecodedFrame: () => videoResult.decoded++,
        onDroppedFrame: value => videoResult.drops.push(value), onPayloadFormat() {}
      });
      video.setExpectedDisplaySize(64, 64);
      await video.pushFrame(header('video', 'h264', 1, 'annexb'), bytes(fixtures.h264));
      ensure(video.decoder?.state === 'configured', 'H264 decoder was not configured');
      await video.decoder.flush();
      await waitUntil(() => videoResult.decoded === 1, 'H264 presentation did not run');
      ensure(videoResult.decoded === 1, 'H264 did not produce a real decoded VideoFrame');
      const pixel = document.getElementById('video').getContext('2d').getImageData(32, 32, 1, 1).data;
      ensure(pixel[0] > 200 && pixel[1] < 50 && pixel[2] < 50, 'decoded H264 canvas pixel is not the synthetic red frame');
      video.close();
      await video.pushFrame(header('video', 'h264', 2, 'annexb'), bytes(fixtures.h264));
      await video.decoder.flush();
      await waitUntil(() => videoResult.decoded === 2, 'H264 reopened presentation did not run');
      ensure(videoResult.decoded === 2, 'H264 close/reopen did not recover');
      video.decoder.close();
      await video.pushFrame(header('video', 'h264', 3, 'annexb'), bytes(fixtures.h264));
      ensure(video.decoder?.state === 'configured', 'H264 closed decoder was not replaced');
      await video.decoder.flush();
      await waitUntil(() => videoResult.decoded === 3, 'H264 decoder replacement presentation did not run');
      ensure(videoResult.decoded === 3, 'H264 closed decoder did not recover');
      video.close();
      ensure(videoResult.drops.length === 0, 'H264 drops: ' + videoResult.drops.join(', '));

      const audioResults = {};
      const codecTimestampTrace = [];
      const RealAudioDecoder = window.AudioDecoder;
      window.AudioDecoder = class extends RealAudioDecoder {
        constructor(config) {
          super({ ...config, output: data => {
            codecTimestampTrace.push({ output: data.timestamp, frames: data.numberOfFrames, sampleRate: data.sampleRate });
            config.output(data);
          } });
        }
        decode(chunk) {
          codecTimestampTrace.push({ input: chunk.timestamp });
          super.decode(chunk);
        }
      };
      for (const fixtureName of ['aac', 'opus', 'aac8k', 'aacGap']) {
        const codec = fixtureName === 'aac8k' || fixtureName === 'aacGap' ? 'aac' : fixtureName;
        const sampleRate = fixtureName === 'aac8k' ? 8000 : 48000;
        const channelCount = fixtureName === 'aac8k' ? 1 : 2;
        const audioHeader = sequence => ({
          ...header('audio', codec, sequence, codec === 'aac' ? 'aac-adts' : 'opus-raw'),
          timestampUs: codec === 'aac' ? Math.round((sequence + (fixtureName === 'aacGap' && sequence >= 4 ? 1 : 0)) * 1024 * 1000000 / sampleRate) : sequence * 20000
        });
        const result = { decoded: 0, drops: [], states: [] };
        const audio = new window.WebCodecsAudioPlayer({
          onState: value => result.states.push(value), onDecodedBlock: () => result.decoded++,
          onDroppedBlock: value => result.drops.push(value)
        });
        audio.setVolume(0);
        audio.setFormat(sampleRate, channelCount);
        await audio.resume(sampleRate);
        // Concurrent startup still tests one decoder configuration. Pace the
        // remaining packets so this codec fixture does not intentionally exceed
        // the new bounded audio presentation buffer.
        for (let offset = 0; offset < fixtures[fixtureName].length; offset += 3) {
          await Promise.all(fixtures[fixtureName].slice(offset, offset + 3).map((packet, index) => audio.pushFrame(
            audioHeader(offset + index + 1), bytes(packet))));
          if (offset + 3 < fixtures[fixtureName].length) await new Promise(resolve => setTimeout(resolve, sampleRate === 8000 ? 384 : 60));
        }
        ensure(audio.decoder?.state === 'configured', codec + ' decoder was not configured');
        await audio.decoder.flush();
        ensure(result.decoded > 0, codec + ' did not produce real AudioData');
        ensure(result.states.length === 1, codec + ' concurrent first frames repeatedly configured the decoder');
        if (fixtureName === 'aacGap') ensure(audio.clockAnchors.some(anchor => Math.abs(anchor.ptsUs - audioHeader(4).timestampUs) <= 2),
          'AAC source timestamp gap was compressed into the codec sample clock');
        const beforeReopen = result.decoded;
        audio.close();
        await audio.resume(sampleRate);
        await audio.pushFrame(audioHeader(20), bytes(fixtures[fixtureName][0]));
        await audio.decoder.flush();
        ensure(result.decoded > beforeReopen, codec + ' close/reopen did not recover');
        const beforeClosedDecoder = result.decoded;
        audio.decoder.close();
        await audio.pushFrame(audioHeader(21), bytes(fixtures[fixtureName][0]));
        ensure(audio.decoder?.state === 'configured', codec + ' closed decoder was not replaced');
        await audio.decoder.flush();
        ensure(result.decoded > beforeClosedDecoder, codec + ' closed decoder did not recover');
        audio.close();
        ensure(result.drops.length === 0, codec + ' drops: ' + result.drops.join(', ') + '; timestamps=' + JSON.stringify(codecTimestampTrace));
        audioResults[fixtureName] = result;
      }
      return { video: videoResult, audio: audioResults, pixel: Array.from(pixel), secureContext: window.isSecureContext };
    })()`);
    console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, ...result }));
    window.destroy();
    clearTimeout(deadline);
    exitCode = 0;
  } catch (error) {
    console.error(error.stack || error);
    clearTimeout(deadline);
  } finally {
    if (tempDirectory) {
      fs.unlinkSync(path.join(tempDirectory, 'player.html'));
      fs.rmdirSync(tempDirectory);
    }
  }
  app.exit(exitCode);
}

if (process.versions.electron) {
  void runElectron();
} else {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env: environment, windowsHide: true, stdio: 'inherit', timeout: 45000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status === 0 ? 0 : 1;
}
