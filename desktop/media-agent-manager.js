const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_BINARY_NAME = process.platform === 'win32'
  ? 'vds-media-agent.exe'
  : 'vds-media-agent';
const DEFAULT_INVOKE_TIMEOUT_MS = 30000;
const DEFAULT_PING_TIMEOUT_MS = 5000;
// Cold startup inventories codecs and validates native drivers in isolated
// probes; this deadline is separate from a responsive agent's RPC timeout.
const DEFAULT_STARTUP_TIMEOUT_MS = 90000;

class MediaAgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this.child = null;
    this.lineReader = null;
    this.pendingRequests = new Map();
    this.requestId = 1;
    this.startPromise = null;
    this.stopPromise = null;
    this.retiringChild = null;
    this.startupReadiness = null;
    this.defaultInvokeTimeoutMs = Number(options.defaultInvokeTimeoutMs || DEFAULT_INVOKE_TIMEOUT_MS);
    this.pingTimeoutMs = Number(options.pingTimeoutMs || DEFAULT_PING_TIMEOUT_MS);
    this.startupTimeoutMs = Number(options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS);
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
    if (this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
      return { ...this.status };
    }

    const binaryPath = this.resolveBinaryPath();
    const available = Boolean(binaryPath);
    const failed = available && this.status.state === 'failed';
    return {
      ...this.status,
      available,
      binaryPath: binaryPath || this.buildCandidatePaths()[0],
      state: failed ? 'failed' : available ? 'idle' : 'unavailable',
      running: false,
      reason: failed ? this.status.reason : available ? 'ready-to-start' : 'missing-binary'
    };
  }

  async start() {
    if (this.stopPromise) {
      const interruptedStart = this.startPromise;
      await this.stopPromise;
      if (interruptedStart) {
        try {
          await interruptedStart;
        } catch (_error) {
          // A stop can reject the previous startup ping before its promise settles.
        }
      }
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.retiringChild) {
      if (this.retiringChild.exitCode === null && this.retiringChild.signalCode === null) {
        throw createMediaAgentError('MEDIA_AGENT_STOP_TIMEOUT', 'media-agent-process-still-stopping');
      }
      this.retiringChild = null;
    }

    if (this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
      return this.getStatus();
    }

    const started = this.startInternal();
    this.startPromise = started;
    try {
      return await started;
    } finally {
      if (this.startPromise === started) {
        this.startPromise = null;
      }
    }
  }

  async stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const child = this.child || this.retiringChild;
    if (!child) {
      this.updateStatus({
        state: 'idle',
        running: false,
        reason: 'not-started'
      });
      return this.getStatus();
    }

    this.child = null;
    this.retiringChild = child;
    this.disposeLineReader();
    this.rejectAllPending(new Error('media-agent-stopped'));
    this.rejectStartupReadiness(new Error('media-agent-stopped'), child);
    this.stopPromise = (async () => {
      try {
        await this.stopChildProcess(child);
      } catch (error) {
        this.updateStatus({
          state: 'failed',
          running: false,
          reason: 'stop-failed',
          lastError: error.message
        });
        throw error;
      }
      if (this.retiringChild === child) {
        this.retiringChild = null;
      }
      if (!this.child) {
        this.updateStatus({
          state: 'idle',
          running: false,
          reason: 'stopped'
        });
      }
      return this.getStatus();
    })();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async stopChildProcess(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.__vdsExpectedExit = true;
    child.__vdsExpectedExitReason = child.__vdsExpectedExitReason || 'manager-stop';

    await new Promise((resolve, reject) => {
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

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const onExit = () => {
        finish();
      };

      child.once('exit', onExit);

      try {
        child.kill();
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null) {
          finish();
        } else {
          fail(error);
        }
        return;
      }

      if (settled) {
        return;
      }

      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }

        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          });
          killer.once('error', (error) => this.logger.error('[media-agent] taskkill failed:', error));
        } else {
          try {
            child.kill('SIGKILL');
          } catch (error) {
            fail(error);
            return;
          }
        }

        forceTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            finish();
          } else {
            fail(createMediaAgentError('MEDIA_AGENT_STOP_TIMEOUT', 'media-agent-stop-timeout:process-exit-not-observed'));
          }
        }, 1000);
      }, timeoutMs);
    });
  }

  async invoke(method, params = {}, options = {}) {
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

    // A live process can still be initializing. All external calls share startup
    // readiness rather than queuing work ahead of its handshake.
    await this.start();

    if (!this.child || this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw createMediaAgentError('MEDIA_AGENT_UNAVAILABLE', 'Native media agent binary is not available.');
    }

    return this.sendRequest(method, params, options, this.child);
  }

  sendRequest(method, params, options = {}, child = this.child) {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const payload = JSON.stringify({ id, method, params });
      const timeoutMs = Math.max(1000, Number(options.timeoutMs || this.defaultInvokeTimeoutMs || DEFAULT_INVOKE_TIMEOUT_MS));
      const timeoutId = setTimeout(() => {
        const request = this.pendingRequests.get(id);
        if (!request || request.child !== child) {
          return;
        }
        this.pendingRequests.delete(id);
        const suffix = this.recentStderrLines.length
          ? `:stderr=${this.recentStderrLines.join(' | ')}`
          : '';
        const error = new Error(`media-agent-invoke-timeout:${method}${suffix}`);
        error.code = 'MEDIA_AGENT_INVOKE_TIMEOUT';
        request.reject(error);
        this.retireChild(child, error, 'invoke-timeout');
      }, timeoutMs);
      const finishResolve = (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      };
      const finishReject = (error) => {
        clearTimeout(timeoutId);
        reject(error);
      };
      this.pendingRequests.set(id, { child, resolve: finishResolve, reject: finishReject, timeoutId });
      const stdin = child && child.stdin;
      if (!stdin || stdin.destroyed || this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(this.buildExitError(child && child.exitCode, child && child.signalCode));
        return;
      }
      const rejectWrite = (error) => {
        const request = this.pendingRequests.get(id);
        if (!error || !request || request.child !== child) {
          return;
        }
        this.pendingRequests.delete(id);
        request.reject(error);
        this.retireChild(child, error, 'stdin-error');
      };
      try {
        stdin.write(payload + '\n', 'utf8', rejectWrite);
      } catch (error) {
        rejectWrite(error);
      }
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
      if (this.child !== child) {
        return;
      }
      this.recordStderr(error && error.message ? error.message : String(error));
      this.retireChild(child, error, 'stdin-error');
    });
    child.stderr.on('data', (chunk) => {
      if (this.child !== child) {
        return;
      }
      const message = String(chunk || '').trim();
      if (message) {
        this.recordStderr(message);
        this.logger.warn(`[media-agent:stderr] ${message}`);
      }
    });

    child.once('error', (error) => {
      if (this.child !== child) {
        return;
      }
      this.retireChild(child, error, 'spawn-error');
    });

    child.once('exit', (code, signal) => {
      const expectedExit = Boolean(child.__vdsExpectedExit);
      const exitReason = child.__vdsExpectedExitReason || 'process-exit';
      if (this.retiringChild === child) {
        this.retiringChild = null;
      }
      if (this.child !== child) {
        return;
      }
      this.disposeLineReader();
      if (expectedExit) {
        this.rejectAllPending(new Error('media-agent-stopped'));
        this.rejectStartupReadiness(new Error('media-agent-stopped'), child);
        this.logger.log(`[media-agent] process exited as expected: code=${code ?? 'null'} signal=${signal ?? 'null'} reason=${exitReason}`);
      } else {
        const exitError = this.buildExitError(code, signal);
        this.logger.error('[media-agent] process exited:', exitError.message);
        this.rejectAllPending(exitError);
        this.rejectStartupReadiness(exitError, child);
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
    const ready = this.waitForAgentReady(child);
    this.attachStdoutReader(child.stdout, child);
    this.updateStatus({
      state: 'starting',
      available: true,
      running: false,
      reason: 'initializing',
      binaryPath,
      agent: null,
      lastError: null
    });

    try {
      await ready;
      await this.sendRequest('ping', {}, { timeoutMs: this.pingTimeoutMs }, child);
    } catch (error) {
      if (this.child === child) {
        this.retireChild(child, error, 'startup-failed');
      }
      throw error;
    }

    if (this.child !== child) {
      throw new Error('media-agent-stopped');
    }
    this.updateStatus({
      state: 'running',
      running: true,
      reason: 'agent-ready'
    });
    return this.getStatus();
  }

  waitForAgentReady(child) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.startupReadiness || this.startupReadiness.child !== child) {
          return;
        }
        const suffix = this.recentStderrLines.length
          ? `:stderr=${this.recentStderrLines.join(' | ')}`
          : '';
        const error = createMediaAgentError('MEDIA_AGENT_STARTUP_TIMEOUT', `media-agent-startup-timeout:agent-ready${suffix}`);
        this.retireChild(child, error, 'startup-timeout');
      }, Math.max(1000, this.startupTimeoutMs));
      this.startupReadiness = { child, resolve, reject, timeoutId };
    });
  }

  rejectStartupReadiness(error, child) {
    const readiness = this.startupReadiness;
    if (!readiness || readiness.child !== child) {
      return;
    }
    this.startupReadiness = null;
    clearTimeout(readiness.timeoutId);
    readiness.reject(error);
  }

  retireChild(child, error, reason) {
    if (!child || this.child !== child) {
      return;
    }
    this.child = null;
    this.disposeLineReader();
    this.rejectStartupReadiness(error, child);
    this.rejectAllPending(error, child);
    this.retiringChild = child;
    child.__vdsExpectedExit = true;
    child.__vdsExpectedExitReason = reason;
    // A replacement must not overlap a timed-out native process that still owns
    // capture, audio or GPU resources. Stop is shared with normal stop/start.
    const stopping = this.stopChildProcess(child, 1000).then(() => {
      if (this.retiringChild === child) {
        this.retiringChild = null;
      }
      return this.getStatus();
    });
    this.stopPromise = stopping;
    this.updateStatus({
      state: 'failed',
      available: true,
      running: false,
      reason,
      lastError: error && error.message ? error.message : String(error)
    });
    stopping.catch((stopError) => {
      this.logger.error('[media-agent] failed to retire process:', stopError);
      if (this.retiringChild === child) {
        this.updateStatus({
          state: 'failed',
          running: false,
          reason: 'stop-failed',
          lastError: `${error.message}; ${stopError.message}`
        });
      }
    }).finally(() => {
      if (this.stopPromise === stopping) {
        this.stopPromise = null;
      }
    });
  }

  attachStdoutReader(stdout, child = this.child) {
    this.disposeLineReader();
    this.lineReader = readline.createInterface({ input: stdout });
    this.lineReader.on('line', (line) => {
      if (this.child === child) {
        this.handleAgentLine(line);
      }
    });
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
        const readiness = this.startupReadiness;
        if (readiness && readiness.child === this.child) {
          this.startupReadiness = null;
          clearTimeout(readiness.timeoutId);
          readiness.resolve();
        }
        this.updateStatus({
          available: true,
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
    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }
    if (payload.error) {
      request.reject(createMediaAgentError(payload.error.code, payload.error.message));
      return;
    }

    request.resolve(payload.result);
  }

  rejectAllPending(error, child = null) {
    for (const [id, request] of this.pendingRequests) {
      if (child && request.child !== child) {
        continue;
      }
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  updateStatus(patch) {
    this.status = {
      ...this.status,
      ...patch
    };
    this.emit('status', { ...this.status });
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
