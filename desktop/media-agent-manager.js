const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_BINARY_NAME = process.platform === 'win32'
  ? 'vds-media-agent.exe'
  : 'vds-media-agent';

class MediaAgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this.child = null;
    this.lineReader = null;
    this.pendingRequests = new Map();
    this.requestId = 1;
    this.startPromise = null;
    this.recentStderrLines = [];
    this.status = {
      state: 'idle',
      available: false,
      running: false,
      reason: 'not-started',
      binaryPath: null,
      implementation: 'native-media-agent'
    };
  }

  recordStderr(message) {
    const normalized = String(message || '').trim();
    if (!normalized) {
      return;
    }
    this.recentStderrLines.push(normalized);
    if (this.recentStderrLines.length > 12) {
      this.recentStderrLines.shift();
    }
  }

  buildExitError(code, signal) {
    const suffix = this.recentStderrLines.length
      ? `:stderr=${this.recentStderrLines.join(' | ')}`
      : '';
    return new Error(`media-agent-exited:${code ?? 'null'}:${signal ?? 'null'}${suffix}`);
  }

  getStatus() {
    if (this.child && !this.child.killed) {
      return { ...this.status };
    }

    const binaryPath = this.resolveBinaryPath();
    const available = Boolean(binaryPath);
    return {
      ...this.status,
      available,
      binaryPath: binaryPath || this.buildCandidatePaths()[0],
      state: available ? 'idle' : 'unavailable',
      running: false,
      reason: available ? 'ready-to-start' : 'missing-binary'
    };
  }

  async start() {
    if (this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
      return this.getStatus();
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop() {
    if (!this.child) {
      this.updateStatus({
        state: 'idle',
        running: false,
        reason: 'not-started'
      });
      return this.getStatus();
    }

    const child = this.child;
    this.child = null;
    this.disposeLineReader();
    this.rejectAllPending(new Error('media-agent-stopped'));
    await this.stopChildProcess(child);
    this.updateStatus({
      state: 'idle',
      running: false,
      reason: 'stopped'
    });
    return this.getStatus();
  }

  async stopChildProcess(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.__vdsExpectedExit = true;
    child.__vdsExpectedExitReason = 'manager-stop';

    await new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      let forceTimer = null;

      const cleanup = () => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (forceTimer) {
          clearTimeout(forceTimer);
          forceTimer = null;
        }
        child.removeListener('exit', onExit);
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const onExit = () => {
        finish();
      };

      child.once('exit', onExit);

      try {
        child.kill();
      } catch (_error) {
        finish();
        return;
      }

      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }

        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          });
        } else {
          try {
            child.kill('SIGKILL');
          } catch (_error) {
            finish();
            return;
          }
        }

        forceTimer = setTimeout(() => {
          finish();
        }, 1000);
      }, timeoutMs);
    });
  }

  async invoke(method, params = {}) {
    if (method === 'getStatus') {
      const status = this.getStatus();
      if (status.available && !status.running) {
        return {
          ...status,
          agent: null
        };
      }

      return status;
    }

    if (!this.child || this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.start();
    }

    if (!this.child || this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw createMediaAgentError('MEDIA_AGENT_UNAVAILABLE', 'Native media agent binary is not available.');
    }

    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params });
      const child = this.child;
      const stdin = child && child.stdin;
      if (!stdin || stdin.destroyed || child.exitCode !== null || child.signalCode !== null) {
        this.pendingRequests.delete(id);
        reject(this.buildExitError(child && child.exitCode, child && child.signalCode));
        return;
      }
      stdin.write(payload + '\n', 'utf8', (error) => {
        if (!error) {
          return;
        }
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  async invokeDetached(method, params = {}, options = {}) {
    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      throw createMediaAgentError('MEDIA_AGENT_UNAVAILABLE', 'Native media agent binary is not available.');
    }

    const timeoutMs = Number(options.timeoutMs || 15000);

    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const requestId = this.requestId++;
      let settled = false;
      let lineReader = null;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (lineReader) {
          lineReader.close();
          lineReader = null;
        }

        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }

        if (!child.killed) {
          child.kill();
        }
      };

      const finishResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      child.stdin.setDefaultEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const message = String(chunk || '').trim();
        if (message) {
          this.recordStderr(message);
          this.logger.warn(`[media-agent:stderr] ${message}`);
        }
      });

      child.once('error', (error) => {
        finishReject(error);
      });

      child.once('exit', (code, signal) => {
        if (settled) {
          return;
        }
        finishReject(this.buildExitError(code, signal));
      });

      lineReader = readline.createInterface({ input: child.stdout });
      lineReader.on('line', (line) => {
        if (!line) {
          return;
        }

        let payload;
        try {
          payload = JSON.parse(line);
        } catch (_error) {
          this.logger.warn(`[media-agent] Ignoring invalid JSON line in detached invoke: ${line}`);
          return;
        }

        if (payload.event) {
          return;
        }

        if (payload.id !== requestId) {
          return;
        }

        if (payload.error) {
          finishReject(createMediaAgentError(payload.error.code, payload.error.message));
          return;
        }

        finishResolve(payload.result);
      });

      timeoutId = setTimeout(() => {
        finishReject(new Error(`media-agent-detached-timeout:${method}`));
      }, timeoutMs);

      child.stdin.write(JSON.stringify({
        id: requestId,
        method,
        params
      }) + '\n', 'utf8');
    });
  }

  buildCandidatePaths() {
    const envPath = process.env.VDS_MEDIA_AGENT_PATH;
    const packagedPath = process.resourcesPath
      ? path.join(process.resourcesPath, 'runtime', 'media-agent', DEFAULT_BINARY_NAME)
      : null;
    const devPath = path.resolve(__dirname, '../runtime/media-agent', DEFAULT_BINARY_NAME);

    return [envPath, packagedPath, devPath].filter(Boolean);
  }

  resolveBinaryPath() {
    return this.buildCandidatePaths().find((candidatePath) => {
      try {
        return fs.existsSync(candidatePath);
      } catch (_error) {
        return false;
      }
    }) || null;
  }

  async startInternal() {
    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      const status = {
        state: 'unavailable',
        available: false,
        running: false,
        reason: 'missing-binary',
        binaryPath: this.buildCandidatePaths()[0] || null
      };
      this.updateStatus(status);
      return this.getStatus();
    }

    this.logger.log(`[media-agent] Starting native media agent: ${binaryPath}`);
    const child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.recentStderrLines = [];

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.on('error', (error) => {
      this.recordStderr(error && error.message ? error.message : String(error));
      this.rejectAllPending(error);
      this.updateStatus({
        state: 'failed',
        available: true,
        running: false,
        reason: 'stdin-error',
        binaryPath,
        lastError: error && error.message ? error.message : String(error)
      });
    });
    child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) {
        this.recordStderr(message);
        this.logger.warn(`[media-agent:stderr] ${message}`);
      }
    });

    child.once('error', (error) => {
      this.rejectAllPending(error);
      this.updateStatus({
        state: 'failed',
        available: true,
        running: false,
        reason: 'spawn-error',
        binaryPath,
        lastError: error.message
      });
    });

    child.once('exit', (code, signal) => {
      this.disposeLineReader();
      const expectedExit = Boolean(child.__vdsExpectedExit);
      const exitReason = child.__vdsExpectedExitReason || 'process-exit';
      if (expectedExit) {
        this.rejectAllPending(new Error('media-agent-stopped'));
        this.logger.log(`[media-agent] process exited as expected: code=${code ?? 'null'} signal=${signal ?? 'null'} reason=${exitReason}`);
      } else {
        const exitError = this.buildExitError(code, signal);
        this.logger.error('[media-agent] process exited:', exitError.message);
        this.rejectAllPending(exitError);
      }
      this.child = null;
      this.updateStatus({
        state: 'stopped',
        available: true,
        running: false,
        reason: expectedExit ? exitReason : 'process-exit',
        binaryPath,
        exitCode: code,
        exitSignal: signal
      });
    });

    this.child = child;
    this.attachStdoutReader(child.stdout);
    this.updateStatus({
      state: 'running',
      available: true,
      running: true,
      reason: 'started',
      binaryPath
    });

    try {
      await this.invoke('ping');
    } catch (error) {
      await this.stop();
      throw error;
    }

    return this.getStatus();
  }

  attachStdoutReader(stdout) {
    this.disposeLineReader();
    this.lineReader = readline.createInterface({ input: stdout });
    this.lineReader.on('line', (line) => this.handleAgentLine(line));
  }

  disposeLineReader() {
    if (this.lineReader) {
      this.lineReader.close();
      this.lineReader = null;
    }
  }

  handleAgentLine(line) {
    if (!line) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      this.logger.warn(`[media-agent] Ignoring invalid JSON line: ${line}`);
      return;
    }

    if (payload.event) {
      this.emit('event', payload);
      if (payload.event === 'agent-ready') {
        this.updateStatus({
          state: 'running',
          available: true,
          running: true,
          reason: 'agent-ready',
          agent: payload.params || null
        });
      }
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'id')) {
      return;
    }

    const request = this.pendingRequests.get(payload.id);
    if (!request) {
      return;
    }

    this.pendingRequests.delete(payload.id);
    if (payload.error) {
      request.reject(createMediaAgentError(payload.error.code, payload.error.message));
      return;
    }

    request.resolve(payload.result);
  }

  rejectAllPending(error) {
    for (const request of this.pendingRequests.values()) {
      request.reject(error);
    }
    this.pendingRequests.clear();
  }

  updateStatus(patch) {
    this.status = {
      ...this.status,
      ...patch
    };
    this.emit('status', this.getStatus());
  }
}

function createMediaAgentError(code, message) {
  const error = new Error(message || code || 'media-agent-error');
  error.code = code || 'MEDIA_AGENT_ERROR';
  return error;
}

module.exports = {
  MediaAgentManager
};
