const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'server', 'public');
const indexPath = path.join(publicRoot, 'index.html');

const expectedScripts = [
  'app-state.js',
  'debug-panel.js',
  'quality-settings.js',
  'source-selection.js',
  'room-client.js',
  'update-ui.js',
  'app.js',
  'native/native-diagnostics.js',
  'native/native-stats-controller.js',
  'native/native-media-engine-controller.js',
  'native/p2p-state-machine.js',
  'native/native-renderer-state-controller.js',
  'native/native-surface-controller.js',
  'native/native-peer-controller.js',
  'native/native-peer-message-controller.js',
  'native/native-session-controller.js',
  'native/native-room-message-controller.js',
  'native/native-viewer-controls.js',
  'native/native-viewer-fullscreen-controls.js',
  'native/native-entry.js',
  'app-native-overrides.js'
];

function extractScripts(html) {
  const scripts = [];
  const regex = /<script\s+src="([^"]+)"\s*>\s*<\/script>/g;
  for (const match of html.matchAll(regex)) {
    scripts.push(match[1].replace(/\\/g, '/'));
  }
  return scripts;
}

function main() {
  const html = fs.readFileSync(indexPath, 'utf8');
  const scripts = extractScripts(html);
  const errors = [];

  if (scripts.length !== expectedScripts.length) {
    errors.push(`Expected ${expectedScripts.length} script tags, found ${scripts.length}.`);
  }

  const maxLength = Math.max(scripts.length, expectedScripts.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (scripts[index] !== expectedScripts[index]) {
      errors.push(
        `Script order mismatch at ${index + 1}: expected ${expectedScripts[index] || '<none>'}, found ${scripts[index] || '<none>'}.`
      );
    }
  }

  for (const script of expectedScripts) {
    const scriptPath = path.join(publicRoot, ...script.split('/'));
    if (!fs.existsSync(scriptPath)) {
      errors.push(`Script file does not exist: ${script}`);
    }
  }

  if (errors.length > 0) {
    console.error('Renderer entry check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Renderer entry check passed (${expectedScripts.length} scripts).`);
}

main();
