'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { CancellationToken } = require('builder-util-runtime');
const { createManifestSignature } = require('../../scripts/update-signature');
const differential = require('../../desktop/update-differential');
const tls = require('../fixtures/update-https.json');
const key = crypto.generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
const modulePath = require.resolve('../../desktop/update-integrity');
const localRequire = Module.createRequire(modulePath);
const isolated = { exports: {} };
const trust = { format: 1, keys: [{ keyId: localRequire(modulePath).publicKeyId(publicKey), publicKey }] };
vm.runInThisContext(Module.wrap(fs.readFileSync(modulePath, 'utf8')), { filename: modulePath })(
  isolated.exports, name => name === './update-trust.json' ? trust : localRequire(name), isolated, modulePath, path.dirname(modulePath));
const api = isolated.exports;

function release(version, chunks, malformed = false) {
  const installer = Buffer.concat(chunks);
  const map = { version: '2', files: [{ name: 'file', offset: 0,
    sizes: chunks.map(chunk => chunk.length),
    checksums: chunks.map(chunk => crypto.createHash('sha256').update(chunk).digest().subarray(0, 18).toString('base64')) }] };
  if (malformed) map.files[0].sizes[0] += 1;
  const blockmap = zlib.gzipSync(JSON.stringify(map));
  const name = `VDS-Setup-${version}.exe`;
  const hash = bytes => crypto.createHash('sha512').update(bytes).digest('base64');
  const info = { version, path: name, sha512: hash(installer), files: [{ url: name, size: installer.length, sha512: hash(installer) }],
    blockmap: { path: name + '.blockmap', size: blockmap.length, sha512: hash(blockmap) } };
  const raw = Buffer.from(JSON.stringify(info));
  return { installer, blockmap, info, raw, signature: createManifestSignature(raw, key.privateKey) };
}

test('real NSIS signed differential downloads, fallback, cancellation and cache retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-differential-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = tls.cert;
  t.after(() => { https.globalAgent.options.ca = oldCa; });
  const a = crypto.randomBytes(64 * 1024), b = crypto.randomBytes(64 * 1024), c = crypto.randomBytes(64 * 1024);
  const previous = release('1.7.5', [a, b, c]);
  const next = release('1.7.6', [a, crypto.randomBytes(b.length), c]);
  const malformed = release('1.7.6', [a, Buffer.alloc(b.length, 0xaa), c], true);
  let mode = 'valid', requests = [], served = 0, cancelAfterRange;
  const server = https.createServer(tls, (request, response) => {
    const name = request.url.split('?')[0].split('/').pop();
    requests.push({ name, range: request.headers.range });
    const target = mode === 'malformed-map' ? malformed : mode === 'installed' ? previous : next;
    if (name === 'latest.yml') return response.end(target.raw);
    if (name === 'latest.yml.sig') return response.end(target.signature);
    if (name === previous.info.blockmap.path) return response.end(previous.blockmap);
    if (name === target.info.blockmap.path) {
      if (mode === 'corrupt-map') return response.end(Buffer.alloc(target.blockmap.length));
      if (mode === 'map-redirect') { response.writeHead(302, { location: '/untrusted' }); return response.end(); }
      return response.end(target.blockmap);
    }
    if (name === target.info.path) {
      const range = request.headers.range;
      if (!range) { served += target.installer.length; return response.end(target.installer); }
      const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(startText), end = Number(endText);
      let bytes = target.installer.subarray(start, end + 1);
      if (mode === 'range-200') return response.end(target.installer);
      if (mode === 'range-redirect') { response.writeHead(302, { location: '/untrusted' }); return response.end(); }
      response.writeHead(206, { 'content-range': mode === 'wrong-range' ? `bytes 0-${bytes.length - 1}/${target.installer.length}` : `bytes ${start}-${end}/${target.installer.length}` });
      if (mode === 'corrupt-range') bytes = Buffer.alloc(bytes.length);
      if (mode === 'short-range') bytes = bytes.subarray(1);
      if (mode === 'long-range') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
      served += bytes.length;
      if (mode === 'cancel') {
        response.write(bytes.subarray(0, 1024));
        cancelAfterRange?.();
        const timer = setTimeout(() => response.end(bytes.subarray(1024)), 1000);
        response.on('close', () => clearTimeout(timer));
        return;
      }
      return response.end(bytes);
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const feed = `https://127.0.0.1:${server.address().port}/updates/`;
  const config = path.join(root, 'app-update.yml');
  fs.writeFileSync(config, 'updaterCacheDirName: vds-fixture\n');
  function make(label) {
    const app = { version: '1.7.5', name: 'VDS differential fixture', isPackaged: true,
      userDataPath: path.join(root, label, 'profile'), baseCachePath: path.join(root, label, 'cache'), appUpdateConfigPath: config,
      whenReady: async () => {}, quit: () => assert.fail('No installer execution'), onQuit: () => assert.fail('No auto install') };
    const updater = new NsisUpdater(null, app);
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.disableWebInstaller = true;
    updater.httpExecutor = new NodeHttpExecutor();
    updater.logger = { info() {}, warn() {}, error() {} };
    updater.on('error', () => {});
    differential.configureDifferentialUpdates(updater, api);
    updater.setFeedURL(api.createSignedUpdateFeedOptions(feed));
    return updater;
  }
  async function baseline(updater) {
    const file = path.join(root, crypto.randomUUID() + '.exe');
    fs.writeFileSync(file, previous.installer);
    const info = api.verifySignedManifest(previous.raw, previous.signature, { baseUrl: feed });
    await differential.prepareDifferentialBaseline(updater, file, info, api);
    return updater.downloadedUpdateHelper.cacheDir;
  }
  await t.test('first upgraded launch authenticates the NSIS installer cache as its next baseline', async () => {
    mode = 'installed';
    const updater = make('installed');
    const helper = await updater.getOrCreateDownloadHelper();
    fs.mkdirSync(helper.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(helper.cacheDir, 'installer.exe'), previous.installer);
    const check = await updater.checkForUpdates();
    assert.equal(check.isUpdateAvailable, false);
    const baselineFile = path.join(helper.cacheDir, differential.BASELINE_NAME);
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(baselineFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(baselineFile), true);
    mode = 'valid'; requests = []; served = 0;
    await updater.checkForUpdates();
    const [file] = await updater.downloadUpdate();
    assert.deepEqual(fs.readFileSync(file), next.installer);
    assert.equal(served, b.length);
    assert.equal(requests.filter(r => r.name === next.info.path && !r.range).length, 0);
  });
  await t.test('reuses old chunks, downloads only changed bytes, and verifies the reconstructed EXE', async () => {
    mode = 'valid';
    const updater = make('valid'), cache = await baseline(updater);
    // A stale updater-library map must never override our authenticated pair.
    fs.writeFileSync(path.join(cache, 'current.blockmap'), 'wrong old version');
    requests = []; served = 0;
    const check = await updater.checkForUpdates();
    assert.equal(check.isUpdateAvailable, true);
    const [file] = await updater.downloadUpdate();
    assert.deepEqual(fs.readFileSync(file), next.installer);
    assert.equal(served, b.length);
    assert.equal(requests.filter(r => r.name === next.info.path && !r.range).length, 0);
    assert.equal(requests.filter(r => r.range).length, 1);
  });
  for (const bad of ['missing-baseline', 'wrong-baseline-version', 'corrupt-baseline-installer', 'corrupt-baseline-map',
    'corrupt-map', 'malformed-map', 'map-redirect', 'range-200', 'wrong-range', 'range-redirect', 'corrupt-range', 'short-range', 'long-range']) {
    await t.test(`${bad} falls back to a verified full installer`, async () => {
      mode = bad;
      const updater = make(bad);
      if (bad !== 'missing-baseline') {
        const cache = await baseline(updater);
        if (bad === 'corrupt-baseline-installer') fs.writeFileSync(path.join(cache, 'installer.exe'), Buffer.alloc(previous.installer.length));
        if (bad === 'wrong-baseline-version') updater.app.version = '1.7.4';
        if (bad === 'corrupt-baseline-map') {
          const file = path.join(cache, differential.BASELINE_NAME), data = JSON.parse(fs.readFileSync(file));
          data.blockmap = Buffer.alloc(previous.blockmap.length).toString('base64'); fs.writeFileSync(file, JSON.stringify(data));
        }
      }
      requests = []; served = 0;
      await updater.checkForUpdates();
      const [file] = await updater.downloadUpdate();
      assert.deepEqual(fs.readFileSync(file), mode === 'malformed-map' ? malformed.installer : next.installer);
      assert.equal(requests.filter(r => r.name === next.info.path && !r.range).length, 1);
      assert.equal(requests.some(r => r.name === 'untrusted'), false);
    });
  }
  await t.test('cancelled differential never starts full fallback and can retry', async () => {
    mode = 'cancel';
    const updater = make('cancel'); await baseline(updater); await updater.checkForUpdates();
    const token = new CancellationToken(); cancelAfterRange = () => token.cancel(); requests = [];
    await assert.rejects(updater.downloadUpdate(token), /cancel/i);
    assert.equal(requests.some(r => r.name === next.info.path && !r.range), false);
    assert.deepEqual(fs.readdirSync(updater.downloadedUpdateHelper.cacheDirForPendingUpdate), []);
    mode = 'valid'; cancelAfterRange = null;
    const [file] = await updater.downloadUpdate(); assert.deepEqual(fs.readFileSync(file), next.installer);
  });
  await t.test('same-process corrupt pending cache is discarded and downloaded again', async () => {
    mode = 'valid';
    const updater = make('cache'); await baseline(updater); await updater.checkForUpdates();
    const [file] = await updater.downloadUpdate();
    fs.writeFileSync(file, Buffer.alloc(next.installer.length)); requests = [];
    const [retry] = await updater.downloadUpdate();
    assert.deepEqual(fs.readFileSync(retry), next.installer);
    assert.equal(requests.filter(r => r.range).length, 1);
  });
  await t.test('download event spread reuses its authenticated map for offline install preparation', async () => {
    mode = 'valid';
    const updater = make('offline-preparation'); await baseline(updater); await updater.checkForUpdates();
    let downloadedInfo;
    updater.on('update-downloaded', info => { downloadedInfo = info; });
    const [file] = await updater.downloadUpdate();
    mode = 'map-redirect'; requests = [];
    assert.equal(await differential.prepareDifferentialBaseline(updater, file, downloadedInfo, api), true);
    assert.equal(requests.length, 0);
  });
});

test('signed blockmap metadata rejects paths, sizes and post-authentication mutations', () => {
  const valid = release('1.7.6', [Buffer.alloc(1024)]);
  for (const changes of [{ path: '../evil.blockmap' }, { path: 'https://evil.example/map' }, { size: 0 }, { size: api.MAX_BLOCKMAP_BYTES + 1 }, { sha512: 'invalid' }]) {
    const raw = Buffer.from(JSON.stringify({ ...valid.info, blockmap: { ...valid.info.blockmap, ...changes } }));
    assert.throws(() => api.verifySignedManifest(raw, createManifestSignature(raw, key.privateKey)), /blockmap|SHA512/);
  }
  const info = api.verifySignedManifest(valid.raw, valid.signature);
  info.blockmap.path = 'changed';
  assert.throws(() => api.authenticatedRelease(info), /modified/);
});
