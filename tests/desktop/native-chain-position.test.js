const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('position-only notice preserves a connected native upstream, but failed/changed upstreams recover', async () => {
  for (const [state, nextUpstream, expectedRequests] of [
    ['connected', 'host', 0], ['failed', 'host', 1], ['connected', 'other', 1]
  ]) {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,
      '../../server/public/native/native-peer-message-controller.js'), 'utf8'), context);
    let position = 1;
    let requests = 0;
    let joinedPosition;
    const controller = context.window.VDS.nativePeerMessages.createController({
      nativePeerController: { clearAllPeerReconnects() {} },
      roomClient: { sendViewerReconnectReady: () => { requests++; } },
      getHostId: () => 'host', getUpstreamPeerId: () => 'host',
      getCurrentRoomId: () => 'ROOM', getPeerConnection: () => ({ connectionState: state }),
      setChainPosition: value => { position = value; },
      setViewerJoinedUi: value => { joinedPosition = value.chainPosition; }
    });
    await controller.handleChainReconnectMessage({ preserveMedia: true,
      upstreamPeerId: nextUpstream, newChainPosition: 0 });
    assert.equal(position, 0);
    assert.equal(joinedPosition, 0);
    assert.equal(requests, expectedRequests);
  }
});
