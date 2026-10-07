const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPcpMapRequest, parsePcpMapResponse } = require('../../desktop/pcp-packet');

const nonce = Buffer.from('000102030405060708090a0b', 'hex');
const options = { clientAddress: '192.0.2.10', internalPort: 50000, lifetimeSeconds: 180, nonce };

function routerResponse(request) {
  const response = Buffer.alloc(60);
  response[0] = 2;
  response[1] = 0x81;
  response.writeUInt32BE(180, 4);
  response.writeUInt32BE(1234, 8);
  request.subarray(24, 44).copy(response, 24);
  response.writeUInt16BE(55000, 42);
  Buffer.from('00000000000000000000ffffc6336405', 'hex').copy(response, 44);
  return response;
}

test('a conforming router rejects the previous zero client address and accepts the socket source address', () => {
  const source = Buffer.from('00000000000000000000ffffc000020a', 'hex');
  const compliantRouter = request => {
    const response = routerResponse(request);
    if (!request.subarray(8, 24).equals(source)) response[3] = 12;
    return response;
  };
  const fixedRequest = buildPcpMapRequest(options);
  const previousRequest = Buffer.from(fixedRequest);
  previousRequest.fill(0, 8, 24);
  assert.throws(() => parsePcpMapResponse(compliantRouter(previousRequest), options), { code: 'PCP_ADDRESS_MISMATCH' });
  assert.deepEqual(parsePcpMapResponse(compliantRouter(fixedRequest), options), {
    protocol: 'pcp', internalPort: 50000, externalPort: 55000,
    externalAddress: '198.51.100.5', lifetimeSeconds: 180, epochSeconds: 1234
  });
  assert.equal(fixedRequest.length, 60);
  assert.equal(fixedRequest.readUInt16BE(42), 0);
  assert.equal(fixedRequest.subarray(44).toString('hex'), '00000000000000000000ffff00000000');
});

test('IPv6 source addresses preserve their complete bytes including compressed and embedded IPv4 syntax', () => {
  const expected = '20010db8000000000000000000000012';
  assert.equal(buildPcpMapRequest({ ...options, clientAddress: '2001:db8::12' }).subarray(8, 24).toString('hex'), expected);
  assert.equal(buildPcpMapRequest({ ...options, clientAddress: '2001:db8:0:0:0:0:0:12' }).subarray(8, 24).toString('hex'), expected);
  const mappedIpv4 = buildPcpMapRequest({ ...options, clientAddress: '::ffff:192.0.2.10' });
  assert.equal(mappedIpv4.subarray(8, 24).toString('hex'), '00000000000000000000ffffc000020a');
  assert.equal(mappedIpv4.subarray(44).toString('hex'), '00000000000000000000ffff00000000');
  const linkLocal = buildPcpMapRequest({ ...options, clientAddress: 'fe80::1%7' });
  assert.equal(linkLocal.subarray(8, 24).toString('hex'), 'fe800000000000000000000000000001');
  assert.equal(linkLocal.subarray(44).toString('hex'), '00000000000000000000000000000000');
  const response = routerResponse(buildPcpMapRequest(options));
  Buffer.from(expected, 'hex').copy(response, 44);
  assert.equal(parsePcpMapResponse(response, options).externalAddress, '2001:db8:0:0:0:0:0:12');
});

test('unrelated successful datagrams cannot be accepted as a PCP mapping', () => {
  const original = routerResponse(buildPcpMapRequest(options));
  const cases = [
    [24, original[24] ^ 1, 'PCP_NONCE_MISMATCH'],
    [36, 6, 'PCP_PROTOCOL_MISMATCH'],
    [40, 0, 'PCP_INTERNAL_PORT_MISMATCH'],
    [0, 0, 'PCP_INVALID_RESPONSE'],
    [1, 1, 'PCP_INVALID_RESPONSE']
  ];
  for (const [offset, value, code] of cases) {
    const response = Buffer.from(original);
    response[offset] = value;
    assert.throws(() => parsePcpMapResponse(response, options), { code });
  }
  assert.throws(() => parsePcpMapResponse(original.subarray(0, 59), options), { code: 'PCP_TRUNCATED_RESPONSE' });
  const expiredAddress = Buffer.from(original);
  expiredAddress.fill(0, 44, 60);
  assert.throws(() => parsePcpMapResponse(expiredAddress, options), { code: 'PCP_EXTERNAL_ADDRESS_UNAVAILABLE' });
});

test('the router may assign a different external port than suggested', () => {
  const request = buildPcpMapRequest({ ...options, externalPort: 50000 });
  assert.equal(request.readUInt16BE(42), 50000);
  assert.equal(parsePcpMapResponse(routerResponse(request), options).externalPort, 55000);
});

test('invalid request addresses, nonce, ports, and lifetime fail before a UDP request is sent', () => {
  for (const clientAddress of ['', '0.0.0.0', '::', '::ffff:0.0.0.0', 'not-an-address', '192.0.2.999', '192.0.2.10%7']) {
    assert.throws(() => buildPcpMapRequest({ ...options, clientAddress }), { code: 'PCP_INVALID_CLIENT_ADDRESS' });
  }
  assert.throws(() => buildPcpMapRequest({ ...options, internalPort: 0 }), { code: 'PCP_INVALID_PORT' });
  assert.throws(() => buildPcpMapRequest({ ...options, externalPort: 65536 }), { code: 'PCP_INVALID_PORT' });
  assert.throws(() => buildPcpMapRequest({ ...options, nonce: Buffer.alloc(11) }), { code: 'PCP_INVALID_NONCE' });
  assert.throws(() => buildPcpMapRequest({ ...options, lifetimeSeconds: -1 }), { code: 'PCP_INVALID_LIFETIME' });
});
