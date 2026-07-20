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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const coreRoot = join(clientRoot, '..', 'packages', 'core');
const pluginRoot = join(clientRoot, '..', 'packages', 'plugin');
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

const corePack = spawnSync('npm', ['pack', '--json', '--pack-destination', smokeDir], {
  cwd: coreRoot,
  encoding: 'utf8',
});
if (corePack.status !== 0) {
  console.error('smoke-test-pack: core npm pack failed');
  console.error(corePack.stderr || corePack.stdout);
  process.exit(corePack.status ?? 1);
}
let coreTarball;
try {
  const packed = JSON.parse(corePack.stdout)[0];
  coreTarball = join(smokeDir, packed.filename);
} catch {
  console.error('smoke-test-pack: core npm pack did not return JSON');
  console.error(corePack.stdout);
  process.exit(1);
}

const pluginPack = spawnSync('npm', ['pack', '--json', '--pack-destination', smokeDir], {
  cwd: pluginRoot,
  encoding: 'utf8',
});
if (pluginPack.status !== 0) {
  console.error('smoke-test-pack: plugin npm pack failed');
  console.error(pluginPack.stderr || pluginPack.stdout);
  process.exit(pluginPack.status ?? 1);
}
let pluginTarball;
try {
  const packed = JSON.parse(pluginPack.stdout)[0];
  pluginTarball = join(smokeDir, packed.filename);
} catch {
  console.error('smoke-test-pack: plugin npm pack did not return JSON');
  console.error(pluginPack.stdout);
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

  const install = spawnSync('npm', ['install', pluginTarball, coreTarball, tarball], {
    cwd: smokeDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);

  const donationGate = join(installedPackageRoot, 'dist', 'scripts', 'donation-consumption-acceptance.js');
  const nodePtyFix = join(installedPackageRoot, 'dist', 'scripts', 'fix-node-pty.mjs');
  if (!existsSync(donationGate)) {
    console.error(`smoke-test-pack: missing compiled donation gate ${donationGate}`);
    process.exit(1);
  }
  if (!existsSync(nodePtyFix)) {
    console.error(`smoke-test-pack: missing node-pty fix script ${nodePtyFix}`);
    process.exit(1);
  }

  const run = runOrExit('npm', ['exec', '--', 'jinn', 'version', '--json'], 'npm exec');
  const payload = parseJsonOrExit(run.stdout, 'npm exec');
  assertVersionPayload(payload, 'npm exec');

  const gateHelp = runOrExit(process.execPath, [donationGate, '--help'], 'compiled donation gate --help');
  if (!gateHelp.stdout.includes('Strict release gate for cross-operator donated SWE execution data consumption')) {
    console.error('smoke-test-pack: compiled donation gate help text was not recognized');
    console.error(gateHelp.stdout);
    process.exit(1);
  }

  runOrExit(process.execPath, [nodePtyFix, '--verify'], 'node-pty verification');

  // jinn-layer bin (#1356): usage must print from the packed tarball's bin.
  const layerUsage = runOrExit('npm', ['exec', '--', 'jinn-layer'], 'jinn-layer usage');
  if (!layerUsage.stdout.includes('Usage: jinn-layer')) {
    console.error('smoke-test-pack: jinn-layer bin did not print usage');
    console.error(layerUsage.stdout);
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
