'use strict';

// This authenticates release metadata with an offline release key. It is not
// Windows Authenticode signing: Windows may still flag an unsigned installer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const { TextDecoder } = require('node:util');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  CancellationError, DigestTransform, configureRequestUrl, configureRequestOptions
} = require('builder-util-runtime');
const { ProgressCallbackTransform } = require('builder-util-runtime/out/ProgressCallbackTransform');
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
const { getChannelFilename, newUrlFromBase } = require('electron-updater/out/util');
const defaultTrust = require('./update-trust.json');

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;
const SIGNATURE_CONTEXT = Buffer.from('VDS update manifest v1\0', 'utf8');
const authenticated = Symbol('VDS authenticated update');
const authenticatedRecords = new WeakSet();
const signedExecutors = new WeakMap();

function fail(message) {
  const error = new Error(`Update integrity: ${message}`);
  error.code = 'ERR_VDS_UPDATE_INTEGRITY';
  throw error;
}

function httpsUrl(value) {
  let result;
  try { result = new URL(value); } catch { return fail('invalid update URL'); }
  if (result.protocol !== 'https:' || result.username || result.password || result.hash) {
    fail('an HTTPS update URL without credentials or fragment is required');
  }
  return result;
}

function publicKeyId(publicKey) {
  const key = publicKey instanceof crypto.KeyObject && publicKey.type === 'public'
    ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') fail('release key must be Ed25519');
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

function signaturePayload(rawManifest) {
  return Buffer.concat([SIGNATURE_CONTEXT, rawManifest]);
}

function checkedBuffer(value, limit, name) {
  const result = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (result.length === 0 || result.length > limit) fail(`${name} exceeds its size limit or is empty`);
  return result;
}

function decodeUtf8(value, name) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { return fail(`${name} is not valid UTF-8`); }
}

function sha512Value(value) {
  if (typeof value !== 'string' || value.length !== 88) fail('invalid SHA512 checksum');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== value) fail('invalid SHA512 checksum');
  return value;
}

function validateManifestInfo(info, baseUrl) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) fail('invalid manifest');
  if (typeof info.version !== 'string' || info.version.length > 64 ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.version)) fail('invalid release version');
  const installerName = `VDS-Setup-${info.version}.exe`;
  // VDS ships a complete NSIS installer, never a web installer or another file
  // selected by remote metadata. All manifest fields, including these, are signed.
  if (info.packages != null) fail('web installer packages are not supported');
  if (info.path !== installerName || !Array.isArray(info.files) || info.files.length !== 1) {
    fail('exactly one matching VDS NSIS installer is required');
  }
  const file = info.files[0];
  if (!file || file.url !== installerName || !Number.isSafeInteger(file.size) || file.size <= 0) {
    fail('invalid installer path or size');
  }
  sha512Value(file.sha512);
  if (info.sha512 !== file.sha512 || (info.size != null && info.size !== file.size) || file.sha2 != null) {
    fail('installer checksums or sizes disagree');
  }
  if (baseUrl != null) {
    const base = httpsUrl(baseUrl);
    const url = httpsUrl(new URL(file.url, base).href);
    if (url.origin !== base.origin) fail('installer must use the authenticated update origin');
  }
  return { version: info.version, path: installerName, size: file.size, sha512: file.sha512 };
}

function manifestFingerprint(info) {
  try { return JSON.stringify(info); } catch { return fail('manifest cannot be serialized'); }
}

function verifySignedManifest(rawManifest, rawSignature, options = {}) {
  const manifest = checkedBuffer(rawManifest, MAX_MANIFEST_BYTES, 'manifest');
  const sidecar = checkedBuffer(rawSignature, MAX_SIGNATURE_BYTES, 'signature');
  let envelope;
  try { envelope = JSON.parse(decodeUtf8(sidecar, 'signature')); }
  catch { return fail('invalid signature envelope'); }
  const trust = options.trust || defaultTrust;
  if (!envelope || envelope.format !== 1 || envelope.algorithm !== 'Ed25519' ||
      typeof envelope.keyId !== 'string' || typeof envelope.signature !== 'string' ||
      envelope.signature.length !== 88 || !trust || trust.format !== 1 || !Array.isArray(trust.keys)) {
    fail('invalid signature envelope or trust configuration');
  }
  const trusted = trust.keys.find((entry) => entry.keyId === envelope.keyId);
  if (!trusted || publicKeyId(trusted.publicKey) !== envelope.keyId) fail('release key is not trusted');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature ||
      !crypto.verify(null, signaturePayload(manifest), trusted.publicKey, signature)) {
    fail('manifest signature does not match');
  }
  const info = parseUpdateInfo(decodeUtf8(manifest, 'manifest'), 'latest.yml', options.baseUrl || 'offline release');
  const expected = validateManifestInfo(info, options.baseUrl);
  const record = Object.freeze({ ...expected, fingerprint: manifestFingerprint(info) });
  authenticatedRecords.add(record);
  // electron-updater spreads updateInfo when emitting update-downloaded. An
  // enumerable private Symbol preserves the authenticated identity through it,
  // without allowing disk JSON/cache contents to assert their own trust.
  Object.defineProperty(info, authenticated, { value: record, enumerable: true });
  return info;
}

function requireAuthenticatedInfo(info) {
  const record = info && info[authenticated];
  if (!record || !authenticatedRecords.has(record)) fail('metadata was not authenticated by this process');
  // update-downloaded adds its local filename; every actual metadata field must
  // remain identical to the data authenticated before update-available/download.
  const { downloadedFile: _downloadedFile, ...manifest } = info;
  if (manifestFingerprint(manifest) !== record.fingerprint) fail('authenticated metadata was modified');
  return record;
}

function signedDownloadExecutor(executor) {
  if (!executor || typeof executor.createRequest !== 'function') fail('update HTTP executor is unavailable');
  if (signedExecutors.has(executor)) return executor;
  const records = new Map();
  const guarded = Object.create(executor);
  signedExecutors.set(guarded, records);
  guarded.download = async (url, destination, options) => {
    const target = httpsUrl(url.href || url);
    const record = records.get(target.href);
    if (!record || options.sha512 !== record.sha512 || options.sha2 != null) {
      fail('installer download does not match authenticated metadata');
    }
    const token = options.cancellationToken;
    if (token.cancelled) throw new CancellationError();
    let request;
    let response;
    let output;
    let failure;
    let rejectResponse;
    const stop = (error) => {
      failure ||= error;
      rejectResponse?.(failure);
      response?.destroy(failure);
      request?.abort();
    };
    const cancel = () => stop(new CancellationError());
    token.onCancel(cancel);
    try {
      response = await new Promise((resolve, reject) => {
        rejectResponse = reject;
        const requestOptions = { headers: { ...options.headers, 'accept-encoding': 'identity' }, redirect: 'manual' };
        configureRequestUrl(target, requestOptions);
        configureRequestOptions(requestOptions);
        request = executor.createRequest(requestOptions, (incoming) => {
          response = incoming;
          incoming.on('error', () => {}); // pipeline owns rejection after headers.
          const contentLength = incoming.headers['content-length'];
          const length = Array.isArray(contentLength) ? contentLength[0] : contentLength;
          const encoding = incoming.headers['content-encoding'];
          if (incoming.statusCode !== 200 || incoming.headers.location != null ||
              (encoding && encoding !== 'identity') ||
              (length != null && (!/^\d+$/.test(length) || Number(length) !== record.size))) {
            stop(new Error('Update integrity: installer response must be HTTPS 200 with its signed size and no redirect'));
            return;
          }
          resolve(incoming);
        });
        // Electron emits redirects separately; Node presents their HTTP response.
        // The fixed NAS feed needs neither, so reject both before any second hop.
        request.once('redirect', () => stop(new Error('Update integrity: installer redirects are not allowed')));
        executor.addErrorAndTimeoutHandlers(request, stop, requestOptions.timeout);
        if (token.cancelled) cancel();
        else request.end();
      });
      if (failure) throw failure;
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > record.size) {
            failure ||= new Error('Update integrity: installer exceeds its signed size');
            callback(failure);
          } else callback(null, chunk);
        },
        flush(callback) {
          if (received !== record.size) failure ||= new Error('Update integrity: installer is shorter than its signed size');
          callback(failure || null);
        }
      });
      const streams = [response, limit];
      if (options.onProgress) streams.push(new ProgressCallbackTransform(record.size, token, options.onProgress));
      streams.push(new DigestTransform(record.sha512));
      output = fs.createWriteStream(destination);
      streams.push(output);
      await pipeline(...streams);
      if (failure || token.cancelled) throw failure || new CancellationError();
      return destination;
    } catch (error) {
      stop(failure || error);
      // pipeline waits for its writable to close before rejecting. Failures
      // before pipeline created a file require no disk cleanup.
      if (output) await fs.promises.unlink(destination).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      throw failure || error;
    } finally {
      token.removeListener('cancel', cancel);
    }
  };
  return guarded;
}

async function verifyDownloadedUpdate(filePath, info) {
  const record = requireAuthenticatedInfo(info);
  if (typeof filePath !== 'string' || !filePath) fail('downloaded installer path is missing');
  const file = await fs.promises.open(filePath, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== record.size) fail('downloaded installer size does not match');
    const hash = crypto.createHash('sha512');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > record.size) fail('downloaded installer exceeds its signed size');
      hash.update(chunk);
    }
    const after = await file.stat();
    if (size !== record.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        hash.digest('base64') !== record.sha512) fail('downloaded installer checksum does not match');
    return { version: record.version, size: record.size, sha512: record.sha512 };
  } finally { await file.close(); }
}

function readBoundedHttps(url, limit, headers) {
  const target = httpsUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(target, {
      headers: { ...headers, 'accept-encoding': 'identity' },
      rejectUnauthorized: true
    }, (response) => {
      if (response.statusCode !== 200 ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy();
        reject(new Error('Update integrity: metadata HTTPS response must be an unencoded 200 response'));
        return;
      }
      const declaredLength = response.headers['content-length'];
      if (declaredLength != null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)) {
        response.destroy();
        reject(new Error('Update integrity: metadata exceeds its size limit'));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > limit) {
          request.destroy(new Error('Update integrity: metadata exceeds its size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Update integrity: metadata response was interrupted')));
      response.once('end', () => resolve(Buffer.concat(chunks, received)));
    });
    const deadline = setTimeout(() => request.destroy(new Error('Update integrity: metadata request timed out')), 20000);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject);
  });
}

class SignedGenericProvider extends GenericProvider {
  constructor(configuration, updater, runtimeOptions) {
    const executor = signedDownloadExecutor(runtimeOptions.executor);
    super(configuration, updater, { ...runtimeOptions, executor, isUseMultipleRangeRequest: false });
    updater.httpExecutor = executor;
    httpsUrl(this.baseUrl.href);
  }

  async getLatestVersion() {
    const channelFile = getChannelFilename(this.channel);
    if (channelFile !== 'latest.yml') fail('unsupported update channel');
    const manifestUrl = newUrlFromBase(channelFile, this.baseUrl, this.updater.isAddNoCacheQuery);
    const signatureUrl = new URL(manifestUrl.href);
    signatureUrl.pathname += '.sig';
    const reads = await Promise.allSettled([
      readBoundedHttps(manifestUrl.href, MAX_MANIFEST_BYTES, this.requestHeaders),
      readBoundedHttps(signatureUrl.href, MAX_SIGNATURE_BYTES, this.requestHeaders)
    ]);
    for (const read of reads) if (read.status === 'rejected') throw read.reason;
    const [manifest, signature] = reads.map((read) => read.value);
    return verifySignedManifest(manifest, signature, { baseUrl: this.baseUrl.href });
  }

  resolveFiles(info) {
    const record = requireAuthenticatedInfo(info);
    const files = super.resolveFiles(info);
    for (const file of files) {
      const url = httpsUrl(file.url.href);
      if (url.origin !== this.baseUrl.origin) fail('installer uses an unexpected update origin');
      signedExecutors.get(this.executor).set(url.href, record);
    }
    return files;
  }
}

function createSignedUpdateFeedOptions(feedUrl) {
  const url = httpsUrl(feedUrl);
  if (url.search) fail('update feed URL must not contain a query');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { provider: 'custom', updateProvider: SignedGenericProvider, url: url.href, useMultipleRangeRequest: false };
}

module.exports = {
  createSignedUpdateFeedOptions, verifyDownloadedUpdate, verifySignedManifest,
  publicKeyId, signaturePayload, MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES
};
