const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Execute the production mapping functions without starting Electron.
function loadMappingFunctions(globals, filename = path.resolve(__dirname, '../../desktop/main.js')) {
  const names = ['udpRequest', 'requestNatPmpExternalAddress', 'requestNatPmpMapping', 'requestPcpMapping',
    'createP2PNatLease', 'parseIceCandidateForMapping', 'isValidIpv4', 'bufferToIpv4',
    'buildMappedIceCandidate', 'openP2PNatMappings'];
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  if (declarations.length !== names.length) throw new Error('missing production NAT mapping function');
  // A local fixture redirects only the gateway control port; packet encoding,
  // parsing, transport selection and lease lifetime logic remain production code.
  const code = declarations.map((node) => node.getText(source).replace(/^function udpRequest\(/, 'function actualUdpRequest(')).join('\n');
  return new Function(...Object.keys(globals), `${code}\nconst udpRequest = (...args) => gatewayRequest(actualUdpRequest, ...args);\nreturn {${names.join(',')}};`)(...Object.values(globals));
}
module.exports = { loadMappingFunctions };
