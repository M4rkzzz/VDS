const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('refreshing a relay viewer replaces its old transport and sends a new offer', async () => {
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  for (const file of ['native-peer-controller.js', 'native-peer-message-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../server/public/native', file), 'utf8'), context);
  }
  const sent = [], closed = [];
  let generation = 0, controller;
  controller = context.window.VDS.nativePeer.createController({
    isHost: () => false, getSessionRole: () => 'viewer', getUpstreamPeerId: () => 'host',
    getCurrentRoomId: () => 'ABC234',
    roomClient: { sendSignal: message => sent.push(message) },
    mediaEngine: {
      createPeer: async () => ({ transportGeneration: `generation-${++generation}` }),
      closePeer: async ({ peerId }) => closed.push(peerId),
      attachPeerMediaSource: async ({ peerId }) => {
        controller.handleLocalSignalEvent({
          peerId, transportGeneration: `generation-${generation}`, type: 'offer',
          sdp: { type: 'offer', sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\na=ice-ufrag:g${generation}\r\n` }
        });
      }
    }
  });
  const messages = context.window.VDS.nativePeerMessages.createController({
    nativePeerController: controller,
    createOfferToNextViewer: (...args) => controller.createRelayViewerOffer(...args)
  });
  try {
    await messages.handleConnectToNextMessage({ nextViewerId: 'web-viewer' });
    assert.equal(sent.length, 1);
    await messages.handleConnectToNextMessage({ nextViewerId: 'web-viewer' });
    assert.equal(sent.length, 1, 'duplicate initial notice keeps the existing negotiation');
    await messages.handleConnectToNextMessage({ nextViewerId: 'web-viewer', reconnect: true });
    assert.equal(generation, 2, 'a refreshed page cannot reuse its destroyed transport');
    assert.equal(sent.length, 2, 'the replacement page must receive a fresh offer');
    assert.notEqual(sent[0].sdp.sdp, sent[1].sdp.sdp);
    assert.equal(sent[1].reconnect, true);
    assert.deepEqual(closed, ['web-viewer']);
  } finally {
    await controller.closePeerConnection('web-viewer', { clearRetryState: true });
  }
});
