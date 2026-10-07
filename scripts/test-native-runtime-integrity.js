const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { validateNativeRuntime } = require('./native-runtime-integrity');

test('release gate rejects stale ICE sources and stale runtime/packaged EXE or DLL', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-native-integrity-'));
  context.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('vds-native-integrity-')) {
      throw new Error(`Refusing to remove a directory outside this test's temporary root: ${root}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relativePath, value) => {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, value);
  };
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase();
  const algorithm = 'algorithm';
  const patch = 'patch';
  write('media-agent/src/nat_port_prediction.h', algorithm);
  for (const name of ['libjuice-1.7.0', 'libdatachannel-0.24.1']) {
    write(`media-agent/third_party/ice-patches/${name}-vds.patch`, patch);
  }
  write('media-agent/build/vds-ice/installed/vds-enhanced-ice.txt', `\uFEFFlibjuice=1.7.0-${hash(patch)}-${hash(algorithm)}\r\nlibdatachannel=0.24.1-${hash(patch)}-${hash(algorithm)}\r\n`);
  const packagedDir = path.join(root, 'packaged');
  for (const name of ['vds-media-agent.exe', 'juice.dll', 'datachannel.dll']) {
    const buildPath = name.endsWith('.exe') ? `media-agent/build/Release/${name}` : `media-agent/build/vds-ice/installed/bin/${name}`;
    write(buildPath, name);
    write(`runtime/media-agent/${name}`, name);
    write(`packaged/${name}`, name);
  }
  assert.equal(validateNativeRuntime({ root, packagedDir }).length, 3);
  for (const name of ['vds-media-agent.exe', 'juice.dll', 'datachannel.dll']) {
    write(`runtime/media-agent/${name}`, 'old');
    assert.throws(() => validateNativeRuntime({ root, packagedDir }), /Native runtime differs/);
    write(`runtime/media-agent/${name}`, name);
    write(`packaged/${name}`, 'old');
    assert.throws(() => validateNativeRuntime({ root, packagedDir }), /Packaged native runtime differs/);
    write(`packaged/${name}`, name);
  }
  write('media-agent/src/nat_port_prediction.h', 'new algorithm');
  assert.throws(() => validateNativeRuntime({ root, packagedDir }), /does not match current sources/);
});
