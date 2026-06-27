const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

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

function fileSha256Hex(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function validatePackagedMediaAgentRuntime() {
  const runtimeBinaryPath = path.join(projectRoot, 'runtime', 'media-agent', 'vds-media-agent.exe');
  const packagedBinaryPath = path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'runtime', 'media-agent', 'vds-media-agent.exe');

  ensureFile(runtimeBinaryPath);
  ensureFile(packagedBinaryPath);

  const runtimeHash = fileSha256Hex(runtimeBinaryPath);
  const packagedHash = fileSha256Hex(packagedBinaryPath);

  if (runtimeHash !== packagedHash) {
    throw new Error(
      [
        'Packaged media-agent binary differs from runtime/media-agent.',
        `runtime/media-agent/vds-media-agent.exe sha256=${runtimeHash}`,
        `dist/win-unpacked/resources/runtime/media-agent/vds-media-agent.exe sha256=${packagedHash}`,
        'Run npm run build after npm run verify:media-agent so the installer includes the current agent.'
      ].join('\n')
    );
  }

  console.log('\nPackaged media-agent runtime matches runtime/media-agent.');
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

function validateReleaseArtifacts() {
  const version = readPackageVersion();
  const distResult = validateLatestManifest(path.join(projectRoot, 'dist'), version, 'dist');
  const updatesResult = validateLatestManifest(path.join(projectRoot, 'server', 'updates'), version, 'server/updates');

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

function main() {
  const syntaxFiles = [
    'server/public/app.js',
    'server/public/app-native-overrides.js',
    'desktop/main.js',
    'desktop/preload.js',
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
    'scripts/release-check.js'
  ];

  for (const fileName of syntaxFiles) {
    run('node', ['--check', fileName]);
  }

  run('npm', ['run', 'check:vds-web']);
  run('npm', ['run', 'test:vds-web']);
  run('npm', ['run', 'check:web-mobile-diagnostics']);
  if (mode === 'prebuild') {
    run('npm', ['run', 'build:vds-web']);
  }
  run('npm', ['run', 'test:server']);
  run('npm', ['run', 'check:architecture']);
  run('npm', ['run', 'check:logging']);
  if (mode === 'prebuild') {
    run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts\\verify-media-agent.ps1', '-Configuration', 'Release', '-AllowLocalFfmpegFallback']);
  }
  run('npm', ['audit', '--omit=dev']);
  run('npm', ['--prefix', 'server', 'audit', '--omit=dev']);
  run('node', ['scripts/check-server-docker-context.js']);

  if (mode === 'postbuild') {
    validatePackagedMediaAgentRuntime();
    validateReleaseArtifacts();
  }
  validateUnreleasedSection();

  console.log(`\nRelease ${mode} check passed.`);
}

try {
  main();
} catch (error) {
  console.error(`\nRelease ${mode} check failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
}
