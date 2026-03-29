const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const serverDir = path.join(projectRoot, 'server');
const updatesDir = path.join(serverDir, 'updates');
const retainedOldVersionCount = Math.max(
  0,
  Number(process.env.UPDATE_RETENTION_OLD_COUNT || process.env.UPDATE_RETENTION_COUNT || 5)
);

const requiredFiles = ['latest.yml'];
const installerPattern = /^VDS-Setup-(\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$/;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readLatestVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  return packageJson.version;
}

function resolveArtifactsDir(version) {
  const candidates = [
    process.env.UPDATE_DIST_DIR ? path.resolve(projectRoot, process.env.UPDATE_DIST_DIR) : null,
    path.join(projectRoot, 'dist'),
    path.join(projectRoot, `dist-${version}`)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const latestPath = path.join(candidate, 'latest.yml');
    const installerPath = path.join(candidate, `VDS-Setup-${version}.exe`);
    if (fs.existsSync(latestPath) && fs.existsSync(installerPath)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate build artifacts for ${version}. Checked: ${candidates.join(', ')}`
  );
}

function parseVersion(version) {
  return String(version || '')
    .split('.')
    .map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function uniqueVersions(versions) {
  return Array.from(new Set((versions || []).filter(Boolean)))
    .sort((left, right) => compareVersions(right, left));
}

function readRetainedVersions(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const versions = new Set();

  for (const entry of fs.readdirSync(dirPath)) {
    const match = installerPattern.exec(entry);
    if (match) {
      versions.add(match[1]);
    }
  }

  return uniqueVersions(Array.from(versions));
}

function readArtifactVersions() {
  const versions = new Set();
  const candidateDirs = [path.join(projectRoot, 'dist')];

  if (fs.existsSync(projectRoot)) {
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^dist-\d+\.\d+\.\d+$/.test(entry.name)) {
        candidateDirs.push(path.join(projectRoot, entry.name));
      }
    }
  }

  for (const dirPath of candidateDirs) {
    if (!fs.existsSync(dirPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(dirPath)) {
      const match = installerPattern.exec(entry);
      if (match && entry.endsWith('.exe')) {
        const version = match[1];
        const blockmapPath = path.join(dirPath, `VDS-Setup-${version}.exe.blockmap`);
        if (fs.existsSync(blockmapPath)) {
          versions.add(version);
        }
      }
    }
  }

  return uniqueVersions(Array.from(versions));
}

function copyFile(artifactsDir, fileName) {
  const sourcePath = path.join(artifactsDir, fileName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing build artifact: ${fileName}`);
  }

  const targetPath = path.join(updatesDir, fileName);
  fs.copyFileSync(sourcePath, targetPath);
}

function copyVersionedArtifacts(version, options = {}) {
  const { includeInstaller = false } = options;
  const artifactsDir = resolveArtifactsDir(version);
  copyFile(artifactsDir, `VDS-Setup-${version}.exe.blockmap`);
  if (includeInstaller) {
    copyFile(artifactsDir, `VDS-Setup-${version}.exe`);
  }
  return artifactsDir;
}

function isBlockmapFile(fileName) {
  return String(fileName || '').endsWith('.exe.blockmap');
}

function pruneOldArtifacts(dirPath, currentVersion, oldVersions) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const allowedOldVersions = new Set(oldVersions);

  for (const entry of fs.readdirSync(dirPath)) {
    if (requiredFiles.includes(entry)) {
      continue;
    }

    const match = installerPattern.exec(entry);
    if (!match) {
      fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true });
      continue;
    }

    const entryVersion = match[1];
    const keepEntry = entryVersion === currentVersion
      ? true
      : isBlockmapFile(entry) && allowedOldVersions.has(entryVersion);

    if (!keepEntry) {
      fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true });
    }
  }
}

function main() {
  const version = readLatestVersion();
  const artifactsDir = resolveArtifactsDir(version);
  const retainedVersions = uniqueVersions(
    [version]
      .concat(readRetainedVersions(updatesDir))
      .concat(readArtifactVersions())
  )
    .slice(0, retainedOldVersionCount + 1);
  const retainedOldVersions = retainedVersions.filter((entry) => entry !== version);

  ensureDir(updatesDir);

  for (const fileName of requiredFiles) {
    copyFile(artifactsDir, fileName);
  }

  copyVersionedArtifacts(version, { includeInstaller: true });

  for (const retainedVersion of retainedOldVersions) {
    copyVersionedArtifacts(retainedVersion, { includeInstaller: false });
  }

  pruneOldArtifacts(updatesDir, version, retainedOldVersions);

  console.log(`Prepared server release in ${updatesDir}`);
  console.log(`Using build artifacts from ${artifactsDir}`);
  console.log(
    `Retained update versions: ${retainedVersions.join(', ')} (current exe+blockmap, old blockmap only)`
  );
  for (const fileName of fs.readdirSync(updatesDir)) {
    console.log(`- ${fileName}`);
  }
}

main();
