const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateNativeRuntime } = require('./native-runtime-integrity');

const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'media-agent', 'build');
const requiredTests = ['vds-peer-stun-config-tests', 'vds-tcp-so-e2e', 'vds-tcp-ice-e2e', 'vds-tcp-active-bind-e2e', 'vds-tcp-io-tests', 'vds-tcp-wire-tests', 'vds-tcp-delay-e2e', 'vds-nat-port-prediction-tests', 'vds-nat-allocation-model-tests', 'vds-nat-stun-probe-tests', 'vds-stun-resolver-tests', 'vds-stun-resolver-progress-tests', 'vds-sequential-pacing-tests', 'vds-nat-traversal-e2e', 'vds-nat-full-egress', 'vds-dual-stack-ice-e2e', 'vds-nat-sampled-range',
  'vds-random-nat-invalid-ice', 'vds-nat-exploration-plans', 'vds-nat-paced-recovery', 'vds-nat-primary-exploration', 'vds-early-dtls-callback-tests', 'vds-nat-early-handshake', 'vds-nat-late-path', 'vds-nat-sparse-samples', 'vds-nat-late-stun', 'vds-nat-sdp-candidates', 'vds-nat-delayed-nomination', 'vds-nat-same-address-stun', 'vds-nat-standard-peer', 'vds-nat-standard-multiexit'];

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
  run('node', ['scripts/test-native-nat-cleanup.js']);
  run('node', ['scripts/test-native-nat-contract.js', path.join(projectRoot, 'runtime', 'media-agent', 'vds-media-agent.exe')]);
  run('node', ['scripts/test-native-tcp-stun.js']);
  run('node', ['scripts/test-native-tcp-mapping.js']);
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
