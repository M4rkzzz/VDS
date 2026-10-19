const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(attachSurface) {
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  for (const file of ['native-peer-controller.js', 'native-peer-message-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../server/public/native', file), 'utf8'), context);
  }
  const sent = [], phases = [], metadata = new Map();
  let controller;
  controller = context.window.VDS.nativePeer.createController({
    isHost: () => false,
    getPeerMeta: id => metadata.get(id),
    setPeerMeta: (id, meta) => metadata.set(id, meta),
    roomClient: { sendSignal(message) { sent.push(message); phases.push('answer-sent'); } },
    surfaceController: { attachPeerVideoSurface: attachSurface },
    mediaEngine: {
      createPeer: async () => ({ transportGeneration: 'test-generation' }),
      setRemoteDescription: async ({ peerId }) => {
        phases.push('remote-description-applied');
        controller.handleLocalSignalEvent({
          peerId, transportGeneration: 'test-generation', type: 'answer',
          sdp: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:local\r\n' }
        });
      }
    }
  });
  const handle = controller.createPeerConnection('host', false, 'upstream');
  await controller.ensurePeerReady('host', handle);
  controller.clearPeerConnectTimeout('host');
  const messages = context.window.VDS.nativePeerMessages.createController({
    nativePeerController: controller, isHost: () => false,
    getCurrentRoomId: () => 'AB1234', getUpstreamPeerId: () => 'host',
    getPeerConnection: () => handle,
    startViewerStatsPolling: () => phases.push('stats-started')
  });
  const offer = {
    fromClientId: 'host', attemptId: 1,
    sdp: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:remote\r\n' }
  };
  return { controller, messages, offer, sent, phases, handle };
}

test('a pending native video surface cannot hold back an already generated ICE answer', async () => {
  const surface = deferred(), entered = deferred();
  const h = await harness(() => { entered.resolve(); return surface.promise; });
  const handling = h.messages.handleOfferMessage(h.offer);
  try {
    await entered.promise;
    assert.equal(h.sent.length, 1, 'remote peer needs its answer while the display is still initializing');
    assert.equal(h.sent[0].type, 'answer');
    assert.equal(h.sent[0].targetId, 'host');
    assert.equal(h.sent[0].roomId, 'AB1234');
    assert.equal(h.sent[0].attemptId, 1);
    assert.equal(h.sent[0].sdp.type, 'answer');
    assert.equal(h.phases.includes('stats-started'), false);
  } finally {
    surface.resolve();
    await handling;
  }
  assert.equal(h.phases.includes('stats-started'), true);
  assert.equal(h.sent.length, 1);
});

test('surface failure remains visible without suppressing the native answer', async () => {
  const h = await harness(async () => { throw new Error('surface-create-failed'); });
  await assert.rejects(h.messages.handleOfferMessage(h.offer), /surface-create-failed/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'answer');
  assert.equal(h.phases.includes('stats-started'), false);
});

test('an old offer cannot send an answer or attach a surface after a newer attempt', async () => {
  let attachments = 0;
  const h = await harness(async () => { ++attachments; });
  h.controller.applyRemoteOfferAttempt('host', 2, 'upstream');
  await h.messages.handleOfferMessage(h.offer);
  assert.equal(h.sent.length, 0);
  assert.equal(attachments, 0);
});

test('a replaced peer cannot attach the previous offer to its new surface', async () => {
  let attachments = 0;
  const h = await harness(async () => { ++attachments; });
  const replacement = h.controller.createPeerConnection('host', false, 'upstream');
  await h.controller.ensurePeerReady('host', replacement);
  h.controller.clearPeerConnectTimeout('host');
  await assert.rejects(h.controller.attachViewerRemoteOfferSurface('host', h.handle), /native-peer-stale/);
  assert.equal(attachments, 0);
});
