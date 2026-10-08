'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  verifySignedManifest, verifyDownloadedUpdate, publicKeyId, signaturePayload,
  MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES
} = require('../desktop/update-integrity');

const projectRoot = path.resolve(__dirname, '..');
const trustPath = path.join(projectRoot, 'desktop', 'update-trust.json');
const defaultPrivateKeyPath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'VDS', 'release-signing', 'release-ed25519-private.pem'
);

function assertOutsideProject(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('The release private key must be stored outside the project directory');
  }
  // Resolve the parent too: a junction inside the workspace must not silently
  // receive a release private key even if its textual path is outside it.
  const realParent = fs.realpathSync(path.dirname(resolved));
  const realRelative = path.relative(fs.realpathSync(projectRoot), realParent);
  if (!realRelative || (!realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative))) {
    throw new Error('The release private key directory resolves inside the project');
  }
  if (fs.existsSync(resolved)) {
    const actual = path.relative(fs.realpathSync(projectRoot), fs.realpathSync(resolved));
    if (!actual || (!actual.startsWith(`..${path.sep}`) && !path.isAbsolute(actual)) ||
        fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error('The release private key must be a regular file outside the project');
    }
  }
  return resolved;
}

function protectKeyDirectory(directory) {
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    return;
  }
  const literal = `'${directory.replace(/'/g, "''")}'`;
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$system = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")',
    '$acl = [System.Security.AccessControl.DirectorySecurity]::new()',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$acl.SetOwner($user)',
    'foreach ($id in @($user, $system)) { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow")) }',
    `Set-Acl -LiteralPath ${literal} -AclObject $acl`
  ].join('; ');
  // A PowerShell 7 parent can pass an incompatible PSModulePath into Windows
  // PowerShell 5, hiding Set-Acl. Let the child construct its native module path.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) throw new Error('Cannot restrict the release signing key directory ACL');
}

function readBoundedFile(filePath, limit, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error(`Invalid ${label} size`);
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== stat.size || bytes.length > limit) throw new Error(`${label} changed while being read`);
  return bytes;
}

function readTrust() {
  return JSON.parse(readBoundedFile(trustPath, 16 * 1024, 'public release trust configuration').toString('utf8'));
}

function initReleaseKey(privateKeyPath = defaultPrivateKeyPath) {
  const parent = path.dirname(path.resolve(privateKeyPath));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const resolved = assertOutsideProject(privateKeyPath);
  protectKeyDirectory(parent);
  let privateKey;
  if (fs.existsSync(resolved)) {
    privateKey = crypto.createPrivateKey(readBoundedFile(resolved, 16 * 1024, 'private release key'));
  } else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.writeFileSync(resolved, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const keyId = publicKeyId(publicKey);
  const trust = readTrust();
  if (trust.format !== 1 || !Array.isArray(trust.keys)) throw new Error('Invalid public release trust configuration');
  if (trust.keys.length > 0 && !trust.keys.some((entry) => entry.keyId === keyId)) {
    throw new Error('An existing public release key differs; explicit key rotation is required');
  }
  if (trust.keys.length === 0) {
    fs.writeFileSync(trustPath, `${JSON.stringify({ format: 1, keys: [{ keyId, publicKey }] }, null, 2)}\n`);
  }
  return { keyId, privateKeyPath: resolved };
}

function createManifestSignature(rawManifest, privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  return Buffer.from(`${JSON.stringify({
    format: 1,
    algorithm: 'Ed25519',
    keyId: publicKeyId(publicKey),
    signature: crypto.sign(null, signaturePayload(rawManifest), privateKey).toString('base64')
  })}\n`, 'utf8');
}

async function verifyReleaseDirectory(directory, options = {}) {
  const rawManifest = readBoundedFile(path.join(directory, 'latest.yml'), MAX_MANIFEST_BYTES, 'update manifest');
  const rawSignature = readBoundedFile(path.join(directory, 'latest.yml.sig'), MAX_SIGNATURE_BYTES, 'update signature');
  const info = verifySignedManifest(rawManifest, rawSignature, { trust: readTrust() });
  if (options.version && info.version !== options.version) throw new Error('Signed release version does not match package.json');
  await verifyDownloadedUpdate(path.join(directory, info.path), info);
  return info;
}

async function signReleaseDirectory(directory, options = {}) {
  const resolvedKey = assertOutsideProject(options.privateKeyPath || defaultPrivateKeyPath);
  const rawKey = readBoundedFile(resolvedKey, 16 * 1024, 'private release key');
  const privateKey = crypto.createPrivateKey(rawKey);
  const rawManifest = readBoundedFile(path.join(directory, 'latest.yml'), MAX_MANIFEST_BYTES, 'update manifest');
  const rawSignature = createManifestSignature(rawManifest, privateKey);
  const info = verifySignedManifest(rawManifest, rawSignature, { trust: readTrust() });
  if (options.version && info.version !== options.version) throw new Error('Signed release version does not match package.json');
  // Do not publish a signature for stale/mismatched artifacts. Stream the real
  // installer through exactly the verifier the desktop uses before installation.
  await verifyDownloadedUpdate(path.join(directory, info.path), info);
  const signaturePath = path.join(directory, 'latest.yml.sig');
  const temporary = `${signaturePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, rawSignature, { flag: 'wx' });
    fs.renameSync(temporary, signaturePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return info;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const readOption = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
    return args[index + 1];
  };
  const directory = path.resolve(readOption('--dir', path.join(projectRoot, 'dist')));
  const privateKeyPath = path.resolve(readOption('--key', defaultPrivateKeyPath));
  if (command === 'init') {
    const result = initReleaseKey(privateKeyPath);
    console.log(`Release public key initialized: ${result.keyId}`);
    console.log('The private key is stored outside the repository with user/SYSTEM-only access. Back it up securely; never upload it to the update server.');
    return;
  }
  const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  const info = command === 'sign'
    ? await signReleaseDirectory(directory, { version, privateKeyPath })
    : command === 'verify'
      ? await verifyReleaseDirectory(directory, { version })
      : null;
  if (!info) throw new Error('Usage: node scripts/update-signature.js init|sign|verify [--dir path] [--key path]');
  console.log(`Release metadata signature and installer verified: ${info.version}`);
}

module.exports = { initReleaseKey, createManifestSignature, signReleaseDirectory, verifyReleaseDirectory, defaultPrivateKeyPath };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release signing failed: ${error.message}`);
    process.exitCode = 1;
  });
}
