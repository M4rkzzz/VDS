const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const requiredFiles = [
  'server/package.json',
  'server/package-lock.json',
  'server/Dockerfile',
  'server/docker-compose.yml',
  'server/index.js',
  'server/server-core.js',
  'server/public/index.html',
  'server/public/vds_web/index.html',
  'server/updates/latest.yml'
];

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Docker context missing required file: ${relativePath}`);
  }
}

const dockerfilePath = path.join(projectRoot, 'server/Dockerfile');
const dockerfileText = fs.readFileSync(dockerfilePath, 'utf8');
if (!/\bEXPOSE\s+3000(?:\s+3010|\s.*\b3010\b)/.test(dockerfileText)) {
  throw new Error('Dockerfile must expose both signaling port 3000 and admin port 3010.');
}

const composePath = path.join(projectRoot, 'server/docker-compose.yml');
const composeText = fs.readFileSync(composePath, 'utf8');
for (const expectedText of ['"3000:3000"', '"3010:3010"', 'ADMIN_PORT: 3010']) {
  if (!composeText.includes(expectedText)) {
    throw new Error(`docker-compose.yml missing required admin/signaling setting: ${expectedText}`);
  }
}

const webIndexPath = path.join(projectRoot, 'server/public/vds_web/index.html');
const webIndexText = fs.readFileSync(webIndexPath, 'utf8');
const referencedWebAssets = new Set();
for (const match of webIndexText.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
  const value = match[1].trim();
  if (value.startsWith('/vds_web/')) {
    referencedWebAssets.add(value.slice('/vds_web/'.length));
  } else if (!value.includes('://') && !value.startsWith('#') && value) {
    referencedWebAssets.add(value.replace(/^\.\//, ''));
  }
}

if (referencedWebAssets.size === 0) {
  throw new Error('Docker context VDS Web index does not reference any local assets.');
}

for (const assetPath of referencedWebAssets) {
  const absolutePath = path.join(projectRoot, 'server/public/vds_web', assetPath);
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size <= 0) {
    throw new Error(`Docker context missing VDS Web asset referenced by index.html: server/public/vds_web/${assetPath}`);
  }
}

const latestPath = path.join(projectRoot, 'server/updates/latest.yml');
const latestText = fs.readFileSync(latestPath, 'utf8');
const referencedUpdateFiles = new Set();

for (const match of latestText.matchAll(/^\s*(?:path|url):\s*['"]?([^'"\r\n]+)['"]?\s*$/gm)) {
  const value = match[1].trim();
  if (value && !value.includes('://')) {
    referencedUpdateFiles.add(value);
  }
}

if (referencedUpdateFiles.size === 0) {
  throw new Error('Docker context update manifest does not reference an installer path.');
}

for (const fileName of referencedUpdateFiles) {
  const relativePath = path.join('server/updates', fileName);
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size <= 0) {
    throw new Error(`Docker context missing update artifact referenced by latest.yml: ${relativePath}`);
  }

  const blockmapPath = `${absolutePath}.blockmap`;
  if (!fs.existsSync(blockmapPath) || fs.statSync(blockmapPath).size <= 0) {
    throw new Error(`Docker context missing update blockmap referenced by latest.yml: ${relativePath}.blockmap`);
  }
}

console.log('server Docker context check passed');
