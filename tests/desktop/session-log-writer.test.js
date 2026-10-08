const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { SessionLogWriter } = require('../../desktop/session-log-writer');

async function workspace(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'vds-session-log-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('vds-session-log-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, filePath: path.join(directory, 'update-20261008-120000-000.log') };
}

test('append defers I/O and flush preserves line order, including appends during a flush', async t => {
  const { filePath } = await workspace(t);
  const writer = new SessionLogWriter(filePath);
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index} 画面`);
  for (const line of lines.slice(0, 20)) assert.equal(writer.append(line), true);
  assert.equal(existsSync(filePath), false);
  const firstFlush = writer.flush();
  for (const line of lines.slice(20)) assert.equal(writer.append(line), true);
  await Promise.all([firstFlush, writer.flush()]);
  assert.equal(await fs.readFile(filePath, 'utf8'), lines.join(os.EOL) + os.EOL);
  await writer.close();
});

test('scheduled writes drain without an explicit flush and close is idempotent', async t => {
  const { filePath } = await workspace(t);
  const writer = new SessionLogWriter(filePath);
  writer.append('one');
  // Allow the scheduled batch to start; close must also wait for active I/O.
  await new Promise(resolve => setImmediate(resolve));
  const close = writer.close();
  assert.equal(writer.close(), close);
  assert.equal(writer.append('too late'), false);
  await close;
  assert.equal(await fs.readFile(filePath, 'utf8'), `one${os.EOL}`);
});

test('buffer overflow and oversize records produce summaries without blocking later logging', async t => {
  const { filePath } = await workspace(t);
  const writer = new SessionLogWriter(filePath, { maxBufferedBytes: 96, maxFileBytes: 512 });
  const first = 'a'.repeat(60);
  const dropped = 'b'.repeat(60);
  assert.equal(writer.append(first), true);
  assert.equal(writer.append(dropped), false);
  assert.equal(writer.append('last'), true);
  await writer.flush();
  const content = await fs.readFile(filePath, 'utf8');
  assert.ok(content.startsWith(`${first}${os.EOL}last${os.EOL}`));
  assert.match(content, /Dropped 1 log entries/);
  assert.ok(!content.includes(dropped));
  assert.equal(writer.append('c'.repeat(600)), false);
  await writer.flush();
  assert.equal(writer.append('recovered'), true);
  await writer.close();
  assert.ok((await fs.readFile(filePath, 'utf8')).endsWith(`recovered${os.EOL}`));
});

test('the buffer budget includes a batch currently waiting for asynchronous disk work', async t => {
  const { filePath } = await workspace(t);
  const writer = new SessionLogWriter(filePath, { maxBufferedBytes: 96, maxFileBytes: 512 });
  const line = 'a'.repeat(96 - Buffer.byteLength(os.EOL));
  assert.equal(writer.append(line), true);
  const flushing = writer.flush();
  assert.equal(writer.append('cannot accumulate another batch yet'), false);
  await flushing;
  assert.equal(writer.append('later'), true);
  await writer.close();
  const content = await fs.readFile(filePath, 'utf8');
  assert.ok(content.startsWith(line));
  assert.match(content, /Dropped 1 log entries/);
  assert.ok(content.endsWith(`later${os.EOL}`));
});

test('rotation keeps a bounded number of whole-line UTF-8 segments in chronological order', async t => {
  const { directory, filePath } = await workspace(t);
  const writer = new SessionLogWriter(filePath, { maxFileBytes: 128, maxSegments: 3 });
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index} ${'画面'.repeat(7)}`);
  for (const line of lines) {
    assert.equal(writer.append(line), true);
    await writer.flush();
  }
  await writer.close();
  const files = await fs.readdir(directory);
  assert.equal(files.length, 3);
  const ordered = [];
  for (const suffix of ['.2', '.1', '']) {
    const content = await fs.readFile(filePath + suffix);
    assert.ok(content.length <= 128);
    assert.ok(!content.toString('utf8').includes('\ufffd'));
    ordered.push(content.toString('utf8'));
  }
  assert.equal(ordered.join(''), lines.slice(-6).join(os.EOL) + os.EOL);
});

test('one-segment rotation replaces the previous content without creating archives', async t => {
  const { directory, filePath } = await workspace(t);
  const writer = new SessionLogWriter(filePath, { maxFileBytes: 16, maxSegments: 1 });
  writer.append('first-line');
  await writer.flush();
  writer.append('second-line');
  await writer.close();
  assert.equal(await fs.readFile(filePath, 'utf8'), `second-line${os.EOL}`);
  assert.deepEqual(await fs.readdir(directory), [path.basename(filePath)]);
});

test('startup retains only the newest historical sessions and all their owned segments', async t => {
  const { directory, filePath } = await workspace(t);
  const names = [];
  for (let index = 1; index <= 5; index += 1) {
    const name = `update-2026100${index}-120000-000.log`;
    names.push(name);
    await fs.writeFile(path.join(directory, name), 'old');
    await fs.writeFile(path.join(directory, `${name}.1`), 'older segment');
  }
  const unrelated = ['service.log', 'update-not-a-session.log', 'update-20261001-120000-000.log.backup', 'other-20261001-120000-000.log'];
  for (const name of unrelated) await fs.writeFile(path.join(directory, name), 'keep');
  const writer = new SessionLogWriter(filePath, { retainedSessions: 2 });
  writer.append('new session');
  await writer.close();
  const retained = await fs.readdir(directory);
  for (const name of names.slice(0, 3)) {
    assert.ok(!retained.includes(name));
    assert.ok(!retained.includes(`${name}.1`));
  }
  for (const name of names.slice(-2)) {
    assert.ok(retained.includes(name));
    assert.ok(retained.includes(`${name}.1`));
  }
  for (const name of unrelated) assert.ok(retained.includes(name));
  assert.ok(retained.includes(path.basename(filePath)));
});

test('custom file names do not make unrelated logs eligible for cleanup', async t => {
  const { directory } = await workspace(t);
  const old = path.join(directory, 'unrelated.log');
  await fs.writeFile(old, 'keep');
  const writer = new SessionLogWriter(path.join(directory, 'custom.log'), { retainedSessions: 0 });
  writer.append('custom');
  await writer.close();
  assert.equal(await fs.readFile(old, 'utf8'), 'keep');
});

test('write errors are reported safely, close resolves and logging can recover after a path is repaired', async t => {
  const { directory } = await workspace(t);
  const blocker = path.join(directory, 'blocked');
  await fs.writeFile(blocker, 'not a directory');
  const errors = [];
  const writer = new SessionLogWriter(path.join(blocker, 'update-20261008-120000-000.log'), {
    onError(error) {
      errors.push(error);
      assert.equal(writer.append('recursive failure log'), false);
      throw new Error('reporting also failed');
    }
  });
  assert.equal(writer.append('lost because disk is unavailable'), true);
  await writer.flush();
  assert.equal(errors.length, 1);
  await fs.unlink(blocker);
  await fs.mkdir(blocker);
  assert.equal(writer.append('working now'), true);
  await writer.close();
  assert.equal(await fs.readFile(writer.filePath, 'utf8'), `working now${os.EOL}`);
  assert.equal(errors.length, 1);
});

test('invalid logger settings fail immediately rather than causing a background loop', () => {
  for (const options of [{ maxFileBytes: 0 }, { maxSegments: 0 }, { maxBufferedBytes: NaN }, { retainedSessions: -1 }]) {
    assert.throws(() => new SessionLogWriter('test.log', options), TypeError);
  }
});
