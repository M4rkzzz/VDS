const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { validateNativeRuntime } = require('./native-runtime-integrity');
const { assertNatTestsRegistered } = require('./test-native-nat');
const { verifyReleaseDirectory } = require('./update-signature');
const { publicKeyId } = require('../desktop/update-integrity');

const projectRoot = path.resolve(__dirname, '..');
const mode = process.argv.includes('--prebuild')
  ? 'prebuild'
  : process.argv.includes('--postbuild')
    ? 'postbuild'
    : 'postbuild';

function run(name, args) {
  const display = [name].concat(args).join(' ');
  console.log(`\n$ ${display}`);
  const result = spawnSync(name, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && name === 'npm'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${display}`);
  }
}

function readPackageVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required release file: ${path.relative(projectRoot, filePath)}`);
  }
}

function readLatestManifest(filePath) {
  const manifest = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^-?\s*([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line.trimStart());
    if (match) {
      manifest[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return manifest;
}

function fileSha512(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function validatePackagedMediaAgentRuntime() {
  const artifacts = validateNativeRuntime({
    packagedDir: path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'runtime', 'media-agent')
  });
  for (const artifact of artifacts) console.log(`Native runtime verified: ${artifact.name} sha256=${artifact.sha256}`);
  console.log('\nPackaged EXE and enhanced ICE DLLs match the current native build and runtime.');
}

function validateReleaseTrust(packaged = false) {
  const trustPath = path.join(projectRoot, 'desktop', 'update-trust.json');
  const bytes = fs.readFileSync(trustPath);
  const trust = JSON.parse(bytes);
  if (trust.format !== 1 || !Array.isArray(trust.keys) || !trust.keys.length || trust.keys.length > 4 ||
      trust.keys.some((key) => key.keyId !== publicKeyId(key.publicKey))) {
    throw new Error('Release signing public key configuration is missing or invalid');
  }
  if (packaged) {
    const archive = path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'app.asar');
    ensureFile(archive);
    validatePackagedScope(archive);
    const packagedTrust = require('@electron/asar').extractFile(archive, 'desktop/update-trust.json');
    if (!bytes.equals(packagedTrust)) throw new Error('Packaged release trust differs from the signing public keys');
  }
}

function assertPackagedScope(entries) {
  const topLevel = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error('Invalid packaged application path');
    const relative = entry.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const segments = relative.split('/');
    const top = segments[0];
    const malformed = segments.some(segment => !segment || segment === '.' || segment === '..');
    const allowed = ['desktop', 'server', 'node_modules'].includes(top) ||
      (top === 'package.json' && segments.length === 1);
    if (malformed || !allowed || (top === 'server' && segments.length > 1 && segments[1] !== 'public')) {
      throw new Error(`Packaged application contains an out-of-scope path: ${relative}`);
    }
    topLevel.add(top);
  }
  const required = ['desktop', 'node_modules', 'package.json', 'server'];
  const actual = [...topLevel].sort();
  if (actual.join('|') !== required.join('|')) throw new Error('Packaged application is missing its expected top-level paths');
  return { entries: entries.length, topLevel: actual };
}

function validatePackagedScope(archive = path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'app.asar')) {
  ensureFile(archive);
  const result = assertPackagedScope(require('@electron/asar').listPackage(archive));
  console.log(`Packaged application scope verified (${result.entries} paths).`);
  return result;
}

function validateLatestManifest(dirPath, version, label) {
  const installerName = `VDS-Setup-${version}.exe`;
  const latestPath = path.join(dirPath, 'latest.yml');
  const installerPath = path.join(dirPath, installerName);
  const blockmapPath = path.join(dirPath, `${installerName}.blockmap`);

  ensureFile(latestPath);
  ensureFile(installerPath);
  ensureFile(blockmapPath);

  const manifest = readLatestManifest(latestPath);
  const installerStat = fs.statSync(installerPath);
  const blockmapStat = fs.statSync(blockmapPath);
  const installerSha512 = fileSha512(installerPath);

  if (manifest.version !== version) {
    throw new Error(`${label} latest.yml version mismatch: expected ${version}, got ${manifest.version || '(missing)'}`);
  }
  if (manifest.path !== installerName) {
    throw new Error(`${label} latest.yml path mismatch: expected ${installerName}, got ${manifest.path || '(missing)'}`);
  }
  if (Number(manifest.size) !== installerStat.size) {
    throw new Error(`${label} latest.yml size mismatch: expected ${installerStat.size}, got ${manifest.size || '(missing)'}`);
  }
  if (manifest.sha512 !== installerSha512) {
    throw new Error(`${label} latest.yml sha512 mismatch`);
  }
  if (blockmapStat.size <= 0) {
    throw new Error(`${label} blockmap is empty: ${path.relative(projectRoot, blockmapPath)}`);
  }

  return {
    installerName,
    size: installerStat.size,
    sha512: installerSha512
  };
}

async function validateReleaseArtifacts() {
  const version = readPackageVersion();
  const distResult = validateLatestManifest(path.join(projectRoot, 'dist'), version, 'dist');
  const updatesResult = validateLatestManifest(path.join(projectRoot, 'server', 'updates'), version, 'server/updates');
  await verifyReleaseDirectory(path.join(projectRoot, 'dist'), { version });
  await verifyReleaseDirectory(path.join(projectRoot, 'server', 'updates'), { version });
  if (!fs.readFileSync(path.join(projectRoot, 'dist', 'latest.yml.sig')).equals(
    fs.readFileSync(path.join(projectRoot, 'server', 'updates', 'latest.yml.sig')))) {
    throw new Error('dist and server/updates metadata signatures differ');
  }

  if (distResult.size !== updatesResult.size || distResult.sha512 !== updatesResult.sha512) {
    throw new Error('dist and server/updates installer metadata differ');
  }

  console.log(`\nRelease artifacts are consistent for ${version}: ${distResult.installerName}`);
}

function validateUnreleasedSection() {
  const planPath = path.join(projectRoot, 'MEDIA_REFACTOR_PLAN.md');
  ensureFile(planPath);
  const plan = fs.readFileSync(planPath, 'utf8');
  const sectionMatch = /## 2\. 未发布改动记录([\s\S]*?)## 3\./.exec(plan);

  if (!sectionMatch) {
    throw new Error('MEDIA_REFACTOR_PLAN.md is missing section "## 2. 未发布改动记录"');
  }
  if (!/当前未发布改动：[\s\S]*?\n- /.test(sectionMatch[1])) {
    throw new Error('MEDIA_REFACTOR_PLAN.md has no unreleased change entries');
  }
}

async function main() {
  const syntaxFiles = [
    'server/public/app.js',
    'server/public/app-native-overrides.js',
    'desktop/main.js',
    'desktop/preload.js',
    'desktop/update-integrity.js',
    'server/server-core.js',
    'server/index.js',
    'scripts/prepare-server-release.js',
    'scripts/publish-github-release.js',
    'scripts/check-server-docker-context.js',
    'scripts/check-media-agent-boundary.js',
    'scripts/check-renderer-entry.js',
    'scripts/check-renderer-syntax.js',
    'scripts/check-renderer-bridge.js',
    'scripts/check-room-client-dispatcher.js',
    'scripts/test-server-core.js',
    'scripts/check-web-mobile-diagnostics.js',
    'scripts/native-runtime-integrity.js',
    'scripts/test-native-runtime-integrity.js',
    'scripts/test-native-nat.js',
    'scripts/test-native-nat-contract.js',
    'scripts/release-check.js',
    'scripts/update-signature.js'
  ];

  for (const fileName of syntaxFiles) {
    run('node', ['--check', fileName]);
  }
  validateReleaseTrust();

  run('npm', ['run', 'check:vds-web']);
  run('npm', ['run', 'test:vds-web']);
  run('npm', ['run', 'check:web-mobile-diagnostics']);
  if (mode === 'prebuild') {
    run('npm', ['run', 'build:vds-web']);
  }
  run('npm', ['run', 'test:server']);
  run('npm', ['run', 'test:server-revival']);
  run('npm', ['run', 'test:server-reconnect']);
  run('npm', ['run', 'test:desktop']);
  run('npm', ['run', 'check:architecture']);
  run('npm', ['run', 'check:logging']);
  if (mode === 'prebuild') {
    run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts\\verify-media-agent.ps1', '-Configuration', 'Release', '-AllowLocalFfmpegFallback']);
    // verify-media-agent has already run all registered CTests, including NAT.
    assertNatTestsRegistered();
    validateNativeRuntime();
    run('node', ['--test', 'scripts/test-native-runtime-integrity.js']);
    run('node', ['scripts/test-native-nat-contract.js', path.join(projectRoot, 'runtime', 'media-agent', 'vds-media-agent.exe')]);
  }
  run('npm', ['audit', '--omit=dev']);
  run('npm', ['--prefix', 'server', 'audit', '--omit=dev']);
  run('node', ['scripts/check-server-docker-context.js']);

  if (mode === 'postbuild') {
    validatePackagedMediaAgentRuntime();
    validateReleaseTrust(true);
    await validateReleaseArtifacts();
  }
  validateUnreleasedSection();

  console.log(`\nRelease ${mode} check passed.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nRelease ${mode} check failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = { assertPackagedScope, validatePackagedScope };
