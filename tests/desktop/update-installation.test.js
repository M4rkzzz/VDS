const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

// Exercise the actual main-process handlers without launching Electron or installing software.
function harness(options = {}) {
  const desktop = path.resolve(__dirname, '../../desktop');
  const localRequire = createRequire(path.join(desktop, 'main.js'));
  const handlers = new Map();
  const messages = [];
  const verificationCalls = [];
  const fileCopies = [];
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    commandLine: { appendSwitch() {} },
    getVersion: () => '1.7.2',
    getPath: () => '/unused-vds-test-profile',
    whenReady: () => new Promise(() => {})
  });
  const updater = Object.assign(new EventEmitter(), {
    installCalls: 0,
    setFeedURL(feed) { this.feed = feed; },
    async checkForUpdates() { return { updateInfo: { version: '9.0.0' } }; },
    async downloadUpdate() {},
    quitAndInstall(silent, restart) {
      this.installCalls += 1;
      assert.equal(silent, true);
      assert.equal(restart, true);
      if (options.install) options.install(this);
    }
  });
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on() {}
  };
  const mockProcess = Object.assign(new EventEmitter(), { env: { SERVER_URL: 'http://192.168.5.193:3000' }, platform: 'win32', pid: 1 });
  const context = vm.createContext({
    __dirname: desktop, Buffer, process: mockProcess,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === 'electron') return { app, ipcMain };
      if (name === 'electron-updater') return { autoUpdater: updater };
      if (name === 'fs') return {
        mkdirSync() {}, appendFileSync() {}, existsSync: () => true,
        copyFileSync: (...args) => fileCopies.push(args),
        promises: { copyFile: async (...args) => fileCopies.push(args) }
      };
      if (name === './session-log-writer') return { SessionLogWriter: class { append() {} async close() {} } };
      if (name === './update-integrity') return {
        createSignedUpdateFeedOptions: (url) => ({ provider: 'custom', url }),
        verifyDownloadedUpdate: async (file, info) => {
          verificationCalls.push({ file, info });
          if (options.verify) await options.verify(file, info);
        }
      };
      return localRequire(name);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(desktop, 'main.js'), 'utf8'), context);
  const frame = { url: pathToFileURL(path.resolve(desktop, '../server/public/index.html')).href };
  const contents = { mainFrame: frame, isDestroyed: () => false, send: (channel, value) => messages.push({ channel, value }) };
  context.testWindow = { webContents: contents, isDestroyed: () => false };
  vm.runInContext('mainWindow = testWindow; getAutoUpdater();', context);
  const event = { sender: contents, senderFrame: frame };
  return {
    updater, messages, verificationCalls, fileCopies,
    invoke: (channel) => handlers.get(channel)(event),
    downloaded: (info) => updater.listeners('update-downloaded')[0](info),
    statuses: () => messages.filter(message => message.channel === 'update-status').map(message => message.value.status)
  };
}

const updateInfo = () => ({ version: '9.0.0', downloadedFile: '/unused/signed-update.exe', files: [] });

test('main update checks use the signed provider and independent HTTPS feed', async () => {
  const { invoke, updater } = harness();
  await invoke('check-for-updates');
  assert.equal(updater.feed.provider, 'custom');
  assert.equal(updater.feed.url, 'https://boshan.s.3q.hair/updates/');
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.disableDifferentialDownload, true);
});

test('installation is refused before verification and retries after a valid download', async () => {
  const { invoke, updater, downloaded, statuses, verificationCalls } = harness();
  assert.equal(await invoke('quit-and-install'), false);
  assert.equal(updater.installCalls, 0);
  await downloaded(updateInfo());
  assert.equal(statuses().at(-1), 'downloaded');
  assert.equal(await invoke('quit-and-install'), true);
  assert.equal(verificationCalls.length, 2);
  assert.equal(updater.installCalls, 1);
});

test('full-install updates use the verified downloaded file without duplicating a differential baseline', async () => {
  const { invoke, updater, downloaded, statuses, verificationCalls, fileCopies } = harness();
  updater.downloadedUpdateHelper = { cacheDir: '/unused-vds-updater-cache' };
  const info = updateInfo();
  await downloaded(info);
  assert.equal(statuses().at(-1), 'downloaded');
  assert.equal(await invoke('quit-and-install'), true);
  assert.equal(verificationCalls.length, 2);
  assert.ok(verificationCalls.every(call => call.file === info.downloadedFile));
  assert.deepEqual(fileCopies, []);
  assert.equal(updater.installCalls, 1);
});

test('rejected signature or package never publishes install readiness', async () => {
  const { invoke, updater, downloaded, statuses } = harness({ verify: async () => { throw new Error('invalid-signature'); } });
  await downloaded(updateInfo());
  assert.deepEqual(statuses(), ['error']);
  assert.equal(await invoke('quit-and-install'), false);
  assert.equal(updater.installCalls, 0);
});

test('a changed package is rechecked immediately before installation and blocks execution', async () => {
  let changed = false;
  const { invoke, updater, downloaded, statuses } = harness({ verify: async () => {
    if (changed) throw new Error('package-sha512-mismatch');
  } });
  await downloaded(updateInfo());
  changed = true;
  assert.equal(await invoke('quit-and-install'), false);
  assert.equal(updater.installCalls, 0);
  assert.equal(statuses().at(-1), 'error');
});

test('updater installation failures release the install latch and permit retry', async () => {
  const { invoke, updater, downloaded } = harness({ install: (updater) => {
    if (updater.installCalls === 1) updater.emit('error', new Error('installer-start-failed'));
  } });
  await downloaded(updateInfo());
  assert.equal(await invoke('quit-and-install'), false);
  assert.equal(await invoke('quit-and-install'), true);
  assert.equal(updater.installCalls, 2);
});

test('obsolete verification cannot restore readiness after an updater error', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const { updater, downloaded, statuses } = harness({ verify: () => pending });
  const checking = downloaded(updateInfo());
  updater.emit('error', new Error('download-cancelled'));
  complete();
  await checking;
  assert.deepEqual(statuses(), ['error']);
});

test('an updater error cancels an installation still awaiting package verification', async () => {
  let verification = 0;
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const { invoke, updater, downloaded, statuses } = harness({ verify: () => ++verification === 2 ? pending : undefined });
  await downloaded(updateInfo());
  const installing = invoke('quit-and-install');
  await new Promise(resolve => setImmediate(resolve));
  updater.emit('error', new Error('installation-cancelled'));
  complete();
  assert.equal(await installing, false);
  assert.equal(updater.installCalls, 0);
  assert.deepEqual(statuses(), ['downloaded', 'error']);
  assert.equal(await invoke('quit-and-install'), true);
  assert.equal(updater.installCalls, 1);
});
