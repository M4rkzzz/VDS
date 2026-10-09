'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('release preparation never replaces or invents an old map from a local rebuild', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const updates = path.join(root, 'server/updates'), dist = path.join(root, 'dist');
  fs.mkdirSync(updates, { recursive: true }); fs.mkdirSync(dist);
  const name = 'VDS-Setup-1.7.4.exe.blockmap';
  fs.writeFileSync(path.join(updates, name), 'official-map');
  fs.writeFileSync(path.join(dist, name), 'incompatible-rebuild-map');
  fs.writeFileSync(path.join(dist, 'latest.yml'), 'version: 1.7.4\n');
  fs.writeFileSync(path.join(dist, 'VDS-Setup-1.7.4.exe'), 'locally-rebuilt-exe');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../scripts/prepare-server-release.js'), 'utf8'), {
    __dirname: path.join(root, 'scripts'), module, console, process: { env: {} },
    require: name => name === './update-signature' ? {} : require(name)
  });
  module.exports.copyVersionedArtifacts('1.7.4');
  assert.equal(fs.readFileSync(path.join(updates, name), 'utf8'), 'official-map');
  fs.unlinkSync(path.join(updates, name));
  module.exports.copyVersionedArtifacts('1.7.4');
  assert.equal(fs.existsSync(path.join(updates, name)), false);
  module.exports.copyVersionedArtifacts('1.7.4', { includeInstaller: true });
  assert.equal(fs.readFileSync(path.join(updates, name), 'utf8'), 'incompatible-rebuild-map');
  const parsed = module.exports.parseLatestManifest('version: 1.7.5\nfiles:\n  - size: 235000000\npath: VDS-Setup-1.7.5.exe\nsha512: installer-hash\nblockmap:\n  path: VDS-Setup-1.7.5.exe.blockmap\n  size: 238000\n  sha512: map-hash\n');
  assert.equal(parsed.path, 'VDS-Setup-1.7.5.exe');
  assert.equal(parsed.size, 235000000);
  assert.equal(parsed.sha512, 'installer-hash');
});
