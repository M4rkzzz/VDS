'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function positiveInteger(value, fallback, name, allowZero = false) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class SessionLogWriter {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.maxFileBytes = positiveInteger(options.maxFileBytes, 8 * 1024 * 1024, 'maxFileBytes');
    this.maxBufferedBytes = positiveInteger(options.maxBufferedBytes, 256 * 1024, 'maxBufferedBytes');
    this.maxSegments = positiveInteger(options.maxSegments, 4, 'maxSegments');
    this.retainedSessions = positiveInteger(options.retainedSessions, 8, 'retainedSessions', true);
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._entries = [];
    this._bufferedBytes = 0;
    this._droppedEntries = 0;
    this._droppedBytes = 0;
    this._fileBytes = 0;
    this._initialized = false;
    this._scheduled = null;
    this._running = null;
    this._closed = false;
    this._closePromise = null;
    this._reportingError = false;
  }

  append(line) {
    if (this._closed || this._reportingError) return false;
    let text;
    try { text = String(line) + os.EOL; } catch (error) {
      this._reportError(error);
      return false;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxFileBytes || bytes > this.maxBufferedBytes - this._bufferedBytes) {
      this._droppedEntries += 1;
      this._droppedBytes += bytes;
      this._schedule();
      return false;
    }
    this._entries.push(Buffer.from(text, 'utf8'));
    this._bufferedBytes += bytes;
    this._schedule();
    return true;
  }

  async flush() {
    if (this._scheduled !== null) {
      clearImmediate(this._scheduled);
      this._scheduled = null;
    }
    while (this._running || this._entries.length || this._droppedEntries) await this._start();
  }

  close() {
    if (!this._closePromise) {
      this._closed = true;
      this._closePromise = this.flush();
    }
    return this._closePromise;
  }

  _reportError(error) {
    this._reportingError = true;
    try { this.onError(error); } catch { /* Logging must not break application work. */ }
    this._reportingError = false;
  }

  _schedule() {
    if (this._scheduled !== null || this._running) return;
    this._scheduled = setImmediate(() => {
      this._scheduled = null;
      this._start();
    });
  }

  _start() {
    if (this._running) return this._running;
    this._running = this._drain().finally(() => {
      this._running = null;
      if (this._entries.length || this._droppedEntries) this._schedule();
    });
    return this._running;
  }

  async _initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this._fileBytes = (await fs.stat(this.filePath)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this._fileBytes = 0;
    }
    await this._pruneHistoricalSessions();
    this._initialized = true;
  }

  async _pruneHistoricalSessions() {
    // Only the application's timestamped session family is eligible. Never
    // delete arbitrary files merely because they share a .log extension.
    const currentName = path.basename(this.filePath);
    const current = /^(.*?)(\d{8}-\d{6}-\d{3})(\.log)$/.exec(currentName);
    if (!current) return;
    const family = new RegExp(`^(${escapeRegExp(current[1])}(\\d{8}-\\d{6}-\\d{3})${escapeRegExp(current[3])})(?:\\.[1-9]\\d*)?$`);
    const directory = path.dirname(this.filePath);
    try {
      const sessions = new Map();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = family.exec(entry.name);
        if (!match || match[1] === currentName) continue;
        if (!sessions.has(match[1])) sessions.set(match[1], []);
        sessions.get(match[1]).push(entry.name);
      }
      const ordered = [...sessions.keys()].sort().reverse();
      for (const session of ordered.slice(this.retainedSessions)) {
        for (const filename of sessions.get(session)) {
          const target = path.resolve(directory, filename);
          if (path.dirname(target) !== directory) continue;
          try { await fs.unlink(target); } catch (error) {
            if (error.code !== 'ENOENT') this._reportError(error);
          }
        }
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  async _drain() {
    while (this._entries.length || this._droppedEntries) {
      const entries = this._entries;
      this._entries = [];
      const queuedBytes = entries.reduce((total, entry) => total + entry.length, 0);
      if (this._droppedEntries) {
        const summary = `[log-writer] Dropped ${this._droppedEntries} log entries (${this._droppedBytes} bytes): log buffer or record size limit.${os.EOL}`;
        entries.push(Buffer.from(summary, 'utf8').subarray(0, this.maxFileBytes));
        this._droppedEntries = 0;
        this._droppedBytes = 0;
      }
      try {
        if (!this._initialized) await this._initialize();
        await this._writeEntries(entries);
      } catch (error) {
        this._reportError(error);
        // Re-read the actual file size next time, including after a partial I/O.
        this._initialized = false;
      } finally {
        this._bufferedBytes -= queuedBytes;
      }
    }
  }

  async _writeEntries(entries) {
    let batch = [];
    let batchBytes = 0;
    const writeBatch = async () => {
      if (!batchBytes) return;
      await fs.appendFile(this.filePath, Buffer.concat(batch, batchBytes));
      this._fileBytes += batchBytes;
      batch = [];
      batchBytes = 0;
    };
    for (const entry of entries) {
      if (this._fileBytes + batchBytes + entry.length > this.maxFileBytes) {
        await writeBatch();
        if (this._fileBytes) await this._rotate();
      }
      batch.push(entry);
      batchBytes += entry.length;
    }
    await writeBatch();
  }

  async _rotate() {
    const renameIfPresent = async (from, to) => {
      try { await fs.rename(from, to); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    };
    const oldest = this.maxSegments === 1 ? this.filePath : `${this.filePath}.${this.maxSegments - 1}`;
    try { await fs.unlink(oldest); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (let segment = this.maxSegments - 2; segment >= 1; segment -= 1) {
      await renameIfPresent(`${this.filePath}.${segment}`, `${this.filePath}.${segment + 1}`);
    }
    if (this.maxSegments > 1) await renameIfPresent(this.filePath, `${this.filePath}.1`);
    this._fileBytes = 0;
  }
}

module.exports = { SessionLogWriter };
