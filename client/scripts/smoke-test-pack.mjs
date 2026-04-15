#!/usr/bin/env node
/**
 * Validates the tarball produced by `yarn pack -o jinn-client.tgz`.
 * Installs the pack with npm (same shape as consumers) then runs `jinn version`.
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
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    process.exit(run.status ?? 1);
  }

  let payload;
  try {
    payload = JSON.parse((run.stdout || '').trim());
  } catch {
    console.error('smoke-test-pack: version stdout was not JSON');
    console.error(run.stdout);
    process.exit(1);
  }

  if (payload.schemaVersion !== 1) {
    console.error('smoke-test-pack: expected schemaVersion 1');
    process.exit(1);
  }
  if (!payload.client?.version) {
    console.error('smoke-test-pack: expected client.version');
    process.exit(1);
  }

  console.log('smoke-test-pack: ok', payload.client.version);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
