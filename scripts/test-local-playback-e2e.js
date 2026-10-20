// Real local media path: OBS SRT or WGC -> native DataChannel -> web app.
// Run with Node; the launcher creates a hidden Electron process and cleans it up.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const captureSource = process.argv.includes('--wgc') ? 'wgc' : (process.env.VDS_PLAYBACK_E2E_SOURCE || 'obs');
if (!['obs', 'wgc'].includes(captureSource)) throw new Error('VDS_PLAYBACK_E2E_SOURCE must be obs or wgc');
const isWgc = captureSource === 'wgc';
const sharedProducerTest = process.env.VDS_PLAYBACK_E2E_SHARED_PRODUCER === '1';
if (sharedProducerTest && !isWgc) throw new Error('Shared producer smoke requires --wgc');
const nativeMapped = process.argv.includes('--native-tcp-mapped') || process.env.VDS_PLAYBACK_E2E_NATIVE_MAPPED === '1';
const nativeTcp = nativeMapped || process.argv.includes('--native-tcp') || process.env.VDS_PLAYBACK_E2E_NATIVE_TCP === '1';
const reportPath = path.join(root, 'tmp', sharedProducerTest ? 'shared-producer-e2e-result.json' : nativeTcp ? (nativeMapped ? 'web-mapped-tcp-e2e-result.json' : 'web-native-tcp-e2e-result.json') : (isWgc ? 'wgc-playback-e2e-result.json' : 'local-playback-e2e-result.json'));
const runId = process.env.VDS_PLAYBACK_E2E_RUN_ID || `${Date.now()}-${process.pid}`;
function integerOption(name, fallback, minimum, maximum) {
  const raw = process.env[`VDS_PLAYBACK_E2E_${name}`];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`VDS_PLAYBACK_E2E_${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}
const mediaOptions = {
  captureSource,
  nativeTcp,
  nativeMapped,
  width: integerOption('WIDTH', 640, 64, 3840),
  height: integerOption('HEIGHT', 360, 64, 2160),
  frameRate: integerOption('FPS', 15, 5, 60),
  bFrames: integerOption('B_FRAMES', 0, 0, 3),
  sustainedMs: integerOption('SUSTAINED_MS', 10000, 1000, 1800000),
  renderMode: 'offscreen-60fps',
  audioGraphVolumePercent: integerOption('VOLUME', 100, 0, 100),
  traceRendering: process.env.VDS_PLAYBACK_E2E_TRACE === '1'
};
const soakMs = integerOption('SOAK_MS', 0, 0, 7200000);
if (soakMs && !sharedProducerTest) throw new Error('SOAK_MS requires shared producer mode');
const directViewers = soakMs ? 4 : (sharedProducerTest ? 2 : 1);
Object.assign(mediaOptions, { soakMs, directViewers });
if (mediaOptions.width % 2 || mediaOptions.height % 2) throw new Error('YUV420 fixture dimensions must be even');
const runDeadlineMs = mediaOptions.sustainedMs * (isWgc ? 2 : 1) + 90000 + soakMs + (soakMs ? 180000 : 0);
function saveReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ runId, mediaOptions, updatedAt: new Date().toISOString(), ...report }, null, 2));
}

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.VDS_PLAYBACK_E2E_RUN_ID = runId;
  env.VDS_PLAYBACK_E2E_NATIVE_TCP = nativeTcp ? '1' : '0';
  env.VDS_PLAYBACK_E2E_NATIVE_MAPPED = nativeMapped ? '1' : '0';
  saveReport({ ok: false, status: 'starting', stage: 'launch-electron' });
  const child = spawn(require('electron'), [__filename, ...(isWgc ? ['--wgc'] : [])], { env, windowsHide: true, stdio: 'inherit' });
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.pid) {
      const previous = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      saveReport({ ...previous, ok: false, status: 'failed', error: 'electron-launcher-deadline' });
      console.error('[local-playback-e2e] electron-launcher-deadline');
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    }
  }, runDeadlineMs + 10000);
  child.once('error', (error) => {
    clearTimeout(deadline); saveReport({ ok: false, status: 'failed', stage: 'launch-electron', error: error.message });
    console.error(error); process.exitCode = 1;
  });
  child.once('exit', (code) => {
    clearTimeout(deadline);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    process.exitCode = code === 0 && report.runId === runId && report.ok ? 0 : 1;
    if (report.status !== 'completed') {
      saveReport({ ...report, ok: false, status: 'failed', error: report.error || `electron-exited:${code}` });
    }
  });
} else {
  void runElectron().catch((error) => {
    saveReport({ ok: false, status: 'failed', error: error.message });
    console.error(error);
    require('electron').app.exit(1);
  });
}

async function runElectron() {
  const assert = require('node:assert/strict');
  const dgram = require('node:dgram');
  const { once } = require('node:events');
  const { app, BrowserWindow } = require('electron');
  const WebSocket = require('ws');
  const { startServer } = require('../server/server-core');
  const { MediaAgentManager } = require('../desktop/media-agent-manager');
  const logs = [];
  const warnings = [];
  const consoleErrors = [];
  const phases = [];
  const windows = [];
  const hostMessages = [];
  const transportAudit = { droppedUdp: 0, forwardedTcp: 0, droppedSdp: 0, mappedPublished: 0, originalTcpDropped: 0 };
  let mappingRouter, mappingFunctions;
  const mappingJobs = new Set(), mappingStarted = new Set(), mappedEndpoints = new Set();
  const { NatMappingLeases } = require('../desktop/nat-mapping-leases');
  const mappingLeases = new NatMappingLeases({ onError: (error) => fail(error) });
  function filterSdp(sdp) {
    if (!nativeTcp) return sdp;
    return String(sdp).split(/\r?\n/).filter((line) => {
      if (/^a=candidate:/i.test(line) && (nativeMapped || !/\sTCP\s/i.test(line))) { ++transportAudit.droppedSdp; return false; }
      return true;
    }).join('\r\n');
  }
  function allowCandidate(candidate) {
    if (!nativeTcp) return true;
    const text = typeof candidate === 'string' ? candidate : candidate?.candidate || '';
    if (/\sTCP\s/i.test(text)) { ++transportAudit.forwardedTcp; return true; }
    if (/\sUDP\s/i.test(text)) ++transportAudit.droppedUdp;
    return false;
  }
  async function installTransportProbe(target) {
    step('browser-transport-probe');
    await target.loadURL('about:blank');
    target.webContents.debugger.attach('1.3');
    await target.webContents.debugger.sendCommand('Page.enable');
    await target.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__vdsTransportPeers = [];
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); window.__vdsTransportPeers.push(this); }
      };
    ` });
  }
  async function selectedTransports(target) {
    return target.webContents.executeJavaScript(`(async () => {
      const selected = [];
      for (const pc of window.__vdsTransportPeers || []) {
        if (pc.connectionState === 'closed') continue;
        const stats = await pc.getStats();
        for (const transport of stats.values()) {
          if (transport.type !== 'transport' || !transport.selectedCandidatePairId) continue;
          const pair = stats.get(transport.selectedCandidatePairId);
          const local = stats.get(pair?.localCandidateId), remote = stats.get(pair?.remoteCandidateId);
          selected.push({ local: { protocol: local?.protocol, candidateType: local?.candidateType },
            remote: { protocol: remote?.protocol, candidateType: remote?.candidateType, address: remote?.address, port: remote?.port },
            bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived });
        }
      }
      return selected;
    })()`);
  }
  let instance;
  let window;
  let relayWindow;
  let hostSocket;
  let ffmpeg;
  let room;
  let obsState;
  let ffmpegExit;
  let signalOperations = Promise.resolve();
  let stopping = false;
  let fatalError;
  let exitCode = 0;
  let nativeBinarySha256;
  const peers = new Set();
  const transportGenerations = new Map();
  const pendingNativeSignals = new Map();
  const remoteDescriptions = new Set();
  const pendingRemoteCandidates = new Map();
  const agent = new MediaAgentManager({
    logger: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' '))
    },
    defaultInvokeTimeoutMs: 10000
  });
  const { HostVideoRefreshWakeup } = require('../desktop/host-video-refresh-wakeup');
  const refreshWakeup = new HostVideoRefreshWakeup({ isRunning: () => agent.getStatus().running,
    invokeStats: () => agent.invoke('getStats'), onError: error => logs.push('[refresh] ' + error.message) });
  const producerEvidence = [];
  let soakEvidence;
  let stopStimulus;
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.setPath('userData', path.join(root, 'tmp', 'local-playback-e2e-profile-' + process.pid));
  app.on('window-all-closed', () => {});
  let stage = 'electron-ready';
  const progress = [];
  const checkpoint = () => saveReport({ ok: false, status: fatalError ? 'failed' : 'running', stage, nativeBinarySha256,
    error: fatalError?.message || null, progress, phases, warnings, consoleErrors, logs: logs.slice(-40) });
  const step = (label) => {
    stage = label; progress.push({ stage, at: new Date().toISOString() });
    console.log('[local-playback-e2e] ' + label); checkpoint();
  };
  const deadline = setTimeout(() => {
    fatalError = new Error('local-playback-e2e-deadline');
    checkpoint();
    console.error('[local-playback-e2e] ' + fatalError.message + ' at ' + stage);
    for (const ownedWindow of windows) if (!ownedWindow.isDestroyed()) ownedWindow.destroy();
  }, runDeadlineMs);
  const cleanupDeadline = setTimeout(() => {
    fatalError ||= new Error('local-playback-e2e-cleanup-deadline');
    checkpoint();
    if (ffmpeg?.exitCode === null) ffmpeg.kill();
    if (agent.child?.exitCode === null) agent.child.kill();
    app.exit(1);
  }, runDeadlineMs + 7000);

  const manifest = {
    protocol: 'vds-media-encoded-v1', protocolVersion: 1,
    mediaSessionId: 'local-playback-e2e', manifestVersion: 1,
    sourceType: isWgc ? 'native-capture' : 'obs-ingest',
    video: { codec: 'h264', payloadFormat: 'annexb', width: mediaOptions.width, height: mediaOptions.height, frameRate: mediaOptions.frameRate },
    audio: { codec: 'aac', payloadFormat: 'aac-adts', sampleRate: 48000, channels: 2 }
  };
  const hostId = 'local-playback-e2e-host';

  const fail = (error) => {
    if (!stopping && !fatalError) {
      fatalError = error; console.error('[local-playback-e2e] ' + error.message + ' at ' + stage); checkpoint();
    }
  };
  const enqueue = (operation) => {
    signalOperations = signalOperations.then(operation).catch(fail);
  };
  const addRemoteCandidate = (peerId, candidate) => !allowCandidate(candidate) ? Promise.resolve() : agent.invoke('addRemoteIceCandidate', {
    peerId, candidate: candidate.candidate, sdpMid: candidate.sdpMid || '0',
    ...(transportGenerations.get(peerId) ? { transportGeneration: transportGenerations.get(peerId) } : {})
  });
  const sendHost = (payload) => {
    if (hostSocket?.readyState === WebSocket.OPEN && room) {
      hostSocket.send(JSON.stringify({ roomId: room.roomId, ...payload }));
    }
  };
  const sendNativeSignal = (params) => {
    const peerId = params.peerId || params.targetId || params.remotePeerId;
    if (params.transportGeneration && pendingNativeSignals.has(peerId)) {
      const pending = pendingNativeSignals.get(peerId);
      pending.push(params);
      if (pending.length > 128) pending.shift();
      return;
    }
    if (params.transportGeneration && params.transportGeneration !== transportGenerations.get(peerId)) return;
    if ((params.type === 'candidate' || params.type === 'ice-candidate') && !allowCandidate(params.candidate)) return;
    if (nativeMapped && (params.type === 'candidate' || params.type === 'ice-candidate')) {
      ++transportAudit.originalTcpDropped;
      const text = typeof params.candidate === 'string' ? params.candidate : params.candidate?.candidate || '';
      const fields = text.trim().split(/\s+/);
      if (!/\btcptype\s+passive\b/i.test(text) || require('node:net').isIP(fields[4]) !== 4 || mappingStarted.has(peerId)) return;
      mappingStarted.add(peerId);
      const generation = transportGenerations.get(peerId);
      const job = mappingFunctions.openP2PNatMappings({ peerId, transportGeneration: generation,
        candidates: [{ candidate: text, sdpMid: params.candidate?.sdpMid || '0' }] }).then((result) => {
        if (generation !== transportGenerations.get(peerId) || stopping) return;
        assert.equal(result.ok, true, 'TCP mapping failed: ' + JSON.stringify(result));
        assert.equal(result.protocol, 'pcp'); assert.equal(result.candidates.length, 1);
        const candidate = result.candidates[0]; const mappedFields = candidate.candidate.split(/\s+/);
        mappedEndpoints.add(mappedFields[4] + ':' + mappedFields[5]);
        ++transportAudit.mappedPublished;
        sendHost({ ...params, type: 'ice-candidate', candidate, mediaManifest: manifest });
      }).catch(fail);
      mappingJobs.add(job); job.finally(() => mappingJobs.delete(job));
      return;
    }
    const filtered = { ...params };
    if (filtered.sdp) filtered.sdp = typeof filtered.sdp === 'string' ? filterSdp(filtered.sdp) : { ...filtered.sdp, sdp: filterSdp(filtered.sdp.sdp) };
    sendHost({ ...filtered, type: params.type === 'candidate' ? 'ice-candidate' : params.type, mediaManifest: manifest });
  };
  agent.on('event', ({ event, params }) => {
    refreshWakeup.handleEvent({ event, params });
    if (event === 'host-video-producer-failed') producerEvidence.push({ event, params, at: Date.now() });
    if (nativeMapped) mappingLeases.handleEvent({ event, params });
    if (event === 'media-state' && params.obsIngest) obsState = params.obsIngest;
    if (event === 'warning') warnings.push(params);
    if (event === 'signal') {
      sendNativeSignal(params);
    }
  });

  async function poll(label, predicate, timeoutMs = 16000) {
    step(label);
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      if (fatalError) throw fatalError;
      last = await predicate();
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(label + ':timeout');
  }
  async function snapshot(targetWindow = window) {
    return targetWindow.webContents.executeJavaScript(`(() => {
      if (${mediaOptions.traceRendering} && !window.__vdsTestRaf) {
        window.__vdsTestRaf = { count: 0, lastMs: 0 };
        const tick = (now) => { window.__vdsTestRaf.count++; window.__vdsTestRaf.lastMs = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }
      const raw = document.getElementById('diagnosticsOutput').value;
      const canvas = document.getElementById('dataChannelCanvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, Math.min(32, canvas.width), Math.min(32, canvas.height)).data;
      return { diagnostics: raw ? JSON.parse(raw) : null,
        renderTrace: ${mediaOptions.traceRendering} ? { visibility: document.visibilityState, nowMs: performance.now(), ...window.__vdsTestRaf,
          codec: window.__vdsCodecTrace || [] } : null,
        canvasWidth: canvas.width, canvasHeight: canvas.height,
        canvasHasColor: pixels.some((value, index) => index % 4 !== 3 && value > 32),
        error: document.getElementById('errorText').textContent,
        joinDisabled: document.getElementById('joinButton').disabled,
        status: document.getElementById('statusText').textContent };
    })()`);
  }
  async function installCodecTrace(targetWindow) {
    if (!mediaOptions.traceRendering) return;
    await targetWindow.webContents.executeJavaScript(`(() => {
      window.__vdsCodecTrace = [];
      const record = (kind, ptsUs, frames, details = {}) => {
        window.__vdsCodecTrace.push({ kind, ptsUs, frames, nowMs: performance.now(), ...details });
        if (window.__vdsCodecTrace.length > 4096) window.__vdsCodecTrace.shift();
      };
      let decoderId = 0;
      for (const [name, kind] of [['VideoDecoder', 'video'], ['AudioDecoder', 'audio']]) {
        const NativeDecoder = window[name];
        if (NativeDecoder) window[name] = class extends NativeDecoder {
          constructor(config) {
            const id = ++decoderId;
            super({ ...config, output: data => { record(kind + '-output', data.timestamp, data.numberOfFrames, { decoderId: id }); config.output(data); } });
            this.traceId = id;
          }
          decode(chunk) { record(kind + '-input', chunk.timestamp, undefined, { decoderId: this.traceId }); super.decode(chunk); }
        };
      }
      const NativeContext = window.AudioContext;
      if (NativeContext) window.AudioContext = class extends NativeContext {
        createBufferSource() {
          const source = super.createBufferSource();
          const originalStart = source.start.bind(source);
          source.start = (when = 0, offset, duration) => {
            record('audio-start', undefined, undefined, { contextTime: this.currentTime, when, offset,
              duration: duration ?? source.buffer?.duration });
            if (duration !== undefined) originalStart(when, offset ?? 0, duration);
            else if (offset !== undefined) originalStart(when, offset);
            else originalStart(when);
          };
          return source;
        }
      };
      const observeChannel = channel => channel.addEventListener('message', event => {
        const data = event.data;
        if (!(data instanceof ArrayBuffer) || data.byteLength < 8) return;
        try {
          const length = new DataView(data).getUint32(4, false);
          const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 8, length)));
          if (header.streamType === 'audio') record('audio-arrival', header.timestampUs, undefined,
            { sequence: header.sequence, sourceEpoch: header.sourceEpoch });
        } catch { /* Test tracing must not alter protocol handling. */ }
      });
      const NativePeer = window.RTCPeerConnection;
      if (NativePeer) window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); this.addEventListener('datachannel', event => observeChannel(event.channel)); }
        createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel); return channel; }
      };
    })()`);
  }
  async function join() {
    await poll('web-capability', async () => !(await snapshot()).joinDisabled);
    await window.webContents.executeJavaScript(`(() => {
      const volume = document.getElementById('playerVolumeInput');
      // Keep the real Web Audio graph active; the owning webContents is muted.
      // Zero graph gain switches Chromium to a fake sink after 30s of silence,
      // which changes its device pacing and does not model audible playback.
      volume.value = '${mediaOptions.audioGraphVolumePercent}';
      volume.dispatchEvent(new Event('input'));
      document.getElementById('roomIdInput').value = ${JSON.stringify(room.roomId)};
      document.getElementById('joinButton').click();
    })()`);
  }
  async function waitForFrames(label, baseline = { webDecodedVideoFrames: 0, webDecodedAudioBlocks: 0 }, previousSourceEpoch = null) {
    let latest;
    let recoveryEpoch = null;
    let recoveryBaseline = baseline;
    try {
      latest = await poll(label, async () => {
        const current = await snapshot();
        const d = current.diagnostics;
        const epoch = d?.webPlaybackMetrics?.sourceEpoch;
        if (previousSourceEpoch !== null && epoch && epoch !== previousSourceEpoch && epoch !== recoveryEpoch) {
          recoveryEpoch = epoch;
          recoveryBaseline = d;
        }
        // OBS reconnect retains the host's common clock offset. Verify progress
        // after observing the new epoch, independently of its absolute PTS.
        const recoveredSource = previousSourceEpoch === null || (epoch === recoveryEpoch &&
          Number.isFinite(d?.webPlaybackMetrics?.video?.lastDecodedPtsUs));
        if (d && recoveredSource && d.playbackState === 'playing' &&
          /^webcodecs-configured-/.test(d.videoDecoderState) && (isWgc || /^webcodecs-audio-configured-/.test(d.audioDecoderState)) &&
          d.webDecodedVideoFrames >= recoveryBaseline.webDecodedVideoFrames + 12 &&
          (isWgc || d.webDecodedAudioBlocks >= recoveryBaseline.webDecodedAudioBlocks + 12)) return current;
        return false;
      });
    } catch (error) {
      const current = await snapshot().catch(() => null);
      const upstream = relayWindow && !relayWindow.isDestroyed() ? await snapshot(relayWindow).catch(() => null) : null;
      phases.push({ label, failed: true, ...current, upstream });
      throw error;
    }
    latest.selectedTransports = await selectedTransports(window);
    assert.ok(latest.selectedTransports.length, label + ':missing selected candidate pair');
    for (const pair of latest.selectedTransports) {
      assert.notEqual(pair.local.candidateType, 'relay'); assert.notEqual(pair.remote.candidateType, 'relay');
      if (nativeTcp && latest.diagnostics.upstreamPeerId === hostId) {
        assert.equal(pair.local.protocol, 'tcp', label + ':native leg rescued by UDP');
        assert.equal(pair.remote.protocol, 'tcp', label + ':remote native leg rescued by UDP');
        if (nativeMapped) {
          assert.equal(pair.remote.candidateType, 'srflx', label + ':unmapped host candidate rescued test');
          assert.ok(mappedEndpoints.has(pair.remote.address + ':' + pair.remote.port), label + ':selected endpoint was not mapped');
        }
      }
    }
    phases.push({ label, ...latest });
    if (!isWgc) assert.equal(latest.canvasHasColor, true, label + ':decoded canvas stays blank');
    assert.equal(latest.diagnostics.playbackState, 'playing', label + ':playback state did not reach rendered video');
    assert.match(latest.diagnostics.videoDecoderState, /^webcodecs-configured-/, label + ':video decoder not configured');
    if (!isWgc) assert.match(latest.diagnostics.audioDecoderState, /^webcodecs-audio-configured-/, label + ':audio decoder not configured');
    assert.doesNotMatch(latest.diagnostics.relayProtocolState, /^webcodecs/, label + ':decoder state overwrote connection/relay state');
    return latest.diagnostics;
  }
  async function observeSustainedPlayback(baseline, label = 'sustained-playback') {
    step(label);
    const startedAt = Date.now();
    let previous = baseline;
    let latest;
    let videoAdvancedAt = startedAt;
    let audioAdvancedAt = startedAt;
    const samples = [];
    let sampledAt = 0;
    while (Date.now() - startedAt < mediaOptions.sustainedMs) {
      if (fatalError) throw fatalError;
      latest = await snapshot();
      const current = latest.diagnostics;
      if (current.webDecodedVideoFrames > previous.webDecodedVideoFrames) videoAdvancedAt = Date.now();
      if (current.webDecodedAudioBlocks > previous.webDecodedAudioBlocks) audioAdvancedAt = Date.now();
      assert.ok(Date.now() - videoAdvancedAt < 3000, 'sustained video stalled for three seconds');
      if (!isWgc) assert.ok(Date.now() - audioAdvancedAt < 3000, 'sustained audio stalled for three seconds');
      if (Date.now() - sampledAt >= 1000) {
        sampledAt = Date.now();
        samples.push({ elapsedMs: sampledAt - startedAt, video: current.webDecodedVideoFrames,
          audio: current.webDecodedAudioBlocks, playbackMetrics: current.webPlaybackMetrics,
          electronProcesses: app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
            pid, type, cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize
          })) });
      }
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const videoIncrement = latest.diagnostics.webDecodedVideoFrames - baseline.webDecodedVideoFrames;
    const audioIncrement = latest.diagnostics.webDecodedAudioBlocks - baseline.webDecodedAudioBlocks;
    const durationMs = Date.now() - startedAt;
    phases.push({ label, durationMs, videoIncrement, audioIncrement,
      presentedVideoRate: videoIncrement * 1000 / durationMs, samples, ...latest });
    assert.ok(videoIncrement >= Math.floor(mediaOptions.frameRate * durationMs / 1000 * 0.85), 'sustained playback video rate fell below 85% of source rate');
    // The fixture emits 48 kHz AAC with 1024 samples per access unit. Merely
    // checking that audio advances would miss losing half a normal PES burst.
    if (!isWgc) assert.ok(audioIncrement >= Math.floor(48000 / 1024 * durationMs / 1000 * 0.9), 'sustained playback audio rate fell below 90% of the AAC source rate');
    if (!isWgc && mediaOptions.traceRendering) {
      const starts = latest.renderTrace.codec.filter(event => event.kind === 'audio-start');
      const gaps = starts.slice(1).map((event, index) => {
        const previous = starts[index];
        return Math.max(0, (event.when - (previous.when + previous.duration - (previous.offset || 0))) * 1000);
      }).filter(gap => gap > 0.1);
      phases.at(-1).audioContinuity = { inspectedBlocks: starts.length, gapCount: gaps.length,
        totalGapMs: gaps.reduce((sum, gap) => sum + gap, 0), maxGapMs: Math.max(0, ...gaps) };
      assert.ok(starts.length >= Math.min(100, Math.floor(durationMs / 1000 * 48000 / 1024 * 0.8)),
        'audio continuity requires actual scheduled WebAudio blocks');
      assert.ok(Math.max(0, ...gaps) < 10, 'stable local audio inserted a perceptible scheduling gap');
    }
    return latest.diagnostics;
  }
  async function freeUdpPort() {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return port;
  }

  try {
    step('electron-ready');
    await app.whenReady();
    if (soakMs) stopStimulus = require('../tests/fixtures/capture-stimulus').startCaptureStimulus();
    if (nativeMapped) {
      step('mapping-router-start');
      mappingRouter = await require('../tests/fixtures/tcp-mapping-router').tcpMappingRouter('pcp', { controlAddress: '0.0.0.0' });
      const { buildPcpMapRequest, parsePcpMapResponse } = require('../desktop/pcp-packet');
      mappingFunctions = require('../tests/fixtures/nat-main-functions').loadMappingFunctions({
        dgram, crypto: require('node:crypto'), buildPcpMapRequest, parsePcpMapResponse,
        natMappingLeases: mappingLeases, upnpPortMapper: mappingRouter.mapper,
        resolveDefaultGatewayIpv4: async (localAddress) => localAddress,
        sendToRenderer: () => fail(new Error('unchanged mapped endpoint unexpectedly changed')),
        gatewayRequest: (request, address, _port, ...args) => request(address, mappingRouter.controlPort, ...args)
      });
    }
    step('server-listening');
    instance = startServer({ port: 0, disconnectGraceMs: 2000, maxDownstreamsPerUpstream: directViewers,
      ...(nativeTcp ? { iceServers: [] } : {}), publicDir: path.join(root, 'server/public') });
    await once(instance.server, 'listening');
    const port = instance.server.address().port;
    step('native-agent-start');
    await agent.start();
    nativeBinarySha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(agent.getStatus().binaryPath)).digest('hex').toUpperCase();
    assert.equal((await agent.invoke('getCapabilities')).transportReady, true);
    let startFixture;
    step('native-host-start');
    if (isWgc) {
      await agent.invoke('startHostSession', { mediaSessionId: manifest.mediaSessionId,
        backend: 'native', captureKind: 'display', captureTargetId: 'screen:0:0', displayId: '0',
        requestedCodec: 'h264', width: mediaOptions.width, height: mediaOptions.height,
        frameRate: mediaOptions.frameRate, bitrateKbps: 10000 });
    } else {
      const srtPort = await freeUdpPort();
      await agent.invoke('startHostSession', { mediaSessionId: manifest.mediaSessionId,
        backend: 'obs-ingest', port: srtPort, codec: 'h264', width: mediaOptions.width,
        height: mediaOptions.height, frameRate: mediaOptions.frameRate });
      const ffmpegPath = process.env.VDS_FFMPEG_PATH || 'D:/project/publicresource/ffmpeg-master-latest-win64-gpl-shared/bin/ffmpeg.exe';
      assert.ok(fs.existsSync(ffmpegPath), 'Set VDS_FFMPEG_PATH to an FFmpeg binary with libx264 and SRT support');
      startFixture = () => {
        ffmpegExit = null;
        ffmpeg = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'warning', '-nostdin',
        '-re', '-f', 'lavfi', '-i', `testsrc2=size=${mediaOptions.width}x${mediaOptions.height}:rate=${mediaOptions.frameRate}`,
        '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(Math.ceil(runDeadlineMs / 1000) + 5), '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p', '-profile:v', mediaOptions.bFrames ? 'main' : 'baseline',
        '-g', String(mediaOptions.frameRate), '-bf', String(mediaOptions.bFrames),
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '96k',
        '-f', 'mpegts', `srt://127.0.0.1:${srtPort}?mode=caller&transtype=live&latency=120000`],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      ffmpeg.stderr.on('data', (data) => logs.push('[ffmpeg] ' + String(data).trim()));
      ffmpeg.on('error', fail);
      ffmpeg.on('exit', (code, signal) => { ffmpegExit = { code, signal }; });
      };
      startFixture();
      await poll('obs-stream-running', () => obsState?.streamRunning);
    }
    hostSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    hostSocket.on('error', fail);
    await once(hostSocket, 'open');
    const created = once(hostSocket, 'message');
    hostSocket.send(JSON.stringify({ type: 'create-room', clientId: hostId, mediaManifest: manifest,
      mediaCapabilities: { maxDirectDownstreams: directViewers } }));
    room = JSON.parse(String((await created)[0]));
    assert.equal(room.type, 'room-created');
    hostSocket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      hostMessages.push({ type: message.type, viewerId: message.viewerId, fromClientId: message.fromClientId });
      if (message.type === 'viewer-joined') enqueue(async () => {
        remoteDescriptions.delete(message.viewerId);
        pendingRemoteCandidates.delete(message.viewerId);
        if (peers.has(message.viewerId)) await agent.invoke('closePeer', { peerId: message.viewerId,
          ...(transportGenerations.get(message.viewerId) ? { transportGeneration: transportGenerations.get(message.viewerId) } : {}) });
        peers.add(message.viewerId);
        mappingStarted.delete(message.viewerId);
        const leaseOwner = nativeMapped ? mappingLeases.beginCreate({ peerId: message.viewerId }) : null;
        transportGenerations.delete(message.viewerId);
        pendingNativeSignals.set(message.viewerId, []);
        const wakeupTicket = refreshWakeup.beginCreate({ peerId: message.viewerId, role: 'host-downstream' });
        const peer = await agent.invoke('createPeer', { peerId: message.viewerId,
          role: 'host-downstream', initiator: true, encodedMediaDataChannel: true, mediaManifest: manifest });
        assert.equal(peer.transportReady, true);
        const generation = peer.transportGeneration || peer.peerTransport?.transportGeneration || peer.peer?.peerTransport?.transportGeneration;
        assert.ok(generation, 'native createPeer omitted transport identity');
        transportGenerations.set(message.viewerId, generation);
        refreshWakeup.completeCreate(wakeupTicket, { peerId: message.viewerId, transportGeneration: generation });
        if (nativeMapped) assert.equal(mappingLeases.completeCreate(leaseOwner, { peerId: message.viewerId, transportGeneration: generation }), true);
        const pending = pendingNativeSignals.get(message.viewerId) || [];
        pendingNativeSignals.delete(message.viewerId);
        for (const signal of pending) sendNativeSignal(signal);
      });
      if (sharedProducerTest && message.type === 'viewer-left') enqueue(async () => {
        const peerId = message.viewerId;
        if (!peers.has(peerId)) return;
        refreshWakeup.closePeer({ peerId });
        await agent.invoke('closePeer', { peerId, transportGeneration: transportGenerations.get(peerId) });
        peers.delete(peerId);
      });
      if (message.type === 'answer') enqueue(async () => {
        const peerId = message.fromClientId;
        await agent.invoke('setRemoteDescription', {
          peerId, type: message.sdp.type, sdp: filterSdp(message.sdp.sdp), mediaManifest: manifest,
          transportGeneration: transportGenerations.get(peerId)
        });
        remoteDescriptions.add(peerId);
        for (const candidate of pendingRemoteCandidates.get(peerId) || []) await addRemoteCandidate(peerId, candidate);
        pendingRemoteCandidates.delete(peerId);
      });
      if (message.type === 'ice-candidate') enqueue(async () => {
        const peerId = message.fromClientId;
        // Browser ICE callbacks can precede the answer. Mirror the desktop controller's queue.
        if (!remoteDescriptions.has(peerId)) {
          const pending = pendingRemoteCandidates.get(peerId) || [];
          pending.push(message.candidate);
          pendingRemoteCandidates.set(peerId, pending);
          return;
        }
        await addRemoteCandidate(peerId, message.candidate);
      });
      if (message.type === 'error') fail(new Error('host-signaling:' + JSON.stringify(message)));
    });
    window = new BrowserWindow({ show: false, width: 960, height: 640,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
    window.webContents.setFrameRate(60);
    window.webContents.setAudioMuted(true);
    windows.push(window);
    await installTransportProbe(window);
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') consoleErrors.push(details.message);
      if (mediaOptions.traceRendering && !details.message.includes('[diagnostics]')) {
        logs.push('[web] ' + details.message);
      }
    });
    window.webContents.on('render-process-gone', (_event, details) => fail(new Error('renderer-gone:' + details.reason)));
    step('web-load');
    await window.loadURL(`http://127.0.0.1:${port}/vds_web/`);
    await installCodecTrace(window);
    await join();
    const initial = await waitForFrames('initial-playback');
    const sustained = await observeSustainedPlayback(initial);
    if (sharedProducerTest) {
      await agent.invoke('attachSurface', { surface: 'producer-preview', target: 'host-capture-preview', visible: false });
      await poll('preview-reuses-producer', async () => {
        const stats = await agent.invoke('getStats');
        const surface = stats.surfaces.find(s => s.surface === 'producer-preview');
        return surface?.implementation === 'shared-wgc-live-preview' && surface.decodedFramesRendered > 0;
      });
    }
    // Exercise room and browser relay recovery with both real source paths.
    {
      await window.webContents.executeJavaScript("document.getElementById('leaveButton').click()");
      await poll('room-leave', () => instance.rooms.get(room.roomId).viewers.length === 0);
      await poll('playback-stopped', async () => (await snapshot()).diagnostics.playbackState === 'stopped', 3000);
      await join();
      await waitForFrames('leave-rejoin-playback', sustained);
      await window.webContents.reload();
      await once(window.webContents, 'did-finish-load');
      await installCodecTrace(window);
      await waitForFrames('reload-resume-playback');
      assert.equal(window.isVisible(), false);
      relayWindow = window;
      const relaySnapshot = await snapshot();
      window = new BrowserWindow({ show: false, width: 960, height: 640,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
          backgroundThrottling: false, offscreen: true, partition: 'local-playback-e2e-downstream-' + process.pid } });
      window.webContents.setFrameRate(60);
      window.webContents.setAudioMuted(true);
      windows.push(window);
      await installTransportProbe(window);
      window.webContents.on('console-message', (details) => {
        if (details.level === 'error') consoleErrors.push(details.message);
        if (mediaOptions.traceRendering && !details.message.includes('[diagnostics]')) {
          logs.push('[web-downstream] ' + details.message);
        }
      });
      window.webContents.on('render-process-gone', (_event, details) => fail(new Error('renderer-gone:' + details.reason)));
      step('web-load');
      await window.loadURL(`http://127.0.0.1:${port}/vds_web/`);
      await installCodecTrace(window);
      if (sharedProducerTest) {
        // This fixture explicitly exercises two native subscribers, not the
        // server's preferred browser relay topology.
        for (const viewer of instance.rooms.get(room.roomId).viewers)
          viewer.mediaCapabilities.maxDirectDownstreams = 0;
      }
      await join();
      const downstream = await waitForFrames('browser-relay-playback');
      if (sharedProducerTest) {
        assert.equal(downstream.upstreamPeerId, hostId);
        let before = await agent.invoke('getStats');
        let bindings = before.peers.filter(p => p.mediaBinding.producerId).map(p => p.mediaBinding);
        assert.equal(bindings.length, 2);
        assert.equal(bindings[0].producerId, bindings[1].producerId, 'same source/config started separate encoders');
        assert.equal(bindings[0].producerSubscribers, 2);
        assert.ok(bindings.every(b => b.active), 'open DataChannel must report active without RTP');
        producerEvidence.push({ stage: 'two-subscribers', stats: before });
        if (soakMs) {
          soakEvidence = await require('../tests/fixtures/shared-producer-soak').runSharedProducerSoak({
            durationMs: soakMs, viewers: [relayWindow, window], windows, BrowserWindow, app,
            onEvidence: evidence => { soakEvidence = evidence; },
            agent, instance, room, port, hostId, snapshot, selectedTransports, installTransportProbe,
            transportGenerations, checkFatal: () => { if (fatalError) throw fatalError; },
            onFailure: fail, step, frameRate: mediaOptions.frameRate,
            reportPath: path.join(root, 'tmp', `shared-producer-soak-${runId}.json`)
          });
          before = await agent.invoke('getStats');
          bindings = before.peers.filter(p => p.mediaBinding.producerId).map(p => p.mediaBinding);
        }
        const generations = new Map(transportGenerations);
        const beforeFirst = await snapshot(relayWindow);
        const beforeSecond = await snapshot(window);
        const killedPid = bindings[0].producerProcessId;
        assert.ok(Number.isSafeInteger(killedPid) && killedPid > 0);
        step('terminate-owned-encoder');
        process.kill(killedPid);
        // No stats polling here: only the production event wakeup can recover it.
        const recovered = await waitForFrames('encoder-death-recovery', beforeSecond.diagnostics);
        await poll('first-viewer-also-recovers', async () =>
          (await snapshot(relayWindow)).diagnostics.webDecodedVideoFrames > beforeFirst.diagnostics.webDecodedVideoFrames + 10);
        const after = await agent.invoke('getStats');
        const nextBindings = after.peers.filter(p => p.mediaBinding.producerId).map(p => p.mediaBinding);
        assert.notEqual(nextBindings[0].producerProcessId, killedPid);
        assert.equal(nextBindings[0].producerId, nextBindings[1].producerId);
        assert.deepEqual(transportGenerations, generations, 'encoder recovery must retain P2P connections');
        assert.equal(recovered.webPlaybackMetrics.sourceEpoch, beforeSecond.diagnostics.webPlaybackMetrics.sourceEpoch);
        producerEvidence.push({ stage: 'recovered', stats: after });
        await observeSustainedPlayback(recovered, 'shared-recovered-sustained');
        relayWindow.destroy();
        await poll('one-subscriber-remains', async () => {
          const stats = await agent.invoke('getStats');
          const active = stats.peers.filter(p => p.mediaBinding.producerId);
          if (active.length !== 1 || active[0].mediaBinding.producerSubscribers !== 1) return false;
          assert.equal(active[0].mediaBinding.producerId, nextBindings[0].producerId);
          producerEvidence.push({ stage: 'one-subscriber', stats }); return true;
        });
        const single = (await snapshot()).diagnostics;
        await waitForFrames('remaining-viewer-continues', single);
        // Preview detach/reattach must not stop or replace the shared encoder.
        await agent.invoke('detachSurface', { surface: 'producer-preview' });
        await agent.invoke('attachSurface', { surface: 'producer-preview', target: 'host-capture-preview', visible: false });
        assert.equal((await agent.invoke('getStats')).peers.find(p => p.mediaBinding.producerId).mediaBinding.producerId, nextBindings[0].producerId);
        const beforeLastLeave = (await snapshot()).diagnostics;
        await window.webContents.executeJavaScript("document.getElementById('leaveButton').click()");
        await poll('last-subscriber-releases-encoder', async () => (await agent.invoke('getStats')).peers.every(p => !p.mediaBinding.producerId));
        await poll('preview-independent-fallback', async () => {
          const stats = await agent.invoke('getStats');
          const surface = stats.surfaces.find(s => s.surface === 'producer-preview');
          if (surface?.implementation !== 'wgc-live-preview' || !surface.running) return false;
          producerEvidence.push({ stage: 'preview-fallback', stats }); return true;
        });
        await join();
        await waitForFrames('shared-last-leave-rejoin', beforeLastLeave);
        await poll('preview-reuses-new-producer', async () => (await agent.invoke('getStats')).surfaces.some(s => s.implementation === 'shared-wgc-live-preview'));
        return;
      }
      assert.equal(downstream.upstreamPeerId, relaySnapshot.diagnostics.clientId, 'second viewer bypassed browser relay');
      assert.equal(downstream.reencodePathUsed, false);
      await window.webContents.reload();
      await once(window.webContents, 'did-finish-load');
      await installCodecTrace(window);
      const refreshedDownstream = await waitForFrames('relay-page-refresh-playback');
      assert.equal(refreshedDownstream.upstreamPeerId, relaySnapshot.diagnostics.clientId,
        'refresh should resume through the same live upstream');
      // Restart the source on the same native and browser relay connections. The
      // source input restarts while host PTS retains its common clock offset;
      // a fresh epoch must separate old output.
      for (let restart = 1; !isWgc && restart <= 2; restart += 1) {
        const before = await snapshot();
        const beforeEpoch = before.diagnostics.webPlaybackMetrics.sourceEpoch;
        assert.ok(beforeEpoch, 'current sender omitted source epoch');
        const peerGenerations = new Map(transportGenerations);
        if (mediaOptions.traceRendering) {
          await Promise.all([window, relayWindow].map(target => target.webContents.executeJavaScript('window.__vdsCodecTrace = []')));
        }
        step('obs-source-restart-' + restart);
        const exited = once(ffmpeg, 'exit');
        ffmpeg.kill();
        await exited;
        await poll('obs-source-disconnected-' + restart, () => obsState && !obsState.streamRunning);
        startFixture();
        await poll('obs-source-reconnected-' + restart, () => obsState?.streamRunning);
        const resumed = await waitForFrames('same-peer-source-recovery-' + restart, before.diagnostics, beforeEpoch);
        assert.equal(resumed.upstreamPeerId, before.diagnostics.upstreamPeerId, 'source restart rebuilt the downstream peer');
        assert.notEqual(resumed.webPlaybackMetrics.sourceEpoch, beforeEpoch, 'source restart reused its retired output epoch');
        assert.deepEqual(transportGenerations, peerGenerations, 'source restart rebuilt native transport');
        assert.ok(resumed.webPlaybackMetrics.retiredSourceEpochs >= restart, 'old source epoch was not retired');
      }
      relayWindow.destroy();
      const reassigned = await poll('relay-upstream-reassigned', async () => {
        const current = await snapshot();
        return current.diagnostics?.upstreamPeerId === hostId && current;
      });
      const recovered = await waitForFrames('relay-disconnect-recovery', reassigned.diagnostics);
      assert.equal(recovered.upstreamPeerId, hostId, 'downstream did not recover on native host');
      if (isWgc) await observeSustainedPlayback(recovered, 'recovered-sustained-playback');
      assert.equal(window.isVisible(), false);
    }
  } catch (error) {
    exitCode = 1;
    fatalError = error;
    console.error('[local-playback-e2e] ' + error.message + ' at ' + stage);
    checkpoint();
  } finally {
    stopping = true;
    refreshWakeup.dispose();
    clearTimeout(deadline);
    step('cleanup');
    const nativeStats = agent.getStatus().running
      ? await agent.invoke('getStats', {}, { timeoutMs: 2000 }).catch((error) => ({ error: error.message }))
      : { status: agent.getStatus() };
    if (soakEvidence) {
      soakEvidence.nativeProcessId = agent.child?.pid;
      for (const peer of nativeStats.peers || []) {
        const pid = peer.mediaBinding?.producerProcessId;
        if (pid > 0) soakEvidence.encoders.push(pid);
      }
    }
    for (const ownedWindow of windows) if (!ownedWindow.isDestroyed()) ownedWindow.destroy();
    if (hostSocket) hostSocket.terminate();
    for (const peerId of peers) if (agent.getStatus().running) await agent.invoke('closePeer', {
      peerId, ...(transportGenerations.get(peerId) ? { transportGeneration: transportGenerations.get(peerId) } : {})
    }, { timeoutMs: 2000 }).catch(() => {});
    if (agent.getStatus().running) await agent.invoke('stopHostSession', {
      mediaSessionId: manifest.mediaSessionId
    }, { timeoutMs: 2000 }).catch(() => {});
    if (ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
      const exited = once(ffmpeg, 'exit');
      ffmpeg.kill();
      await exited;
    }
    await agent.stop();
    if (stopStimulus) stopStimulus();
    if (soakEvidence) {
      try { soakEvidence.cleanup = require('../tests/fixtures/shared-producer-soak').verifySoakStopped(soakEvidence); }
      catch (error) { fatalError ||= error; exitCode = 1; }
    }
    await Promise.all([...mappingJobs]);
    await mappingLeases.dispose();
    const mappingSummary = mappingRouter ? { protocol: 'pcp', bytes: mappingRouter.bytes,
      leasesRemaining: mappingRouter.entries.size, requests: mappingRouter.calls, errors: mappingRouter.errors.map(e => e.message) } : null;
    if (mappingRouter) {
      if (mappingSummary.leasesRemaining || mappingSummary.errors.length || mappingSummary.bytes < 65536) {
        fatalError ||= new Error('mapped route/cleanup verification failed'); exitCode = 1;
      }
      await mappingRouter.stop();
    }
    if (instance) {
      for (const client of instance.wss.clients) client.terminate();
      await new Promise((resolve) => instance.wss.close(resolve));
      await new Promise((resolve) => instance.server.close(resolve));
    }
    clearTimeout(cleanupDeadline);
    const report = { ok: exitCode === 0 && !fatalError, status: 'completed', stage,
      error: fatalError?.message || null, progress,
      path: isWgc ? 'Real WGC -> hardware-selected H264 -> native DataChannel -> WebCodecs (room server: signaling only)'
        : 'FFmpeg synthetic H264/AAC -> loopback SRT -> native DataChannel -> WebCodecs (room server: signaling only)',
      electron: process.versions.electron, nativeBinarySha256, producerEvidence, soakEvidence, obsState, phases, nativeStats, warnings, consoleErrors, hostMessages,
      transportAudit, mappingSummary, audioOutputMuted: true, ffmpegExit, nativeStopped: !agent.getStatus().running, logs: logs.slice(-40) };
    saveReport(report);
    console.log(JSON.stringify({ ok: report.ok, error: report.error, phases: phases.map(({ label, diagnostics }) => ({
      label, video: diagnostics?.webDecodedVideoFrames, audio: diagnostics?.webDecodedAudioBlocks,
      droppedVideo: diagnostics?.webDroppedVideoFrames, droppedAudio: diagnostics?.webDroppedAudioBlocks,
      playbackState: diagnostics?.playbackState, playbackFailureReason: diagnostics?.playbackFailureReason,
      relayFailureReason: diagnostics?.relayFailureReason
    })), reportPath }));
    app.exit(exitCode);
  }
}
