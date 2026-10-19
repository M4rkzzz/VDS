const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { UpnpPortMapper } = require('../../desktop/upnp-port-mapper');
const { UpnpMappingJournal } = require('../../desktop/upnp-mapping-journal');
const { fixture } = require('../fixtures/upnp-router');

async function directory(t) {
  const parent = path.resolve(__dirname, '../../tmp');
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'upnp-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), parent);
    for (const file of await fs.readdir(dir)) await fs.unlink(path.join(dir, file));
    await fs.rmdir(dir);
  });
  return dir;
}
function launch(t, f, dir, disableJournal = false, claimOnly = false) {
  const child = fork(path.resolve(__dirname, '../fixtures/upnp-crash-client.js'), [JSON.stringify({
    directory: dir, discoveryPort: f.mapper.discoveryPort, candidate: f.candidate, disableJournal, claimOnly
  })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  return { child, exited, async ready() {
    const [message] = await once(child, 'message');
    assert.equal(message.ready, true, JSON.stringify(message) + output);
    return message.mapping;
  }, async crash() { child.send('exit-without-cleanup'); assert.deepEqual(await exited, [86, null], output); } };
}
function recoverer(f, dir, errors = []) {
  return new UpnpPortMapper({ discoveryAddress: '127.0.0.1', discoveryPort: f.mapper.discoveryPort,
    journal: new UpnpMappingJournal({ directory: dir }), onError: (error) => errors.push(error.message) });
}

test('a different process recovers an owned permanent mapping after its creator exits without cleanup', { timeout: 12000 }, async (t) => {
  const dir = await directory(t), f = await fixture({ permanentOnly: true });
  try {
    const app = launch(t, f, dir, process.env.VDS_UPNP_RECOVERY_BASELINE === '1');
    const mapping = await app.ready(); assert.equal(mapping.permanent, true);
    await app.crash(); assert.equal(f.entries.size, 1, 'abrupt exit must leave the fixture mapping to recover');
    const recovery = recoverer(f, dir);
    await Promise.all([recovery.recoverOrphans(), recovery.recoverOrphans()]);
    assert.equal(f.entries.size, 0, 'next process must remove the orphaned mapping');
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 1);
    assert.deepEqual(await fs.readdir(dir), []); assert.deepEqual(f.failures, []);
  } finally { await f.stop(); }
});

test('committed mapping intent survives a process exit before the Add response arrives', { timeout: 12000 }, async (t) => {
  const dir = await directory(t); let app; let intentExisted = false;
  const f = await fixture({ permanentOnly: true, holdAddResponse: true,
    onMappingAdded: ({ description }) => {
      // Inspect on the router side, before sending any successful Add response.
      intentExisted = require('node:fs').existsSync(path.join(dir, description + '.json'));
      app.child.send('exit-without-cleanup');
    } });
  try {
    app = launch(t, f, dir);
    assert.deepEqual(await app.exited, [86, null]);
    assert.equal(intentExisted, true); assert.equal(f.entries.size, 1);
    await recoverer(f, dir).recoverOrphans();
    assert.equal(f.entries.size, 0); assert.deepEqual(await fs.readdir(dir), []);
    assert.deepEqual(f.failures, []);
  } finally { await f.stop(); }
});

test('recovery skips a living instance, then cleans the same record after it exits', { timeout: 12000 }, async (t) => {
  const dir = await directory(t), f = await fixture({ permanentOnly: true });
  try {
    const app = launch(t, f, dir); await app.ready();
    const recovery = recoverer(f, dir);
    await recovery.recoverOrphans();
    assert.equal(f.entries.size, 1);
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 0);
    await app.crash(); await recovery.recoverOrphans();
    assert.equal(f.entries.size, 0); assert.deepEqual(await fs.readdir(dir), []);
  } finally { await f.stop(); }
});

test('an external port reassigned to someone else is preserved and the obsolete record is retired', { timeout: 12000 }, async (t) => {
  const dir = await directory(t), f = await fixture({ permanentOnly: true });
  try {
    const app = launch(t, f, dir), mapping = await app.ready(); await app.crash();
    f.entries.get(mapping.externalPort).NewPortMappingDescription = 'another-program';
    await recoverer(f, dir).recoverOrphans();
    assert.equal(f.entries.size, 1);
    assert.equal(f.entries.get(mapping.externalPort).NewPortMappingDescription, 'another-program');
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await f.stop(); }
});

test('failed deletion retains its recovery record and a later attempt succeeds', { timeout: 12000 }, async (t) => {
  const dir = await directory(t); let unavailable = true;
  const f = await fixture({ permanentOnly: true, failDelete: () => unavailable });
  try {
    const app = launch(t, f, dir); await app.ready(); await app.crash();
    const errors = [], recovery = recoverer(f, dir, errors);
    await recovery.recoverOrphans();
    assert.equal(f.entries.size, 1); assert.equal((await fs.readdir(dir)).length, 1);
    assert.ok(errors.some((error) => error.includes('501')));
    unavailable = false; await recovery.recoverOrphans();
    assert.equal(f.entries.size, 0); assert.deepEqual(await fs.readdir(dir), []);
  } finally { await f.stop(); }
});

test('journal validation ignores malformed, off-gateway, and temporary records without router operations', async (t) => {
  const dir = await directory(t), errors = [];
  const journal = new UpnpMappingJournal({ directory: dir, isAlive: () => false, onError: (error) => errors.push(error.message) });
  const details = { description: 'VDS-0123456789abcdef', gateway: '127.0.0.1', localAddress: '127.0.0.1',
    controlUrl: 'http://127.0.0.1:123/control', serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', internalPort: 1234, externalPort: 2345 };
  await journal.remember(details);
  assert.equal((await journal.orphans()).length, 1);
  const record = JSON.parse(await fs.readFile(path.join(dir, details.description + '.json'), 'utf8'));
  record.controlUrl = 'http://192.0.2.5/control';
  await fs.writeFile(path.join(dir, details.description + '.json'), JSON.stringify(record));
  await fs.writeFile(path.join(dir, 'VDS-1111111111111111.json'), '{');
  await fs.writeFile(path.join(dir, 'VDS-2222222222222222.json.tmp'), JSON.stringify(record));
  assert.deepEqual(await journal.orphans(), []);
  assert.equal(errors.length, 2);
});

test('unwritable recovery storage fails before creating a permanent mapping', async (t) => {
  const dir = await directory(t), f = await fixture({ permanentOnly: true });
  try {
    const file = path.join(dir, 'not-a-directory'); await fs.writeFile(file, 'fixture');
    const mapper = recoverer(f, file);
    await assert.rejects(mapper.createLease('127.0.0.1', f.candidate, 180));
    assert.equal(f.entries.size, 0);
    assert.equal(f.calls.filter((call) => call.action === 'AddPortMapping').length, 0);
  } finally { await f.stop(); }
});

test('independent recovery instances claim an orphan only once', { timeout: 12000 }, async (t) => {
  const dir = await directory(t), f = await fixture({ permanentOnly: true });
  try {
    const app = launch(t, f, dir); await app.ready(); await app.crash();
    const first = recoverer(f, dir), second = recoverer(f, dir);
    // Both scanners see the same file before either attempts its atomic rename.
    const [record] = await first.journal.orphans();
    await Promise.all([first.recoverRecord(record), second.recoverRecord(record)]);
    assert.equal(f.entries.size, 0);
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 1);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await f.stop(); }
});

test('a live recovery claim is deferred and an exited recovery owner can be reclaimed', { timeout: 12000 }, async (t) => {
  const dir = await directory(t), f = await fixture({ permanentOnly: true });
  try {
    const app = launch(t, f, dir); await app.ready(); await app.crash();
    const cleaner = launch(t, f, dir, false, true);
    assert.equal((await cleaner.ready()).claimed, true);
    await recoverer(f, dir).recoverOrphans();
    assert.equal(f.entries.size, 1, 'another instance must leave a live claim alone');
    // Actual abrupt process exit must release the OS lock as well as leave
    // enough metadata for a different process to reclaim this recovery attempt.
    await cleaner.crash();
    await recoverer(f, dir).recoverOrphans();
    assert.equal(f.entries.size, 0);
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 1);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await f.stop(); }
});
