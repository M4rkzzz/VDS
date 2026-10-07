const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateNativeRuntime } = require('./native-runtime-integrity');

const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'media-agent', 'build');
const requiredTests = ['vds-nat-port-prediction-tests', 'vds-nat-stun-probe-tests', 'vds-nat-traversal-e2e'];

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NAT verification failed: ${command} exited ${result.status}`);
  return result;
}

function assertNatTestsRegistered() {
  const list = run('ctest', ['--test-dir', buildDir, '-C', 'Release', '--show-only=json-v1'], { stdio: 'pipe', encoding: 'utf8' });
  const names = new Set(JSON.parse(list.stdout).tests.map((test) => test.name));
  for (const name of requiredTests) {
    if (!names.has(name)) throw new Error(`Required NAT CTest is not registered: ${name}. Run npm run build:media-agent first.`);
  }
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('verify:nat requires the Windows native ICE fixture and runtime. Run this verification on Windows after npm run build:media-agent; no native checks were skipped.');
  }
  validateNativeRuntime();
  assertNatTestsRegistered();
  run('node', ['--test', 'scripts/test-native-runtime-integrity.js']);
  run('ctest', ['--test-dir', buildDir, '-C', 'Release', '--output-on-failure', '--no-tests=error', '-R', `^(${requiredTests.join('|')})$`]);
  run('node', ['scripts/test-native-nat-contract.js', path.join(projectRoot, 'runtime', 'media-agent', 'vds-media-agent.exe')]);
  console.log('\nNative NAT algorithm, real DataChannel traversal, RPC contracts and runtime integrity passed.');
}

module.exports = { assertNatTestsRegistered };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nNative NAT verification failed: ${error.message || error}`);
    process.exitCode = 1;
  }
}
