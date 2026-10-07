const { isIP } = require('node:net');
const { timingSafeEqual } = require('node:crypto');

function packetError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function checkPort(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) {
    throw packetError('PCP_INVALID_PORT');
  }
}

function checkNonce(nonce) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw packetError('PCP_INVALID_NONCE');
  }
}

function encodeAddress(value) {
  const rawAddress = String(value || '');
  const address = rawAddress.split('%')[0];
  const family = isIP(address);
  if (rawAddress.split('%').length > 2 || (family !== 6 && rawAddress.includes('%'))) {
    throw packetError('PCP_INVALID_CLIENT_ADDRESS');
  }
  const encoded = Buffer.alloc(16);
  if (family === 4) {
    encoded[10] = 0xff;
    encoded[11] = 0xff;
    address.split('.').forEach((part, index) => { encoded[12 + index] = Number(part); });
  } else if (family === 6) {
    let ipv6 = address;
    if (ipv6.includes('.')) {
      const suffixAt = ipv6.lastIndexOf(':');
      const octets = ipv6.slice(suffixAt + 1).split('.').map(Number);
      ipv6 = ipv6.slice(0, suffixAt + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
    }
    const halves = ipv6.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    groups.forEach((group, index) => encoded.writeUInt16BE(parseInt(group, 16), index * 2));
  } else {
    throw packetError('PCP_INVALID_CLIENT_ADDRESS');
  }
  const mappedIpv4 = encoded.subarray(0, 10).every(byte => byte === 0) && encoded[10] === 0xff && encoded[11] === 0xff;
  return { family: mappedIpv4 ? 4 : family, encoded };
}

function decodeAddress(encoded) {
  if (encoded.subarray(0, 10).every(byte => byte === 0) && encoded[10] === 0xff && encoded[11] === 0xff) {
    return [...encoded.subarray(12)].join('.');
  }
  return Array.from({ length: 8 }, (_, index) => encoded.readUInt16BE(index * 2).toString(16)).join(':');
}

// RFC 6887 sections 7.1 and 16.4: clientAddress must come from the socket
// used to send the request, after connecting it to the selected PCP server.
function buildPcpMapRequest({ clientAddress, internalPort, externalPort = 0, lifetimeSeconds, nonce }) {
  checkPort(internalPort);
  checkPort(externalPort, true);
  checkNonce(nonce);
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 0 || lifetimeSeconds > 0xffffffff) {
    throw packetError('PCP_INVALID_LIFETIME');
  }
  const { family, encoded } = encodeAddress(clientAddress);
  if (encoded.every(byte => byte === 0) || (family === 4 && encoded.subarray(12).every(byte => byte === 0))) {
    throw packetError('PCP_INVALID_CLIENT_ADDRESS');
  }
  const request = Buffer.alloc(60);
  request[0] = 2;
  request[1] = 1;
  request.writeUInt32BE(lifetimeSeconds, 4);
  encoded.copy(request, 8);
  nonce.copy(request, 24);
  request[36] = 17;
  request.writeUInt16BE(internalPort, 40);
  request.writeUInt16BE(externalPort, 42);
  // Section 5: an unspecified IPv4 external address is ::ffff:0.0.0.0.
  if (family === 4) request.fill(0xff, 54, 56);
  return request;
}

function parsePcpMapResponse(response, { nonce, internalPort }) {
  checkNonce(nonce);
  checkPort(internalPort);
  if (!Buffer.isBuffer(response) || response.length < 24 || response[0] !== 2 || response[1] !== 0x81) {
    throw packetError('PCP_INVALID_RESPONSE');
  }
  if (response[3] !== 0) {
    throw packetError(response[3] === 12 ? 'PCP_ADDRESS_MISMATCH' : `PCP_RESULT_${response[3]}`);
  }
  if (response.length < 60) throw packetError('PCP_TRUNCATED_RESPONSE');
  if (!timingSafeEqual(response.subarray(24, 36), nonce)) throw packetError('PCP_NONCE_MISMATCH');
  if (response[36] !== 17) throw packetError('PCP_PROTOCOL_MISMATCH');
  if (response.readUInt16BE(40) !== internalPort) throw packetError('PCP_INTERNAL_PORT_MISMATCH');
  const externalPort = response.readUInt16BE(42);
  checkPort(externalPort);
  const externalBytes = response.subarray(44, 60);
  const externalAddress = decodeAddress(externalBytes);
  if (externalBytes.every(byte => byte === 0) || externalAddress === '0.0.0.0') throw packetError('PCP_EXTERNAL_ADDRESS_UNAVAILABLE');
  return {
    protocol: 'pcp',
    internalPort,
    externalPort,
    externalAddress,
    lifetimeSeconds: response.readUInt32BE(4),
    epochSeconds: response.readUInt32BE(8)
  };
}

module.exports = { buildPcpMapRequest, parsePcpMapResponse };
