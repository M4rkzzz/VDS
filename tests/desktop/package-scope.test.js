const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const { FileMatcher, getNodeModuleFileMatcher, getMainFileMatchers } = require('app-builder-lib/out/fileMatcher');
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
const { assertPackagedScope } = require('../../scripts/release-check');

const root = path.resolve(__dirname, '../..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function productionFilter(arch, platformOptions = config.build.win) {
  const builderConfig = doMergeConfigs([structuredClone({ ...config.build, win: platformOptions })]);
  const destination = path.join(root, 'tmp', 'unused-package-filter');
  const expand = value => value.replaceAll('${arch}', arch);
  const rootMatcher = getNodeModuleFileMatcher(root, destination, expand, builderConfig.win, {
    config: builderConfig, debugLogger: { isEnabled: false }
  });
  // NodeModuleCopyHelper deliberately uses no filter when the matcher is empty.
  if (rootMatcher.isEmpty()) return () => true;
  const moduleSource = path.join(root, 'node_modules', 'koffi');
  const matcher = new FileMatcher(moduleSource, path.join(destination, 'node_modules', 'koffi'), expand, rootMatcher.patterns);
  const filter = matcher.createFilter();
  return (relative, directory = false) => filter(path.join(moduleSource, relative), {
    moduleFullFilePath: path.join('node_modules', 'koffi', relative),
    isDirectory: () => directory
  });
}

function applicationFilter(platformOptions = config.build.win) {
  // Builder normalizes root files into FileSet objects before selecting the
  // platform matcher. Raw package.json options merge differently and conceal
  // negative-only win.files falling back to the default **/* application scope.
  const builderConfig = doMergeConfigs([structuredClone({ ...config.build, win: platformOptions })]);
  const matchers = getMainFileMatchers(root, path.join(root, 'tmp', 'unused-app-filter'),
    value => value.replaceAll('${arch}', 'x64'), builderConfig.win, { info: {
      config: builderConfig, projectDir: root, buildResourcesDir: 'build',
      isPrepackedAppAsar: false, debugLogger: { isEnabled: false }
    } }, path.join(root, 'dist'), false);
  const filters = matchers.map(matcher => {
    assert.equal(matcher.from, root);
    return matcher.createFilter();
  });
  return (relative, directory = false) => filters.some(filter =>
    filter(path.join(root, relative), { isDirectory: () => directory }));
}

test('actual Windows application matcher preserves the source whitelist and excludes development/runtime/update trees', () => {
  const included = applicationFilter();
  for (const filename of ['desktop/main.js', 'desktop/update-trust.json', 'server/public/index.html',
    'server/public/vds_web/assets/app.js', 'package.json']) {
    assert.equal(included(filename), true, filename);
  }
  for (const directory of ['desktop', 'server', 'server/public']) assert.equal(included(directory, true), true, directory);
  for (const filename of ['tmp/secret.key', 'runtime/media-agent/vds-media-agent.exe',
    'media-agent/build/Release/vds-media-agent.exe', 'server/updates/VDS-Setup-1.7.2.exe',
    'server/package.json', 'scripts/prepare-server-release.js', 'docs/PROJECT_STATUS.md', 'package-lock.json']) {
    assert.equal(included(filename), false, filename);
  }
  for (const directory of ['tmp', 'runtime', 'media-agent', 'media-agent/build', 'server/updates']) {
    assert.equal(included(directory, true), false, directory);
  }
});

test('the builder negative-only platform override reproduces the leakage and the real whitelist prevents it', () => {
  const negativeOnly = { ...config.build.win, files: config.build.win.files.filter(pattern => pattern.startsWith('!')) };
  const unsafeFilter = applicationFilter(negativeOnly);
  const safeFilter = applicationFilter();
  for (const filename of ['tmp/secret.key', 'runtime/media-agent/vds-media-agent.exe',
    'media-agent/build/Release/vds-media-agent.exe', 'server/updates/VDS-Setup-1.7.2.exe']) {
    assert.equal(unsafeFilter(filename), true, filename);
    assert.equal(safeFilter(filename), false, filename);
  }
});

test('postbuild archive scope accepts ASAR directory entries and both platform path separators', () => {
  const entries = ['\\desktop', '\\desktop\\main.js', '\\server', '\\server\\public',
    '\\server\\public\\index.html', '\\node_modules', '\\node_modules\\koffi\\index.js', '\\package.json'];
  assert.deepEqual(assertPackagedScope(entries).topLevel, ['desktop', 'node_modules', 'package.json', 'server']);
  assert.equal(assertPackagedScope(entries.map(entry => entry.replaceAll('\\', '/'))).entries, entries.length);
});

test('postbuild archive scope rejects private trees, server updates and malformed paths before release', () => {
  const entries = ['/desktop', '/server', '/server/public', '/node_modules', '/package.json'];
  for (const forbidden of ['/tmp', '/tmp/secret.key', '/runtime/media-agent/agent.exe', '/media-agent/build',
    '\\server\\updates', '\\server\\updates\\installer.exe', '/server/package.json',
    '/desktop/../tmp/secret.key', '/desktop//main.js', '/package.json/nested']) {
    assert.throws(() => assertPackagedScope([...entries, forbidden]), /out-of-scope/, forbidden);
  }
  assert.throws(() => assertPackagedScope(['/desktop']), /missing/);
});

test('Windows dependency filtering preserves Koffi loader and target native binding, excluding other ABI folders', () => {
  for (const arch of ['x64', 'arm64', 'ia32']) {
    const included = productionFilter(arch);
    assert.equal(included('index.js'), true);
    assert.equal(included('package.json'), true);
    assert.equal(included('build/koffi', true), true);
    assert.equal(included(`build/koffi/win32_${arch}`, true), true);
    assert.equal(included(`build/koffi/win32_${arch}/koffi.node`), true);
    for (const other of ['win32_x64', 'win32_arm64', 'win32_ia32', 'linux_x64', 'musl_x64', 'darwin_arm64', 'freebsd_x64']) {
      if (other === `win32_${arch}`) continue;
      assert.equal(included(`build/koffi/${other}`, true), false, `${arch}: ${other} directory must not be traversed`);
      assert.equal(included(`build/koffi/${other}/koffi.node`), false, `${arch}: ${other} binary must not ship`);
    }
  }
});

test('Windows-specific Koffi exclusion does not constrain a future non-Windows build', () => {
  const included = productionFilter('x64', {});
  assert.equal(included('build/koffi/linux_x64/koffi.node'), true);
  assert.equal(included('index.js'), true);
});

test('server dependencies retain independent production scope while root development tools still resolve them', () => {
  const server = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
  const rootLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const serverLock = JSON.parse(fs.readFileSync(path.join(root, 'server/package-lock.json'), 'utf8'));
  for (const name of ['express', 'ws']) {
    assert.equal(config.dependencies[name], undefined);
    assert.equal(config.devDependencies[name], server.dependencies[name]);
    assert.equal(rootLock.packages[`node_modules/${name}`].dev, true);
    assert.notEqual(serverLock.packages[`node_modules/${name}`].dev, true);
    assert.ok(require.resolve(name));
  }
});

test('every literal desktop package import remains in the installed production dependency closure', () => {
  const builtin = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), 'electron']);
  const imports = new Set();
  function visitFile(filename) {
    const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
    function visit(node) {
      let specifier;
      if (ts.isCallExpression(node) && (node.expression.getText(ast) === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)) specifier = node.arguments[0];
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) imports.add(specifier.text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (/\.[cm]?js$/.test(entry.name)) visitFile(filename);
    }
  }
  walk(path.join(root, 'desktop'));
  const rootLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const specifier of imports) {
    if (specifier.startsWith('.') || path.isAbsolute(specifier) || builtin.has(specifier)) continue;
    const resolved = require.resolve(specifier, { paths: [path.join(root, 'desktop')] });
    let directory = path.dirname(resolved);
    while (directory !== root && !fs.existsSync(path.join(directory, 'package.json'))) {
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory, `package root for ${specifier}`);
      directory = parent;
    }
    const key = path.relative(root, directory).replaceAll(path.sep, '/');
    assert.ok(rootLock.packages[key], `locked runtime package for ${specifier}`);
    assert.notEqual(rootLock.packages[key].dev, true, `desktop import ${specifier} must survive npm ci --omit=dev`);
  }
});
