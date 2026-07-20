#!/usr/bin/env node
/**
 * Validates the tarball shape produced by npm, matching `npm publish`.
 * Installs the pack with npm (same shape as consumers) then validates:
 * 1) local bin execution via `npm exec jinn ...`
 * 2) no-install package execution via package-name bin alias (`npm exec --package <tarball> -- client ...`)
 * 3) legacy `npx -p <tarball> jinn ...`
 * Expects cwd to be client/ (see package.json pack:smoke).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const smokeDir = mkdtempSync(join(tmpdir(), 'jinn-pack-smoke-'));
const smokeEnv = { ...process.env, HOME: smokeDir, NO_COLOR: '1' };
const installedPackageRoot = join(smokeDir, 'node_modules', '@jinn-network', 'client');
const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', smokeDir], {
  cwd: clientRoot,
  encoding: 'utf8',
});
if (pack.status !== 0) {
  console.error('smoke-test-pack: npm pack failed');
  console.error(pack.stderr || pack.stdout);
  process.exit(pack.status ?? 1);
}
let tarball;
try {
  const packed = JSON.parse(pack.stdout)[0];
  tarball = join(smokeDir, packed.filename);
} catch {
  console.error('smoke-test-pack: npm pack did not return JSON');
  console.error(pack.stdout);
  process.exit(1);
}

function parseJsonOrExit(stdout, context) {
  try {
    return JSON.parse((stdout || '').trim());
  } catch {
    console.error(`smoke-test-pack: ${context} stdout was not JSON`);
    console.error(stdout);
    process.exit(1);
  }
}

function assertVersionPayload(payload, context) {
  if (payload.schemaVersion !== 1) {
    console.error(`smoke-test-pack: expected schemaVersion 1 (${context})`);
    process.exit(1);
  }
  if (!payload.client?.version) {
    console.error(`smoke-test-pack: expected client.version (${context})`);
    process.exit(1);
  }
}

function assertTarballClean() {
  const result = spawnSync('tar', ['-tzf', tarball], {
    cwd: smokeDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('smoke-test-pack: could not inspect tarball contents');
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  const forbidden = result.stdout
    .split('\n')
    .filter((entry) => (
      entry.startsWith('package/.acceptance/') ||
      entry.startsWith('package/acceptance-runs/') ||
      entry.startsWith('package/.local/') ||
      entry.includes('/.env')
    ));
  if (forbidden.length > 0) {
    console.error('smoke-test-pack: tarball includes local acceptance or secret-bearing state');
    console.error(forbidden.slice(0, 20).join('\n'));
    process.exit(1);
  }
}

function runOrExit(command, args, context, options = {}) {
  const result = spawnSync(command, args, {
    cwd: smokeDir,
    encoding: 'utf8',
    env: smokeEnv,
    ...options,
  });
  if (result.status !== 0) {
    console.error(`smoke-test-pack: ${context} failed`);
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

try {
  assertTarballClean();

  const init = spawnSync('npm', ['init', '-y'], {
    cwd: smokeDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (init.status !== 0) process.exit(init.status ?? 1);

  const install = spawnSync('npm', ['install', tarball], {
    cwd: smokeDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);

  const nodePtyFix = join(installedPackageRoot, 'dist', 'scripts', 'fix-node-pty.mjs');
  if (!existsSync(nodePtyFix)) {
    console.error(`smoke-test-pack: missing node-pty fix script ${nodePtyFix}`);
    process.exit(1);
  }

  const run = runOrExit('npm', ['exec', '--', 'jinn', 'version', '--json'], 'npm exec');
  const payload = parseJsonOrExit(run.stdout, 'npm exec');
  assertVersionPayload(payload, 'npm exec');

  runOrExit('npm', ['exec', '--', 'jinn', '--help'], 'packed jinn --help');
  const doctor = spawnSync('npm', ['exec', '--', 'jinn', 'doctor', '--json'], {
    cwd: smokeDir,
    encoding: 'utf8',
    env: smokeEnv,
    timeout: 60_000,
  });
  if (doctor.error || doctor.status === 50) {
    console.error('smoke-test-pack: packed jinn doctor crashed');
    console.error(doctor.error ?? doctor.stderr ?? doctor.stdout);
    process.exit(doctor.status ?? 1);
  }
  parseJsonOrExit(doctor.stdout, 'packed jinn doctor');

  runOrExit(process.execPath, [nodePtyFix, '--verify'], 'node-pty verification');

  // jinn-layer bin (#1356): usage must print from the packed tarball's bin.
  const layerUsage = runOrExit('npm', ['exec', '--', 'jinn-layer'], 'jinn-layer usage');
  if (!layerUsage.stdout.includes('Usage: jinn-layer')) {
    console.error('smoke-test-pack: jinn-layer bin did not print usage');
    console.error(layerUsage.stdout);
    process.exit(1);
  }

  // C4: prove the installed tarball can load the vendored core plus native
  // better-sqlite3 and create the derived evidence index.
  const episodesDir = join(smokeDir, 'episodes');
  const evidenceIndex = join(smokeDir, 'evidence-index.sqlite');
  mkdirSync(episodesDir);
  const reindex = runOrExit(
    'npm',
    [
      'exec',
      '--',
      'jinn-layer',
      'reindex',
      '--json',
      '--episodes-dir',
      episodesDir,
      '--index-path',
      evidenceIndex,
    ],
    'jinn-layer reindex',
  );
  const reindexPayload = parseJsonOrExit(reindex.stdout, 'jinn-layer reindex');
  if (
    reindexPayload.status !== 'ok'
    || reindexPayload.report?.indexedEpisodes !== 0
    || !existsSync(evidenceIndex)
  ) {
    console.error('smoke-test-pack: jinn-layer reindex did not create an empty SQLite index');
    console.error(reindex.stdout);
    process.exit(1);
  }

  const npxDirect = runOrExit('npm', ['exec', '--yes', '--package', tarball, '--', 'client', 'version', '--json'], 'npx direct');
  assertVersionPayload(parseJsonOrExit(npxDirect.stdout, 'npx direct'), 'npx direct');

  const npxLegacy = runOrExit('npx', ['-p', tarball, 'jinn', 'version', '--json'], 'npx -p');
  assertVersionPayload(parseJsonOrExit(npxLegacy.stdout, 'npx -p'), 'npx -p');

  console.log('smoke-test-pack: ok', payload.client.version);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
