const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'server', 'public');
const excludedDirs = new Set(['vds_web']);

function collectJavaScriptFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) {
        collectJavaScriptFiles(fullPath, out);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

function toDisplayPath(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function main() {
  const files = collectJavaScriptFiles(publicRoot).sort((a, b) => toDisplayPath(a).localeCompare(toDisplayPath(b)));
  if (files.length === 0) {
    console.error('Renderer syntax check failed: no server/public JavaScript files found.');
    process.exit(1);
  }

  const failures = [];
  for (const filePath of files) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      cwd: root,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      failures.push({ filePath, result });
    }
  }

  if (failures.length > 0) {
    console.error('Renderer syntax check failed:');
    for (const failure of failures) {
      console.error(`- ${toDisplayPath(failure.filePath)}`);
      if (failure.result.stderr) {
        console.error(failure.result.stderr.trim());
      }
      if (failure.result.stdout) {
        console.error(failure.result.stdout.trim());
      }
    }
    process.exit(1);
  }

  console.log(`Renderer syntax check passed (${files.length} files).`);
}

main();
