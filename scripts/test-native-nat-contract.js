const assert = require('node:assert/strict');
const path = require('node:path');
const { MediaAgentManager } = require('../desktop/media-agent-manager');

if (process.argv[2]) process.env.VDS_MEDIA_AGENT_PATH = path.resolve(process.argv[2]);
const events = [];
const agent = new MediaAgentManager({ logger: { log() {}, warn() {}, error() {} } });
agent.on('event', (event) => events.push(event));

async function main() {
  try {
    await agent.start();
    const options = { peerId: 'nat-generation-contract', role: 'viewer-upstream', initiator: false,
      stunServer: 'stun:127.0.0.1:3478',
      stunServers: ['stun:127.0.0.1:3478', 'stun:127.0.0.1:3479', 'stun:[::1]:3480'] };
    const first = await agent.invoke('createPeer', options);
    assert.ok(first.transportGeneration, 'native creation must return the immutable transport identity');
    await agent.invoke('closePeer', { peerId: options.peerId, transportGeneration: first.transportGeneration });
    const second = await agent.invoke('createPeer', options);
    assert.notEqual(second.transportGeneration, first.transportGeneration);
    for (const stunServers of [['turn:127.0.0.1:3478'], null, 'stun:127.0.0.1:3478',
      Array.from({ length: 5 }, () => 'stun:127.0.0.1:3478')]) {
      await assert.rejects(agent.invoke('createPeer', { ...options, stunServers }), { code: 'BAD_REQUEST' });
    }
    for (const [method, params] of [
      ['addRemoteIceCandidate', { candidate: 'candidate:1 1 UDP 1 127.0.0.1 41000 typ srflx', sdpMid: '0' }],
      ['setRemoteDescription', { type: 'answer', sdp: 'not-an-sdp' }],
      ['detachPeerMediaSource', {}],
      ['closePeer', {}]
    ]) {
      await assert.rejects(agent.invoke(method, { ...params, peerId: options.peerId,
        transportGeneration: first.transportGeneration }), { code: 'STALE_TRANSPORT' });
    }
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { peerId: options.peerId,
      candidate: 'candidate:2 1 UDP 1 127.0.0.1 41001 typ srflx ufrag stale vds-predicted 1', sdpMid: '0' }), { code: 'BAD_REQUEST' });
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { peerId: options.peerId,
      candidate: 'candidate:2 1 UDP 1 127.0.0.1 41001 typ srflx ufrag stale vds-predicted\t1', sdpMid: '0' }), { code: 'BAD_REQUEST' });
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { peerId: options.peerId,
      transportGeneration: second.transportGeneration,
      candidate: 'candidate:3 1 UDP 1 127.0.0.1 41001 typ srflx ufrag stale vds-predicted 1', sdpMid: '0' }), /stale-candidate-ice-credentials/);
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { peerId: options.peerId,
      transportGeneration: second.transportGeneration,
      candidate: 'candidate:4 1 UDP 1 127.0.0.1 41001 typ relay', sdpMid: '0' }), /relay-candidates-forbidden/);
    const stats = await agent.invoke('getStats');
    const peer = stats.peers.find((item) => item.peerId === options.peerId);
    assert.equal(peer.peerTransport.transportGeneration, second.transportGeneration);
    assert.equal(peer.peerTransport.remoteCandidateCount, 0, 'rejected stale/predicted/relay candidates must not mutate the new transport');
    assert.deepEqual(peer.peerTransport.stunServers, options.stunServers);
    assert.equal(peer.peerTransport.selectedStunServer, options.stunServer);
    assert.equal(peer.peerTransport.natTraversalEnabled, true, 'production native must use the patched ICE backend');

    const source = await agent.invoke('createPeer', { ...options, peerId: 'nat-credential-source', initiator: true });
    const deadline = Date.now() + 5000;
    let offer;
    while (!(offer = events.find(({ event, params }) => event === 'signal' &&
        params.peerId === 'nat-credential-source' && params.type === 'offer')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(offer, 'generate a real native SDP for embedded-candidate validation');
    const cleanSdp = offer.params.sdp.sdp.replace(/^a=candidate:.*\r?\n/gm, '').replace(/^a=end-of-candidates\r?\n/gm, '');
    const ufrag = /^a=ice-ufrag:([^\r\n]+)/m.exec(cleanSdp)?.[1];
    assert.ok(ufrag);
    const remote = { peerId: options.peerId, transportGeneration: second.transportGeneration, type: 'offer' };
    const srflx = `candidate:confirmed 1 UDP 100 127.0.0.1 42000 typ srflx ufrag ${ufrag}`;
    const prediction = (port, address = '127.0.0.1') =>
      `candidate:prediction${port} 1 UDP 1 ${address} ${port} typ srflx ufrag ${ufrag} vds-predicted 1`;
    await assert.rejects(agent.invoke('setRemoteDescription', { ...remote,
      sdp: cleanSdp + 'a=candidate:relay 1 UDP 1 127.0.0.1 42001 typ relay\r\n' }), /relay-candidates-forbidden/);
    await assert.rejects(agent.invoke('setRemoteDescription', { ...remote,
      sdp: cleanSdp + `a=${prediction(42001)}\r\n` }), /predicted-candidate-without-confirmed-address/);
    await assert.rejects(agent.invoke('setRemoteDescription', { ...remote,
      sdp: cleanSdp + `a=${srflx}\r\n` + Array.from({ length: 17 }, (_, index) => `a=${prediction(42001 + index)}\r\n`).join('')
    }), /predicted-candidate-budget-exhausted/);
    assert.equal((await agent.invoke('getStats')).peers.find((item) => item.peerId === options.peerId)
      .peerTransport.remoteDescriptionSet, false, 'invalid SDP must not change the live transport');
    await agent.invoke('setRemoteDescription', { ...remote, sdp: cleanSdp });
    const candidateParams = { peerId: options.peerId, transportGeneration: second.transportGeneration, sdpMid: '0' };
    await agent.invoke('addRemoteIceCandidate', { ...candidateParams,
      candidate: 'candidate:ufrag 1 UDP 100 127.0.0.1 42000 typ srflx' });
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { ...candidateParams,
      candidate: srflx + ' ufrag conflicting' }), /conflicting-candidate-extension/);
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { ...candidateParams,
      candidate: prediction(42001, '127.0.0.2') }), /predicted-candidate-without-confirmed-address/);
    for (let index = 0; index < 16; index += 1) {
      await agent.invoke('addRemoteIceCandidate', { ...candidateParams, candidate: prediction(42001 + index) });
    }
    await agent.invoke('addRemoteIceCandidate', { ...candidateParams, candidate: prediction(42001) });
    await assert.rejects(agent.invoke('addRemoteIceCandidate', { ...candidateParams,
      candidate: prediction(42017) }), /predicted-candidate-budget-exhausted/);
    const bounded = (await agent.invoke('getStats')).peers.find((item) => item.peerId === options.peerId).peerTransport;
    assert.equal(bounded.predictedRemoteCandidates, 16);
    assert.equal(bounded.remoteCandidateCount, 17, 'duplicate predictions do not consume budget or mutate counts');
    await agent.invoke('closePeer', { peerId: 'nat-credential-source', transportGeneration: source.transportGeneration });
    await agent.invoke('closePeer', { peerId: options.peerId, transportGeneration: second.transportGeneration });
    assert.equal((await agent.invoke('getStats')).peers.length, 0);
    assert.ok(events.filter(({ event }) => event === 'peer-state').every(({ params }) => typeof params.transportGeneration === 'string'));
    console.log('native NAT configuration, generation, credential and pure-P2P contracts passed');
  } finally {
    await agent.stop();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
