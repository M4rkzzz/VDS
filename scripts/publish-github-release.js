const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

function resolveGitHubCli() {
  const explicitPath = process.env.GH_CLI_PATH;
  const candidates = [
    explicitPath,
    process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : null,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\GitHub CLI\\gh.exe' : null,
    'gh'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
    if (!path.isAbsolute(candidate)) {
      return candidate;
    }
  }

  return 'gh';
}

const githubCli = resolveGitHubCli();

function run(name, args, options = {}) {
  const display = [name].concat(args).join(' ');
  console.log(`\n$ ${display}`);
  const result = spawnSync(name, args, {
    cwd: projectRoot,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32' && !path.isAbsolute(name) && (name === 'npm' || name === 'gh')
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      throw new Error(`Command failed: ${display}${output ? `\n${output}` : ''}`);
    }
    throw new Error(`Command failed: ${display}`);
  }

  return options.capture ? String(result.stdout || '').trim() : '';
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required release asset: ${path.relative(projectRoot, filePath)}`);
  }
}

function ensureGitHubCliReady() {
  const versionOutput = run(githubCli, ['--version'], { capture: true });
  if (!/^gh version /m.test(versionOutput)) {
    throw new Error(`GitHub CLI is not the official gh executable: ${githubCli}`);
  }
  run(githubCli, ['auth', 'status'], { capture: true });
}

function ensureCleanWorktreeUnlessAllowed() {
  if (process.env.ALLOW_DIRTY_GITHUB_RELEASE === '1') {
    console.warn('ALLOW_DIRTY_GITHUB_RELEASE=1 is set; publishing with a dirty worktree is allowed.');
    return;
  }

  const status = run('git', ['status', '--porcelain'], { capture: true });
  if (status) {
    throw new Error(
      'Git worktree has uncommitted changes. Commit/stash them first, or set ALLOW_DIRTY_GITHUB_RELEASE=1 if this is intentional.'
    );
  }
}

function ensureTag(version, tagName) {
  const existingTag = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });

  if (existingTag.status === 0) {
    return;
  }

  run('git', ['tag', '-a', tagName, '-m', `VDS ${version}`]);
}

function ensureTagPushed(tagName) {
  run('git', ['push', 'origin', tagName]);
}

function releaseExists(tagName) {
  const result = spawnSync(githubCli, ['release', 'view', tagName], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && !path.isAbsolute(githubCli)
  });

  return result.status === 0;
}

function extractChangelogNotes(version) {
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    return `VDS ${version}`;
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const sectionHeader = `## ${version}`;
  const sectionStart = changelog.indexOf(sectionHeader);
  if (sectionStart < 0) {
    return `VDS ${version}`;
  }

  const bodyStart = sectionStart + sectionHeader.length;
  const nextSection = changelog.slice(bodyStart).search(/\r?\n## \d+\.\d+\.\d+\s*(?:\r?\n|$)/);
  const body = nextSection >= 0
    ? changelog.slice(bodyStart, bodyStart + nextSection)
    : changelog.slice(bodyStart);

  return body.trim() || `VDS ${version}`;
}

function writeNotesFile(version) {
  const notesPath = path.join(os.tmpdir(), `vds-release-${version}-notes.md`);
  fs.writeFileSync(notesPath, extractChangelogNotes(version), 'utf8');
  return notesPath;
}

function publishRelease(version) {
  const tagName = process.env.GITHUB_RELEASE_TAG || `v${version}`;
  const releaseTitle = process.env.GITHUB_RELEASE_TITLE || `VDS ${version}`;
  const distDir = path.join(projectRoot, 'dist');
  const installer = path.join(distDir, `VDS-Setup-${version}.exe`);
  const blockmap = `${installer}.blockmap`;
  const latest = path.join(distDir, 'latest.yml');

  ensureFile(installer);
  ensureFile(blockmap);
  ensureFile(latest);
  ensureGitHubCliReady();
  ensureCleanWorktreeUnlessAllowed();
  ensureTag(version, tagName);
  ensureTagPushed(tagName);

  const notesPath = writeNotesFile(version);
  const assets = [installer, blockmap, latest];

  if (releaseExists(tagName)) {
    if (process.env.GITHUB_RELEASE_REPLACE !== '1') {
      throw new Error(`GitHub release ${tagName} already exists. Set GITHUB_RELEASE_REPLACE=1 to replace its assets.`);
    }

    run(githubCli, ['release', 'edit', tagName, '--title', releaseTitle, '--notes-file', notesPath]);
    run(githubCli, ['release', 'upload', tagName].concat(assets).concat(['--clobber']));
  } else {
    run(githubCli, ['release', 'create', tagName].concat(assets).concat([
      '--title',
      releaseTitle,
      '--notes-file',
      notesPath
    ]));
  }

  console.log(`\nPublished GitHub release ${tagName}.`);
}

publishRelease(readPackageVersion());
