const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness(install) {
  const timers = new Map();
  let timerId = 0;
  const elements = {};
  for (const name of ['updateModal', 'updateTitle', 'updateStep', 'updateDetail', 'updateProgressContainer', 'updateActions', 'btnCloseUpdate', 'btnInstallUpdate', 'updateProgress', 'updatePercent', 'updateSpeed', 'updateTransferred', 'updateTime']) {
    elements[name] = { textContent: '', disabled: false, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
  }
  const context = {
    window: {},
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../server/public/update-ui.js'), 'utf8'), context);
  const controller = context.window.VDS.updateUi.createController({
    elements,
    getServerBaseUrl: () => 'http://192.168.5.193:3000',
    getElectronApi: () => ({
      getRuntimeConfig: () => ({ updateFeedUrl: 'https://updates.test/updates/' }),
      quitAndInstall: install
    })
  });
  return { controller, elements, timers, runInstall: async () => {
    const [id, timer] = [...timers].find(([, timer]) => timer.delay === 1200);
    timers.delete(id);
    timer.fn();
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('update diagnostics show the trusted feed independently of LAN signaling', () => {
  const { controller } = harness(async () => true);
  assert.equal(controller.getUpdateManifestUrl(), 'https://updates.test/updates/latest.yml');
});

test('installation rejection restores error UI and permits a subsequent installation attempt', async () => {
  let calls = 0;
  const { controller, elements, runInstall } = harness(async () => ++calls === 1 ? false : true);
  controller.applyUpdateStatus({ status: 'downloaded', version: '2.0.0' });
  await runInstall();
  assert.equal(calls, 1);
  assert.match(elements.updateDetail.textContent, /update-install-failed/);
  assert.equal(elements.btnInstallUpdate.disabled, false);
  controller.applyUpdateStatus({ status: 'downloaded', version: '2.0.0' });
  await runInstall();
  assert.equal(calls, 2);
});

test('updater error after download is displayed and cancels the scheduled install', () => {
  const { controller, elements, timers } = harness(async () => true);
  controller.applyUpdateStatus({ status: 'downloaded', version: '2.0.0' });
  controller.applyUpdateStatus({ status: 'error', error: 'package-changed' });
  assert.match(elements.updateDetail.textContent, /package-changed/);
  assert.equal(elements.btnInstallUpdate.disabled, false);
  assert.equal(timers.size, 0);
});
