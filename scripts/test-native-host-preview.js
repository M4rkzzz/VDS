const assert = require('node:assert/strict');
const path = require('node:path');
const { MediaAgentManager } = require('../desktop/media-agent-manager');

// Isolated local smoke: no signaling room, user profile, installation or pixels
// saved. A placeholder also increments the old frame counter, so validate the
// actual source state and continued frame growth, not only a nonzero counter.
const manager = new MediaAgentManager({ logger: { log() {}, warn() {}, error() {} } });
manager.resolveBinaryPath = () => path.resolve(__dirname, '../runtime/media-agent/vds-media-agent.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sampleLivePreview(previousFrames = 0) {
  const deadline = Date.now() + 12000;
  let surface;
  do {
    const stats = await manager.invoke('getStats', {});
    surface = stats.surfaces.find(entry => entry.surface === 'owned-preview-smoke');
    if (surface && surface.decodedFramesRendered >= previousFrames + 5 &&
        surface.reason === 'live-preview-frame-rendered' && !surface.lastError) return surface;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`Real host preview did not advance: ${JSON.stringify(surface)}`);
}

async function main() {
  assert.equal(process.platform, 'win32', 'Native WGC preview smoke requires Windows');
  await manager.start();
  const cycles = [];
  for (let cycle = 0; cycle < 8; cycle++) {
    await manager.invoke('startHostSession', {
      mediaSessionId: `owned-preview-smoke-${cycle}`, backend: 'native',
      captureKind: 'display', captureTargetId: 'screen:0:0', displayId: '0',
      requestedCodec: 'h264', width: 640, height: 360, frameRate: 30, bitrateKbps: 2000
    });
    await manager.invoke('attachSurface', {
      surface: 'owned-preview-smoke', target: 'host-capture-artifact',
      embedded: false, visible: false, width: 320, height: 180
    });
    const first = await sampleLivePreview();
    const sustained = await sampleLivePreview(first.decodedFramesRendered);
    cycles.push({ cycle, firstFrames: first.decodedFramesRendered,
      sustainedFrames: sustained.decodedFramesRendered, reason: sustained.reason });
    await manager.invoke('detachSurface', { surface: 'owned-preview-smoke' });
    await manager.invoke('stopHostSession', {});
  }
  console.log(JSON.stringify({ ok: true, realPreviewCycles: cycles, isolated: true }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await manager.stop();
  assert.equal(manager.child, null);
  assert.equal(manager.retiringChild, null);
});
