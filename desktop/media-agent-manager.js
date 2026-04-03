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
    this.status = {
      state: 'idle',
      available: false,
      running: false,
      reason: 'not-started',
      binaryPath: null,
      implementation: 'native-media-agent'
    };
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
    if (this.child && !this.child.killed) {
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
    child.kill();
    this.rejectAllPending(new Error('media-agent-stopped'));
    this.updateStatus({
      state: 'idle',
      running: false,
      reason: 'stopped'
    });
    return this.getStatus();
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

    if (!this.child || this.child.killed) {
      await this.start();
    }

    if (!this.child || this.child.killed) {
      throw createMediaAgentError('MEDIA_AGENT_UNAVAILABLE', 'Native media agent binary is not available.');
    }

    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params });
      this.child.stdin.write(payload + '\n', 'utf8');
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
        finishReject(new Error(`media-agent-exited:${code ?? 'null'}:${signal ?? 'null'}`));
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

    child.stdin.setDefaultEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) {
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
      this.rejectAllPending(new Error(`media-agent-exited:${code ?? 'null'}:${signal ?? 'null'}`));
      this.child = null;
      this.updateStatus({
        state: 'stopped',
        available: true,
        running: false,
        reason: 'process-exit',
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
