'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { test } = require('node:test');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { createManifestSignature } = require('../../scripts/update-signature');
const { publicKeyId } = require('../../desktop/update-integrity');
const tlsIdentity = require('../fixtures/update-https.json');

const key = crypto.generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
const trust = { format: 1, keys: [{ keyId: publicKeyId(publicKey), publicKey }] };
// Only the bundled public trust configuration is replaced for this isolated
// module instance. The production verifier, TLS reads, GenericProvider and
// NsisUpdater are real. Tests never need the actual offline release private key.
const modulePath = require.resolve('../../desktop/update-integrity');
const localRequire = Module.createRequire(modulePath);
const isolated = { exports: {} };
vm.runInThisContext(Module.wrap(fs.readFileSync(modulePath, 'utf8')), { filename: modulePath })(
  isolated.exports,
  (name) => name === './update-trust.json' ? trust : localRequire(name),
  isolated, modulePath, path.dirname(modulePath)
);
const integrity = isolated.exports;
const installer = Buffer.from(`MZ${'public regression fixture\n'.repeat(4096)}`);

function metadata(overrides = {}) {
  const hash = crypto.createHash('sha512').update(installer).digest('base64');
  return {
    version: '1.7.3',
    files: [{ url: 'VDS-Setup-1.7.3.exe', sha512: hash, size: installer.length }],
    path: 'VDS-Setup-1.7.3.exe', sha512: hash,
    releaseDate: '2026-10-08T00:00:00.000Z',
    ...overrides
  };
}

function signed(info = metadata(), privateKey = key.privateKey) {
  const raw = Buffer.from(JSON.stringify(info));
  return { raw, signature: createManifestSignature(raw, privateKey) };
}

function authenticate(data = signed()) {
  return integrity.verifySignedManifest(data.raw, data.signature, { baseUrl: 'https://updates.example/updates/' });
}

test('signed metadata authenticates exact bytes and survives updater event spread', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-update-integrity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'VDS-Setup-1.7.3.exe');
  fs.writeFileSync(file, installer);
  const info = authenticate();
  const event = { ...info, downloadedFile: file };
  const result = await integrity.verifyDownloadedUpdate(file, event);
  assert.equal(result.version, '1.7.3');
  assert.equal(result.size, installer.length);
});

test('changed raw metadata, a substituted signing key, and missing signature fail', () => {
  const data = signed();
  assert.throws(() => authenticate({ ...data, raw: Buffer.concat([data.raw, Buffer.from('\n')]) }), /signature does not match/);
  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => authenticate(signed(metadata(), other.privateKey)), /key is not trusted/);
  assert.throws(() => authenticate({ ...data, signature: Buffer.alloc(0) }), /size limit or is empty/);
  assert.throws(() => authenticate({ ...data, signature: Buffer.from('{}') }), /invalid signature/);
});

test('invalid signature encoding and signature-only replay over another manifest fail', () => {
  const data = signed();
  const envelope = JSON.parse(data.signature);
  envelope.signature = '!'.repeat(88);
  assert.throws(() => authenticate({ ...data, signature: Buffer.from(JSON.stringify(envelope)) }), /signature does not match/);
  const changed = signed(metadata({ releaseDate: '2026-10-09T00:00:00.000Z' }));
  assert.throws(() => authenticate({ raw: changed.raw, signature: data.signature }), /signature does not match/);
});

test('manifest and sidecar have independent pre-parse size limits', () => {
  const data = signed();
  assert.throws(() => authenticate({ ...data, raw: Buffer.alloc(integrity.MAX_MANIFEST_BYTES + 1) }), /size limit/);
  assert.throws(() => authenticate({ ...data, signature: Buffer.alloc(integrity.MAX_SIGNATURE_BYTES + 1) }), /size limit/);
});

test('signed installer URL, top-level hash and file hash must all agree', () => {
  for (const url of ['http://updates.example/evil.exe', 'https://evil.example/VDS-Setup-1.7.3.exe', '../VDS-Setup-1.7.3.exe']) {
    const info = metadata();
    info.files[0].url = url;
    assert.throws(() => authenticate(signed(info)), /installer path or size/);
  }
  assert.throws(() => authenticate(signed(metadata({ sha512: 'A'.repeat(88) }))), /checksums or sizes disagree/);
  const malformed = metadata();
  malformed.files[0].sha512 = 'A'.repeat(88);
  assert.throws(() => authenticate(signed(malformed)), /invalid SHA512/);
});

test('signed invalid size and unsupported packages cannot select alternate executable paths', () => {
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
    const info = metadata();
    info.files[0].size = size;
    assert.throws(() => authenticate(signed(info)), /installer path or size/);
  }
  assert.throws(() => authenticate(signed(metadata({ packages: { x64: { path: 'evil.7z' } } }))), /packages are not supported/);
  const original = signed();
  const tampered = Buffer.from(JSON.stringify(metadata({ packages: { x64: { path: 'evil.7z' } } })));
  assert.throws(() => authenticate({ raw: tampered, signature: original.signature }), /signature does not match/);
});

test('download verification rejects changed bytes, changed size and unauthenticated cache metadata', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-update-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'VDS-Setup-1.7.3.exe');
  const info = authenticate();
  const sameSizeCorruption = Buffer.from(installer);
  sameSizeCorruption[0] ^= 0xff;
  fs.writeFileSync(file, sameSizeCorruption);
  await assert.rejects(integrity.verifyDownloadedUpdate(file, info), /checksum does not match/);
  fs.writeFileSync(file, installer.subarray(1));
  await assert.rejects(integrity.verifyDownloadedUpdate(file, info), /size does not match/);
  fs.writeFileSync(file, installer);
  await assert.rejects(integrity.verifyDownloadedUpdate(file, JSON.parse(JSON.stringify(info))), /not authenticated/);
});

test('authenticated metadata modified after update-available cannot authorize installation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-update-mutation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'VDS-Setup-1.7.3.exe');
  fs.writeFileSync(file, installer);
  const info = authenticate();
  info.files[0].size += 1;
  await assert.rejects(integrity.verifyDownloadedUpdate(file, { ...info, downloadedFile: file }), /metadata was modified/);
});

test('custom update provider accepts HTTPS only and normalizes the base directory', () => {
  const feed = integrity.createSignedUpdateFeedOptions('https://updates.example/updates');
  assert.equal(feed.provider, 'custom');
  assert.equal(feed.url, 'https://updates.example/updates/');
  for (const url of ['http://updates.example/', 'file:///tmp/update', 'https://user:pass@updates.example/', 'https://updates.example/#x', 'https://updates.example/?x=1']) {
    assert.throws(() => integrity.createSignedUpdateFeedOptions(url), /Update integrity/);
  }
});

test('real NsisUpdater verifies signed HTTPS metadata before events and downloads', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-signed-updater-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = tlsIdentity.cert;
  t.after(() => { https.globalAgent.options.ca = originalCa; });
  const data = signed();
  let mode = 'valid';
  let streamingBytes = 0;
  let streamingClosed = false;
  let firstInstallerChunk;
  const requests = [];
  const server = https.createServer(tlsIdentity, (request, response) => {
    const resource = request.url.split('?')[0];
    requests.push(resource);
    if (resource === '/updates/latest.yml') {
      if (mode === 'oversized-manifest') {
        response.writeHead(200, { 'content-length': integrity.MAX_MANIFEST_BYTES + 1 });
        return response.end(Buffer.alloc(integrity.MAX_MANIFEST_BYTES + 1));
      }
      if (mode === 'chunked-oversized') return response.end(Buffer.alloc(integrity.MAX_MANIFEST_BYTES + 1));
      if (mode === 'redirect') {
        response.writeHead(302, { location: 'http://127.0.0.1/unsafe' });
        return response.end();
      }
      return response.end(mode === 'tampered' ? Buffer.concat([data.raw, Buffer.from('\n')]) : data.raw);
    }
    if (resource === '/updates/latest.yml.sig') {
      if (mode === 'missing') { response.writeHead(404); return response.end(); }
      if (mode === 'oversized-sidecar') return response.end(Buffer.alloc(integrity.MAX_SIGNATURE_BYTES + 1));
      if (mode === 'wrong-key') return response.end(signed(metadata(), crypto.generateKeyPairSync('ed25519').privateKey).signature);
      return response.end(data.signature);
    }
    if (resource === '/updates/VDS-Setup-1.7.3.exe') {
      if (mode === 'installer-redirect-http' || mode === 'installer-redirect-https') {
        response.writeHead(302, { location: `${mode.endsWith('http') ? 'http' : 'https'}://127.0.0.1:${server.address().port}/updates/redirected.exe` });
        return response.end();
      }
      if (mode === 'installer-declared-size') {
        response.writeHead(200, { 'content-length': installer.length + 1 });
        return response.end(installer);
      }
      if (mode === 'installer-too-long') {
        response.writeHead(200, { 'transfer-encoding': 'chunked' });
        return response.end(Buffer.concat([installer, Buffer.from('extra')]));
      }
      if (mode === 'installer-too-short') {
        response.writeHead(200, { 'transfer-encoding': 'chunked' });
        return response.end(installer.subarray(1));
      }
      if (mode === 'installer-wrong-hash') {
        const corrupted = Buffer.from(installer);
        corrupted[0] ^= 0xff;
        return response.end(corrupted);
      }
      if (mode === 'installer-infinite' || mode === 'installer-cancel') {
        response.writeHead(200, { 'transfer-encoding': 'chunked' });
        streamingBytes = 0;
        streamingClosed = false;
        const chunk = Buffer.alloc(16 * 1024);
        const timer = setInterval(() => {
          streamingBytes += chunk.length;
          response.write(chunk);
          firstInstallerChunk?.();
          firstInstallerChunk = null;
        }, 2);
        response.once('close', () => {
          clearInterval(timer);
          streamingClosed = true;
        });
        return;
      }
      return response.end(installer);
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const feed = `https://127.0.0.1:${server.address().port}/updates/`;
  const configPath = path.join(directory, 'app-update.yml');
  fs.writeFileSync(configPath, 'updaterCacheDirName: isolated-vds-update-test\n');
  let appQuit = 0;
  function updaterFor(label) {
    const app = {
      version: '1.7.2', name: 'VDS signed updater test', isPackaged: true,
      userDataPath: path.join(directory, label, 'user-data'),
      baseCachePath: path.join(directory, label, 'cache'),
      appUpdateConfigPath: configPath,
      whenReady: async () => {}, quit: () => { appQuit += 1; },
      relaunch: () => { throw new Error('Tests must never relaunch'); },
      onQuit: () => { throw new Error('Tests must never register auto-install'); }
    };
    const updater = new NsisUpdater(null, app);
    updater._testOnlyOptions = { platform: 'win32' };
    updater.httpExecutor = new NodeHttpExecutor();
    // The production signed-size guard uses this executor's real HTTPS request
    // transport, retaining the same cancellation/progress/download pipeline.
    updater.logger = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.disableWebInstaller = true;
    updater.setFeedURL(integrity.createSignedUpdateFeedOptions(feed));
    return updater;
  }
  for (const invalid of ['tampered', 'missing', 'wrong-key', 'oversized-manifest', 'chunked-oversized', 'oversized-sidecar', 'redirect']) {
    await t.test(`rejects ${invalid} before update-available and installer download`, async () => {
      mode = invalid;
      requests.length = 0;
      const updater = updaterFor(invalid);
      let available = 0;
      updater.on('update-available', () => { available += 1; });
      await assert.rejects(updater.checkForUpdates());
      assert.equal(available, 0);
      assert.equal(updater.updateInfoAndProvider, null);
      assert.equal(requests.some((url) => url.endsWith('.exe')), false);
    });
  }
  await t.test('valid feed is fetched once, downloaded with real updater and authenticated after spread', async () => {
    mode = 'valid';
    requests.length = 0;
    const updater = updaterFor('valid');
    let downloaded;
    const progress = [];
    updater.on('update-downloaded', (event) => { downloaded = event; });
    updater.on('download-progress', (event) => progress.push(event));
    const result = await updater.checkForUpdates();
    assert.equal(result.isUpdateAvailable, true);
    assert.equal(result.updateInfo.version, '1.7.3');
    const paths = await updater.downloadUpdate();
    assert.equal(paths.length, 1);
    assert.ok(downloaded);
    await integrity.verifyDownloadedUpdate(downloaded.downloadedFile, downloaded);
    assert.deepEqual(requests.sort(), ['/updates/VDS-Setup-1.7.3.exe', '/updates/latest.yml', '/updates/latest.yml.sig']);
    assert.equal(updater.quitHandlerAdded, false);
    assert.equal(appQuit, 0);
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(progress.at(-1).total, installer.length);
  });
  for (const invalid of ['installer-declared-size', 'installer-too-long', 'installer-too-short', 'installer-wrong-hash', 'installer-redirect-http', 'installer-redirect-https']) {
    await t.test(`rejects ${invalid} during actual download and removes partial files`, async () => {
      mode = invalid;
      requests.length = 0;
      const updater = updaterFor(invalid);
      let downloaded = false;
      updater.on('update-downloaded', () => { downloaded = true; });
      const result = await updater.checkForUpdates();
      assert.equal(result.isUpdateAvailable, true);
      await assert.rejects(updater.downloadUpdate());
      assert.equal(downloaded, false);
      assert.equal(requests.some((url) => url === '/updates/redirected.exe'), false);
      const pending = updater.downloadedUpdateHelper.cacheDirForPendingUpdate;
      assert.deepEqual(fs.readdirSync(pending), []);
    });
  }
  await t.test('unending chunked installer is aborted at its authenticated size without waiting for EOF', { timeout: 5000 }, async () => {
    mode = 'installer-infinite';
    const updater = updaterFor(mode);
    await updater.checkForUpdates();
    await assert.rejects(updater.downloadUpdate(), /exceeds its signed size/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(streamingClosed, true);
    assert.ok(streamingBytes < installer.length + 128 * 1024);
    assert.deepEqual(fs.readdirSync(updater.downloadedUpdateHelper.cacheDirForPendingUpdate), []);
  });
  await t.test('normal updater cancellation aborts the request and removes its partial installer', { timeout: 5000 }, async () => {
    mode = 'installer-cancel';
    const updater = updaterFor(mode);
    const result = await updater.checkForUpdates();
    const firstChunk = new Promise((resolve) => { firstInstallerChunk = resolve; });
    const downloading = updater.downloadUpdate(result.cancellationToken);
    downloading.catch(() => {});
    await firstChunk;
    result.cancellationToken.cancel();
    await assert.rejects(downloading, /cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(streamingClosed, true);
    assert.deepEqual(fs.readdirSync(updater.downloadedUpdateHelper.cacheDirForPendingUpdate), []);
    assert.equal(appQuit, 0);
  });
});
