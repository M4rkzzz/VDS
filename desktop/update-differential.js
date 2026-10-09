'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const { CancellationError, CURRENT_APP_INSTALLER_FILE_NAME } = require('builder-util-runtime');
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');
const integrity = require('./update-integrity');

const BASELINE_NAME = 'vds-differential-baseline.json';
const MAX_BASELINE_BYTES = 3 * 1024 * 1024;
const installed = new WeakSet();
const blockmaps = new WeakMap();
const baselineWrites = new WeakMap();

function checkCancelled(token) {
  if (token?.cancelled) throw new CancellationError();
}

async function responseFor(url, headers, token, validate) {
  checkCancelled(token);
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
    throw new Error('Differential update requires HTTPS without credentials');
  }
  let request, response, timer;
  const cancel = () => request?.destroy(new CancellationError());
  const dispose = () => {
    clearTimeout(timer);
    token?.removeListener('cancel', cancel);
    response?.destroy();
    request?.destroy();
  };
  try {
    response = await new Promise((resolve, reject) => {
      request = https.get(target, { headers: { ...headers, 'accept-encoding': 'identity' }, rejectUnauthorized: true }, incoming => {
        incoming.on('error', () => {});
        response = incoming;
        try {
          if (incoming.headers.location || (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity')) {
            throw new Error('Differential update redirects or encoded responses are unsupported');
          }
          validate(incoming);
          resolve(incoming);
        } catch (error) { incoming.destroy(); reject(error); }
      });
      request.on('error', reject);
      timer = setTimeout(() => request.destroy(new Error('Differential update request timed out')), 20000);
      token?.onCancel(cancel);
      if (token?.cancelled) cancel();
    });
    return { response, dispose };
  } catch (error) { dispose(); throw error; }
}

function parseBlockmap(bytes, record) {
  const expected = record.blockmap;
  if (!expected || bytes.length !== expected.size ||
      crypto.createHash('sha512').update(bytes).digest('base64') !== expected.sha512) {
    throw new Error('Signed blockmap checksum or size mismatch');
  }
  const map = JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'));
  if (map.version !== '2' || !Array.isArray(map.files) || map.files.length !== 1) throw new Error('Unsupported blockmap layout');
  const file = map.files[0];
  if (file.name !== 'file' || file.offset !== 0 || !Array.isArray(file.sizes) || !Array.isArray(file.checksums) ||
      !file.sizes.length || file.sizes.length !== file.checksums.length) throw new Error('Invalid blockmap layout');
  let size = 0;
  for (let i = 0; i < file.sizes.length; i++) {
    if (!Number.isSafeInteger(file.sizes[i]) || file.sizes[i] <= 0 ||
        typeof file.checksums[i] !== 'string' || !/^[A-Za-z0-9+/]{24}$/.test(file.checksums[i])) {
      throw new Error('Invalid blockmap block');
    }
    size += file.sizes[i];
    if (!Number.isSafeInteger(size) || size > record.size) throw new Error('Blockmap exceeds signed installer size');
  }
  if (size !== record.size) throw new Error('Blockmap does not cover signed installer');
  return map;
}

async function readBlockmap(info, token, headers, api = integrity) {
  const record = api.authenticatedRelease(info);
  if (!record.blockmap || !record.baseUrl) throw new Error('Release has no authenticated blockmap');
  if (blockmaps.has(record.identity)) return blockmaps.get(record.identity);
  const { response, dispose } = await responseFor(new URL(record.blockmap.path, record.baseUrl), headers, token, incoming => {
    if (incoming.statusCode !== 200 || (incoming.headers['content-length'] != null &&
        incoming.headers['content-length'] !== String(record.blockmap.size))) throw new Error('Invalid blockmap response');
  });
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      checkCancelled(token);
      size += chunk.length;
      if (size > record.blockmap.size) throw new Error('Blockmap exceeds signed size');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    const result = { bytes, map: parseBlockmap(bytes, record) };
    blockmaps.set(record.identity, result);
    return result;
  } finally { dispose(); }
}

async function readBaseline(cacheDir, currentVersion, api) {
  const file = path.join(cacheDir, BASELINE_NAME);
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_BASELINE_BYTES) throw new Error('Invalid baseline size');
  const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  if (data.format !== 1 || typeof data.manifest !== 'string' || typeof data.signature !== 'string' || typeof data.blockmap !== 'string') {
    throw new Error('Invalid baseline metadata');
  }
  const info = api.verifySignedManifest(Buffer.from(data.manifest, 'base64'), Buffer.from(data.signature, 'base64'));
  if (info.version !== currentVersion) throw new Error('Baseline does not match installed version');
  const record = api.authenticatedRelease(info);
  const map = parseBlockmap(Buffer.from(data.blockmap, 'base64'), record);
  const installer = path.join(cacheDir, CURRENT_APP_INSTALLER_FILE_NAME);
  await api.verifyDownloadedUpdate(installer, info);
  return { installer, map, record };
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Installer write made no progress');
    offset += bytesWritten;
  }
}

async function downloadDifferential(updater, fileInfo, options, destination, api = integrity) {
  const info = options.updateInfoAndProvider.info;
  const record = api.authenticatedRelease(info);
  const helper = await updater.getOrCreateDownloadHelper();
  const baseline = await readBaseline(helper.cacheDir, updater.app.version, api);
  const token = options.cancellationToken;
  checkCancelled(token);
  const next = await readBlockmap(info, token, options.requestHeaders, api);
  const logger = updater._logger;
  const operations = computeOperations(baseline.map, next.map, logger);
  let total = 0, networkBytes = 0;
  for (const op of operations) {
    const limit = op.kind === OperationKind.COPY ? baseline.record.size : record.size;
    if (![OperationKind.COPY, OperationKind.DOWNLOAD].includes(op.kind) || !Number.isSafeInteger(op.start) ||
        !Number.isSafeInteger(op.end) || op.start < 0 || op.end <= op.start || op.end > limit) throw new Error('Invalid differential range');
    total += op.end - op.start;
    if (op.kind === OperationKind.DOWNLOAD) networkBytes += op.end - op.start;
  }
  if (total !== record.size || networkBytes >= record.size) throw new Error('Differential plan has no reusable baseline');
  const expectedUrl = new URL(record.path, record.baseUrl);
  if (fileInfo.url.href !== expectedUrl.href) throw new Error('Differential URL differs from signed installer');
  logger.info(`Authenticated differential: ${baseline.record.version} -> ${record.version}, network=${networkBytes}, full=${record.size}`);
  const oldFile = await fs.promises.open(baseline.installer, 'r');
  let output;
  const hash = crypto.createHash('sha512');
  const scratch = Buffer.allocUnsafe(512 * 1024);
  let transferred = 0;
  const started = Date.now();
  const write = async chunk => { hash.update(chunk); await writeAll(output, chunk); };
  try {
    output = await fs.promises.open(destination, 'w');
    for (const op of operations) {
      checkCancelled(token);
      if (op.kind === OperationKind.COPY) {
        for (let offset = op.start; offset < op.end;) {
          checkCancelled(token);
          const { bytesRead } = await oldFile.read(scratch, 0, Math.min(scratch.length, op.end - offset), offset);
          if (!bytesRead) throw new Error('Baseline was truncated during copy');
          await write(scratch.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } else {
        const length = op.end - op.start;
        const range = `bytes=${op.start}-${op.end - 1}`;
        const { response, dispose } = await responseFor(expectedUrl, { ...options.requestHeaders, range }, token, incoming => {
          if (incoming.statusCode !== 206 || incoming.headers['content-range'] !== `bytes ${op.start}-${op.end - 1}/${record.size}` ||
              (incoming.headers['content-length'] != null && incoming.headers['content-length'] !== String(length))) throw new Error('Invalid differential Range response');
        });
        try {
          let received = 0;
          for await (const chunk of response) {
            checkCancelled(token);
            received += chunk.length;
            if (received > length) throw new Error('Range exceeds requested size');
            await write(chunk);
            transferred += chunk.length;
            updater.emit('download-progress', { total: networkBytes, transferred, percent: transferred / networkBytes * 100,
              bytesPerSecond: transferred / Math.max(0.001, (Date.now() - started) / 1000) });
          }
          if (received !== length) throw new Error('Range response was truncated');
        } finally { dispose(); }
      }
    }
    checkCancelled(token);
    if (hash.digest('base64') !== record.sha512 || (await output.stat()).size !== record.size) throw new Error('Reconstructed installer checksum mismatch');
    logger.info(`Authenticated differential completed: downloaded=${transferred}, reused=${record.size - transferred}`);
  } finally { await output?.close(); await oldFile.close(); }
}

async function writeDifferentialBaseline(updater, filePath, info, api) {
  const record = api.authenticatedRelease(info);
  if (!record.blockmap) return false;
  const helper = await updater.getOrCreateDownloadHelper();
  await api.verifyDownloadedUpdate(filePath, info);
  const { bytes } = await readBlockmap(info, null, updater.requestHeaders, api);
  await fs.promises.mkdir(helper.cacheDir, { recursive: true });
  const installer = path.join(helper.cacheDir, CURRENT_APP_INSTALLER_FILE_NAME);
  const temporary = `${installer}.${crypto.randomUUID()}.tmp`;
  const baselineFile = path.join(helper.cacheDir, BASELINE_NAME);
  const metadataTemporary = `${baselineFile}.${crypto.randomUUID()}.tmp`;
  try {
    if (path.resolve(filePath) !== path.resolve(installer)) {
      await fs.promises.copyFile(filePath, temporary);
      await api.verifyDownloadedUpdate(temporary, info);
      await fs.promises.rename(temporary, installer);
    }
    const data = { format: 1, manifest: record.rawManifest.toString('base64'), signature: record.rawSignature.toString('base64'), blockmap: bytes.toString('base64') };
    await fs.promises.writeFile(metadataTemporary, JSON.stringify(data), { flag: 'wx' });
    await fs.promises.rename(metadataTemporary, baselineFile);
    return true;
  } finally {
    for (const file of [temporary, metadataTemporary]) await fs.promises.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function prepareDifferentialBaseline(updater, filePath, info, api = integrity) {
  const previous = baselineWrites.get(updater) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeDifferentialBaseline(updater, filePath, info, api));
  baselineWrites.set(updater, pending);
  try { return await pending; }
  finally { if (baselineWrites.get(updater) === pending) baselineWrites.delete(updater); }
}

function configureDifferentialUpdates(updater, api = integrity) {
  if (installed.has(updater)) return;
  installed.add(updater);
  updater.disableDifferentialDownload = false;
  const originalHelper = updater.getOrCreateDownloadHelper?.bind(updater);
  if (originalHelper) updater.getOrCreateDownloadHelper = async () => {
    const helper = await originalHelper();
    if (!installed.has(helper)) {
      installed.add(helper);
      const validate = helper.validateDownloadedPath.bind(helper);
      helper.validateDownloadedPath = async (file, info, fileInfo, logger) => {
        const result = await validate(file, info, fileInfo, logger);
        if (!result) return result;
        try { await api.verifyDownloadedUpdate(result, info); return result; }
        catch (error) { logger.warn(`Discarding invalid update cache: ${error.message}`); await helper.clear(); return null; }
      };
    }
    return helper;
  };
  updater.differentialDownloadInstaller = async (fileInfo, options, destination) => {
    try { await downloadDifferential(updater, fileInfo, options, destination, api); return false; }
    catch (error) {
      await fs.promises.unlink(destination).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (options.cancellationToken.cancelled || error instanceof CancellationError) throw new CancellationError();
      updater._logger.warn(`Authenticated differential unavailable; falling back to full download: ${error.message}`);
      return true;
    }
  };
  updater.on('update-not-available', async info => {
    if (info.version !== updater.app?.version) return;
    try {
      const helper = await updater.getOrCreateDownloadHelper();
      await readBaseline(helper.cacheDir, updater.app.version, api);
    } catch {
      try {
        const helper = await updater.getOrCreateDownloadHelper();
        await prepareDifferentialBaseline(updater, path.join(helper.cacheDir, CURRENT_APP_INSTALLER_FILE_NAME), info, api);
      } catch (error) { updater._logger.warn(`Installed differential baseline not yet available: ${error.message}`); }
    }
  });
}

module.exports = { configureDifferentialUpdates, prepareDifferentialBaseline, parseBlockmap, BASELINE_NAME };
