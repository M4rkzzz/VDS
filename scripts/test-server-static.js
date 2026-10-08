const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const zlib = require('node:zlib');
const WebSocket = require('ws');
const { startServer } = require('../server/server-core');

function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP response timed out')));
    req.once('error', reject);
    req.end();
  });
}

function assertVaryEncoding(response) {
  assert.match(response.headers.vary || '', /(?:^|,\s*)Accept-Encoding(?:,|$)/i);
}

test('static HTTP compression, cache freshness and streaming boundaries', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-http-static-'));
  const publicDir = path.join(fixtureRoot, 'public');
  const updatesDir = path.join(fixtureRoot, 'updates');
  const assetsDir = path.join(publicDir, 'vds_web', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(updatesDir);
  const script = Buffer.from('console.log("视频 connection and playback fixture");\n'.repeat(4096));
  const html = Buffer.from(`<!doctype html><html><body>${'fresh web entry '.repeat(512)}</body></html>`);
  const png = crypto.randomBytes(4096);
  const updateFiles = {
    'latest.yml': Buffer.from(`version: 1.7.3\r\n# ${'signed raw manifest '.repeat(256)}\r\n`),
    'latest.yml.sig': Buffer.from(JSON.stringify({ signature: 'signature-exact-bytes'.repeat(128) })),
    'VDS-Setup-1.7.3.exe': Buffer.concat([Buffer.from('MZ'), script]),
    'VDS-Setup-1.7.3.exe.blockmap': zlib.gzipSync(script)
  };
  for (const filePath of ['index.html', 'admin.html', 'vds_web/index.html']) {
    fs.writeFileSync(path.join(publicDir, filePath), html);
  }
  fs.writeFileSync(path.join(assetsDir, 'index-aB1_cD2-.js'), script);
  fs.writeFileSync(path.join(assetsDir, 'index-d0HoHFBC.css'), script);
  fs.writeFileSync(path.join(assetsDir, 'runtime.js'), script);
  fs.writeFileSync(path.join(assetsDir, 'image-aB12cD34.png'), png);
  fs.writeFileSync(path.join(publicDir, 'small.txt'), 'small response');
  for (const [name, bytes] of Object.entries(updateFiles)) fs.writeFileSync(path.join(updatesDir, name), bytes);
  const instance = startServer({ port: 0, publicDir, updatesDir });
  await once(instance.server, 'listening');
  const port = instance.server.address().port;
  try {
    await t.test('gzip and Brotli text decode byte-identically; binary and tiny responses stay raw', async () => {
      const compressed = await request(port, '/vds_web/assets/index-aB1_cD2-.js', { 'Accept-Encoding': 'gzip' });
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers['content-encoding'], 'gzip');
      assert.deepEqual(zlib.gunzipSync(compressed.body), script);
      assert.ok(compressed.body.length < script.length / 10);
      assertVaryEncoding(compressed);
      const plain = await request(port, '/vds_web/assets/index-aB1_cD2-.js', { 'Accept-Encoding': 'identity' });
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.deepEqual(plain.body, script);
      const brotli = await request(port, '/vds_web/assets/index-aB1_cD2-.js', { 'Accept-Encoding': 'br' });
      assert.equal(brotli.headers['content-encoding'], 'br');
      assert.deepEqual(zlib.brotliDecompressSync(brotli.body), script);
      assertVaryEncoding(brotli);
      const binary = await request(port, '/vds_web/assets/image-aB12cD34.png', { 'Accept-Encoding': 'gzip' });
      assert.equal(binary.headers['content-encoding'], undefined);
      assert.deepEqual(binary.body, png);
      const small = await request(port, '/small.txt', { 'Accept-Encoding': 'gzip' });
      assert.equal(small.headers['content-encoding'], undefined);
      assert.equal(small.body.toString(), 'small response');
      console.log(`static gzip: ${script.length} -> ${compressed.body.length} bytes, decoded bytes match`);
    });

    await t.test('only hash assets cache for a year, including HEAD and conditional 304', async () => {
      const assetPath = '/vds_web/assets/index-d0HoHFBC.css';
      const asset = await request(port, assetPath, { 'Accept-Encoding': 'gzip' });
      assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
      const head = await request(port, assetPath, { 'Accept-Encoding': 'gzip' }, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers['cache-control'], asset.headers['cache-control']);
      assertVaryEncoding(head);
      const cached = await request(port, assetPath, { 'Accept-Encoding': 'gzip', 'If-None-Match': asset.headers.etag });
      assert.equal(cached.status, 304);
      assert.equal(cached.body.length, 0);
      assert.equal(cached.headers['cache-control'], asset.headers['cache-control']);
      assertVaryEncoding(cached);
      const mutable = await request(port, '/vds_web/assets/runtime.js');
      assert.equal(mutable.headers['cache-control'], 'public, max-age=0');
      const missing = await request(port, '/vds_web/assets/missing-aB12cD34.js');
      assert.equal(missing.status, 404);
      assert.ok(!String(missing.headers['cache-control']).includes('immutable'));
    });

    await t.test('all HTML entry aliases and direct paths remain fresh while compressing normally', async () => {
      for (const pathname of ['/', '/index.html', '/vds_web', '/vds_web/', '/vds_web/index.html', '/admin', '/admin.html']) {
        const response = await request(port, pathname, { 'Accept-Encoding': 'gzip' });
        assert.equal(response.status, 200, pathname);
        assert.equal(response.headers['cache-control'], 'no-store', pathname);
        assert.equal(response.headers['content-encoding'], 'gzip', pathname);
        assert.deepEqual(zlib.gunzipSync(response.body), html, pathname);
        assertVaryEncoding(response);
      }
    });

    await t.test('update metadata, signatures, installers and blockmaps preserve exact raw bytes and Range', async () => {
      for (const [name, bytes] of Object.entries(updateFiles)) {
        const response = await request(port, `/updates/${name}`, { 'Accept-Encoding': 'gzip, br' });
        assert.equal(response.status, 200, name);
        assert.equal(response.headers['content-encoding'], undefined, name);
        assert.deepEqual(response.body, bytes, name);
        if (name.startsWith('latest.yml')) assert.equal(response.headers['cache-control'], 'no-store', name);
      }
      const metadata = await request(port, '/UPDATES/latest.yml?cache=changed', { 'Accept-Encoding': 'gzip' });
      assert.equal(metadata.headers['content-encoding'], undefined);
      assert.deepEqual(metadata.body, updateFiles['latest.yml']);
      const range = await request(port, '/updates/VDS-Setup-1.7.3.exe', { 'Accept-Encoding': 'gzip', Range: 'bytes=0-31' });
      assert.equal(range.status, 206);
      assert.equal(range.headers['content-encoding'], undefined);
      assert.equal(range.headers['content-range'], `bytes 0-31/${updateFiles['VDS-Setup-1.7.3.exe'].length}`);
      assert.deepEqual(range.body, updateFiles['VDS-Setup-1.7.3.exe'].subarray(0, 32));
      const textRange = await request(port, '/vds_web/assets/runtime.js', { 'Accept-Encoding': 'gzip', Range: 'bytes=0-2047' });
      assert.equal(textRange.status, 206);
      assert.equal(textRange.headers['content-encoding'], undefined);
      assert.deepEqual(textRange.body, script.subarray(0, 2048));
    });

    await t.test('SSE first event is delivered without compression buffering', async () => {
      const firstEvent = `data: ${'stream event '.repeat(256)}\n\n`;
      instance.app.get('/__static-test-events', (_req, res) => {
        res.type('text/event-stream');
        res.write(firstEvent);
        const timer = setTimeout(() => res.end(), 2000);
        res.once('close', () => clearTimeout(timer));
      });
      const response = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/__static-test-events', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
          res.once('error', reject);
          res.once('data', (chunk) => {
            resolve({ headers: res.headers, body: chunk });
            req.destroy();
          });
        });
        req.setTimeout(1000, () => req.destroy(new Error('SSE event was buffered')));
        req.once('error', reject);
      });
      assert.equal(response.headers['content-encoding'], undefined);
      assert.equal(response.body.toString(), firstEvent);
    });

    await t.test('WebSocket upgrade and signaling still bypass HTTP compression', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'Accept-Encoding': 'gzip' } });
      try {
        await once(ws, 'open');
        const reply = once(ws, 'message');
        ws.send(JSON.stringify({ type: 'create-room', clientId: 'static-http-host' }));
        assert.equal(JSON.parse(String((await reply)[0])).type, 'room-created');
      } finally {
        ws.terminate();
      }
    });
  } finally {
    for (const socket of instance.wss.clients) socket.terminate();
    await new Promise((resolve) => instance.wss.close(resolve));
    await new Promise((resolve) => instance.server.close(resolve));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
