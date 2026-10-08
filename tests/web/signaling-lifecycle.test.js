const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../vds_web/src/signaling.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function harness() {
  let now = 0;
  let nextId = 1;
  const h = { sockets: [], statuses: [], messages: [], timers: new Map(), constructorFails: false };
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    handlers = new Map();
    closeCalls = 0;
    sent = [];
    constructor(url) {
      if (h.constructorFails) throw new Error('socket-constructor-failed');
      this.url = url;
      h.sockets.push(this);
    }
    addEventListener(type, callback, options) {
      const listeners = this.handlers.get(type) || [];
      listeners.push({ callback, once: options?.once });
      this.handlers.set(type, listeners);
    }
    emit(type, event = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      for (const listener of [...(this.handlers.get(type) || [])]) {
        if (listener.once) this.handlers.set(type, this.handlers.get(type).filter(entry => entry !== listener));
        listener.callback(event);
      }
    }
    close() {
      this.closeCalls += 1;
      this.readyState = 2;
      if (this.closeThrows) throw new Error('socket-close-failed');
      // A black-holed socket deliberately never emits close.
    }
    send(value) { this.sent.push(JSON.parse(value)); }
  }
  const context = vm.createContext({
    WebSocket: FakeWebSocket, location: { protocol: 'https:', host: 'example.test' },
    setTimeout(callback, delay) {
      const id = nextId++;
      h.timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { h.timers.delete(id); },
    Error, Promise, Set, JSON
  });
  const module = { exports: {} };
  vm.runInContext(`(function(module, exports) { ${code}\n })`, context)(module, module.exports);
  h.client = new module.exports.VdsWebSignaling();
  h.client.onStatus(status => h.statuses.push(status));
  h.client.onMessage(message => h.messages.push(message));
  h.advance = delay => {
    const until = now + delay;
    for (;;) {
      const next = [...h.timers].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      h.timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  };
  return h;
}

test('a shared black-holed handshake times out, closes its socket, and permits a new attempt', async () => {
  const h = harness();
  const first = h.client.connect();
  assert.equal(h.client.connect(), first);
  const rejected = assert.rejects(first, /connection timeout/);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 1);
  h.advance(10000);
  await rejected;
  assert.equal(h.sockets[0].closeCalls, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.statuses, ['connecting', 'error', 'closed']);
  const retry = h.client.connect();
  assert.notEqual(retry, first);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].emit('open');
  await retry;
  assert.equal(h.timers.size, 0);
  h.client.send({ type: 'viewer-ready' });
  assert.deepEqual(h.sockets[1].sent, [{ type: 'viewer-ready' }]);
  h.client.close();
});

test('late events and a queued deadline from a timed-out socket cannot affect its replacement', async () => {
  const h = harness();
  const old = h.client.connect();
  const queuedDeadline = [...h.timers.values()][0].callback;
  const rejected = assert.rejects(old, /timeout/);
  h.advance(10000);
  await rejected;
  const current = h.client.connect();
  const before = h.statuses.slice();
  h.sockets[0].emit('open');
  h.sockets[0].emit('error');
  h.sockets[0].emit('close');
  h.sockets[0].emit('message', { data: '{"type":"host-disconnected"}' });
  queuedDeadline();
  assert.deepEqual(h.statuses, before);
  assert.deepEqual(h.messages, []);
  assert.equal(h.client.connect(), current);
  assert.equal(h.timers.size, 1);
  h.sockets[1].emit('open');
  await current;
  h.sockets[1].emit('message', { data: '{"type":"room-joined"}' });
  assert.deepEqual(h.messages, [{ type: 'room-joined' }]);
  h.client.close();
});

test('manual cancellation rejects the wait and cancels the handshake deadline without a close event', async () => {
  const h = harness();
  const first = h.client.connect();
  const rejected = assert.rejects(first, /cancelled/);
  h.client.close();
  await rejected;
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets[0].closeCalls, 1);
  const current = h.client.connect();
  h.sockets[0].emit('close');
  h.sockets[0].emit('open');
  h.sockets[1].emit('open');
  await current;
  assert.equal(h.timers.size, 0);
  h.client.close();
});

test('successful open removes the handshake timer and imposes no connected-session deadline', async () => {
  const h = harness();
  const current = h.client.connect();
  h.sockets[0].emit('open');
  await current;
  assert.equal(h.timers.size, 0);
  h.advance(24 * 60 * 60 * 1000);
  assert.equal(h.sockets[0].closeCalls, 0);
  assert.deepEqual(h.statuses, ['connecting', 'open']);
  await h.client.connect();
  assert.equal(h.sockets.length, 1);
  h.client.close();
});

test('an error or throwing close settles the attempt and cannot leak its deadline', async () => {
  const h = harness();
  const failed = h.client.connect();
  const rejected = assert.rejects(failed, /connection failed/);
  h.sockets[0].closeThrows = true;
  h.sockets[0].emit('error');
  await rejected;
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.statuses, ['connecting', 'error', 'closed']);
  const current = h.client.connect();
  h.sockets[1].emit('open');
  await current;
  h.client.close();
});

test('constructor failure is a rejected promise and does not block a subsequent connect', async () => {
  const h = harness();
  h.constructorFails = true;
  await assert.rejects(h.client.connect(), /socket-constructor-failed/);
  assert.equal(h.timers.size, 0);
  h.constructorFails = false;
  const current = h.client.connect();
  h.sockets[0].emit('open');
  await current;
  h.client.close();
});

test('status callbacks can share or cancel the already registered connecting attempt', async () => {
  const h = harness();
  let nested;
  h.client.onStatus(status => { if (status === 'connecting') nested = h.client.connect(); });
  const first = h.client.connect();
  assert.equal(nested, first);
  assert.equal(h.sockets.length, 1);
  h.sockets[0].emit('open');
  await first;
  h.client.close();
  const remove = h.client.onStatus(status => { if (status === 'connecting') h.client.close(); });
  await assert.rejects(h.client.connect(), /cancelled/);
  remove();
  assert.equal(h.timers.size, 0);
});

test('an error observer may start a replacement without receiving a stale closed status', async () => {
  const h = harness();
  let retry;
  h.client.onStatus(status => { if (status === 'error') retry = h.client.connect(); });
  const first = h.client.connect();
  const rejected = assert.rejects(first, /timeout/);
  h.advance(10000);
  await rejected;
  assert.deepEqual(h.statuses, ['connecting', 'error', 'connecting']);
  h.sockets[1].emit('open');
  await retry;
  assert.equal(h.timers.size, 0);
  h.client.close();
});
