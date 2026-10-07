const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const buildInstruction = 'Run npm run build:media-agent before verification or packaging.';

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing native build/runtime file: ${filePath}. ${buildInstruction}`);
  }
}

function sha256(filePath) {
  requireFile(filePath);
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function validateNativeRuntime({ root = projectRoot, configuration = 'Release', packagedDir } = {}) {
  const buildDir = path.join(root, 'media-agent', 'build');
  const icePrefix = path.join(buildDir, 'vds-ice', 'installed');
  const markerPath = path.join(icePrefix, 'vds-enhanced-ice.txt');
  requireFile(markerPath);
  const marker = fs.readFileSync(markerPath, 'utf8');
  const algorithmHash = sha256(path.join(root, 'media-agent', 'src', 'nat_port_prediction.h')).slice(0, 12);
  for (const [name, version] of [['libjuice', '1.7.0'], ['libdatachannel', '0.24.1']]) {
    const patchHash = sha256(path.join(root, 'media-agent', 'third_party', 'ice-patches', `${name}-${version}-vds.patch`)).slice(0, 12);
    const expectedStamp = `${name}=${version}-${patchHash}-${algorithmHash}`;
    if (!marker.split(/\r?\n/).some((line) => line.replace(/^\uFEFF/, '').trim() === expectedStamp)) {
      throw new Error(`Enhanced ICE build does not match current sources: ${name}. ${buildInstruction}`);
    }
  }

  const configuredBinary = path.join(buildDir, configuration, 'vds-media-agent.exe');
  const builtBinary = fs.existsSync(configuredBinary) ? configuredBinary : path.join(buildDir, 'vds-media-agent.exe');
  const sources = [
    ['vds-media-agent.exe', builtBinary],
    ['juice.dll', path.join(icePrefix, 'bin', 'juice.dll')],
    ['datachannel.dll', path.join(icePrefix, 'bin', 'datachannel.dll')]
  ];
  return sources.map(([name, sourcePath]) => {
    const sourceHash = sha256(sourcePath);
    const runtimePath = path.join(root, 'runtime', 'media-agent', name);
    const runtimeHash = sha256(runtimePath);
    if (sourceHash !== runtimeHash) {
      throw new Error(`Native runtime differs from the current build: ${name}\nbuild sha256=${sourceHash}\nruntime sha256=${runtimeHash}\n${buildInstruction}`);
    }
    if (packagedDir) {
      const packagedHash = sha256(path.join(packagedDir, name));
      if (runtimeHash !== packagedHash) {
        throw new Error(`Packaged native runtime differs from runtime/media-agent: ${name}\nruntime sha256=${runtimeHash}\npackaged sha256=${packagedHash}\nRun npm run build after native verification.`);
      }
    }
    return { name, sha256: runtimeHash };
  });
}

module.exports = { validateNativeRuntime };
