#!/usr/bin/env node
/**
 * Validates the tarball produced by `yarn pack -o jinn-client.tgz`.
 * Installs the pack with npm (same shape as consumers) then validates:
 * 1) local bin execution via `npm exec jinn ...`
 * 2) no-install package execution via package-name bin alias (`npm exec --package <tarball> -- client ...`)
 * 3) legacy `npx -p <tarball> jinn ...`
 * Expects cwd to be client/ (see package.json pack:smoke).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const tarball = resolve(clientRoot, 'jinn-client.tgz');

if (!existsSync(tarball)) {
  console.error(`smoke-test-pack: missing ${tarball} — run yarn pack first`);
  process.exit(1);
}

const smokeDir = mkdtempSync(join(tmpdir(), 'jinn-pack-smoke-'));
const smokeEnv = { ...process.env, HOME: smokeDir, NO_COLOR: '1' };

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

try {
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

  const run = spawnSync('npm', ['exec', '--', 'jinn', 'version', '--json'], {
    cwd: smokeDir,
    encoding: 'utf8',
    env: smokeEnv,
  });
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    process.exit(run.status ?? 1);
  }

  const payload = parseJsonOrExit(run.stdout, 'npm exec');
  assertVersionPayload(payload, 'npm exec');

  const npxDirect = spawnSync('npm', ['exec', '--yes', '--package', tarball, '--', 'client', 'version', '--json'], {
    cwd: smokeDir,
    encoding: 'utf8',
    env: smokeEnv,
  });
  if (npxDirect.status !== 0) {
    console.error(npxDirect.stderr || npxDirect.stdout);
    process.exit(npxDirect.status ?? 1);
  }
  assertVersionPayload(parseJsonOrExit(npxDirect.stdout, 'npx direct'), 'npx direct');

  const npxLegacy = spawnSync('npx', ['-p', tarball, 'jinn', 'version', '--json'], {
    cwd: smokeDir,
    encoding: 'utf8',
    env: smokeEnv,
  });
  if (npxLegacy.status !== 0) {
    console.error(npxLegacy.stderr || npxLegacy.stdout);
    process.exit(npxLegacy.status ?? 1);
  }
  assertVersionPayload(parseJsonOrExit(npxLegacy.stdout, 'npx -p'), 'npx -p');

  console.log('smoke-test-pack: ok', payload.client.version);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
