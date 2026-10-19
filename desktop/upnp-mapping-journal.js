const fs = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
const { randomBytes } = require('node:crypto');

const ID = /^VDS-[a-f0-9]{16}$/;
const RECORD_FILE = /^(VDS-[a-f0-9]{16})(?:\.recover-(\d+)-[a-f0-9]{16})?\.json$/;
const CLAIM_LOCK = Symbol('upnp-claim-lock');
let windowsFiles;
function lockRecovery(file) {
  if (process.platform !== 'win32') return () => {};
  if (!windowsFiles) {
    const kernel = require('koffi').load('kernel32.dll');
    windowsFiles = {
      open: kernel.func('void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)'),
      close: kernel.func('int __stdcall CloseHandle(void *)'),
      error: kernel.func('uint32 __stdcall GetLastError()'),
      address: require('koffi').address
    };
  }
  // Windows rename may succeed twice when concurrent calls already opened the
  // source. A no-sharing handle serializes recovery across processes instead.
  // DELETE_ON_CLOSE removes the lock even when the process exits abruptly.
  const handle = windowsFiles.open(file, 0xc0010000, 0, null, 4, 0x04000080, null);
  const error = windowsFiles.error();
  if (!handle || BigInt.asIntN(64, windowsFiles.address(handle)) === -1n) {
    if (error === 32 || error === 33) return null;
    throw new Error(`upnp-journal-lock-failed:${error}`);
  }
  return () => windowsFiles.close(handle);
}
function validate(record) {
  const port = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
  if (!record || record.version !== 1 || !ID.test(record.description) || !Number.isInteger(record.pid) || record.pid <= 0 ||
      (record.transport !== undefined && !['udp', 'tcp'].includes(record.transport)) ||
      !port(record.internalPort) || !port(record.externalPort) || isIP(record.localAddress) !== 4 || isIP(record.gateway) !== 4 ||
      !/^urn:schemas-upnp-org:service:(WANIPConnection:[12]|WANPPPConnection:1)$/.test(record.serviceType)) {
    throw new Error('upnp-journal-invalid-record');
  }
  const url = new URL(record.controlUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== record.gateway || url.username || url.password || url.hash) {
    throw new Error('upnp-journal-invalid-url');
  }
  return record;
}
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// One atomically replaced file per mapping avoids a shared JSON read/modify/write
// race when multiple VDS instances use the same profile. Never record media data.
class UpnpMappingJournal {
  constructor({ directory, isAlive = isProcessAlive, onError = () => {} }) {
    this.directory = directory;
    this.isAlive = isAlive;
    this.onError = onError;
    this.saved = new Map();
  }

  root() { return typeof this.directory === 'function' ? this.directory() : this.directory; }
  filename(description) {
    if (!ID.test(description)) throw new Error('upnp-journal-invalid-id');
    return path.join(this.root(), `${description}.json`);
  }

  async remember(details) {
    const record = validate({ ...details, version: 1, pid: process.pid });
    const content = JSON.stringify(record);
    if (this.saved.get(record.description) === content) return;
    const file = this.filename(record.description);
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.mkdir(this.root(), { recursive: true });
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, file);
      this.saved.set(record.description, content);
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') this.onError(error); });
    }
  }

  async forget(description) {
    await fs.unlink(this.filename(description)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    this.saved.delete(description);
  }

  async orphans() {
    const files = await fs.readdir(this.root(), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records = [];
    for (const file of files) {
      const match = file.name.match(RECORD_FILE);
      if (!file.isFile() || !match || (match[2] && this.isAlive(Number(match[2])))) continue;
      try {
        const filename = path.join(this.root(), file.name);
        const info = await fs.stat(filename);
        if (info.size > 16384) throw new Error('upnp-journal-record-too-large');
        const record = validate(JSON.parse(await fs.readFile(filename, 'utf8')));
        if (match[1] !== record.description) throw new Error('upnp-journal-id-mismatch');
        // A reused or inaccessible PID is conservatively considered live. It
        // is preferable to defer cleanup to a later launch than touch a live peer.
        if (!this.isAlive(record.pid)) records.push({ ...record, journalFile: file.name });
      } catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
    }
    return records;
  }

  async claim(record) {
    const source = record.journalFile || `${record.description}.json`;
    const match = source.match(RECORD_FILE);
    if (!match || match[1] !== record.description || this.isAlive(record.pid)) return null;
    if (match[2] && this.isAlive(Number(match[2]))) return null;
    const unlock = lockRecovery(path.join(this.root(), `${record.description}.lock`));
    if (!unlock) return null;
    const target = `${record.description}.recover-${process.pid}-${randomBytes(8).toString('hex')}.json`;
    try { await fs.rename(path.join(this.root(), source), path.join(this.root(), target)); }
    catch (error) { unlock(); if (error.code === 'ENOENT') return null; throw error; }
    return { ...record, journalFile: target, [CLAIM_LOCK]: unlock };
  }

  async finishClaim(record, retry = false) {
    const match = record.journalFile?.match(RECORD_FILE);
    if (!match || match[1] !== record.description || Number(match[2]) !== process.pid) throw new Error('upnp-journal-invalid-claim');
    const file = path.join(this.root(), record.journalFile);
    try {
      if (retry) await fs.rename(file, this.filename(record.description));
      else await fs.unlink(file);
      this.saved.delete(record.description);
    } finally {
      record[CLAIM_LOCK]?.();
      record[CLAIM_LOCK] = null;
    }
  }
}

module.exports = { UpnpMappingJournal };
