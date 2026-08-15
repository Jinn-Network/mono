#!/usr/bin/env node
/**
 * Proves the packed client can load startup-reachable code that imports private
 * workspace packages after installation in an isolated consumer project.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = mkdtempSync(join(tmpdir(), 'jinn-private-runtime-smoke-'));

function run(command, args, context, options = {}) {
  const result = spawnSync(command, args, {
    cwd: smokeDir,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `smoke-test-pack-private-runtime: ${context} failed\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

try {
  const pack = run(
    'npm',
    ['pack', '--json', '--pack-destination', smokeDir],
    'npm pack',
    { cwd: clientRoot },
  );

  const [{ filename }] = JSON.parse(pack.stdout);
  const tarball = join(smokeDir, filename);
  run('npm', ['init', '-y'], 'npm init');
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      tarball,
      'typescript@6.0.3',
      '@types/node@25.9.1',
      '@types/better-sqlite3@7.6.0',
    ],
    'isolated npm install',
  );

  const mineableStore = join(
    smokeDir,
    'node_modules',
    '@jinn-network',
    'client',
    'dist',
    'solver-types',
    '_swe-rebench-v2-mineable-store.js',
  );
  run(process.execPath, [mineableStore], 'compiled mineable store import');

  writeFileSync(join(smokeDir, 'consumer.mts'), `
import type { DaemonConfig } from '@jinn-network/client';

type HarvestConfig = NonNullable<DaemonConfig['harvest']>;
type RestorationEngineRetired = 'restorationEngine' extends keyof DaemonConfig ? false : true;
type HarvestStoreRetired = 'mineableStore' extends keyof HarvestConfig ? false : true;

const restorationEngineRetired: RestorationEngineRetired = true;
const harvestStoreRetired: HarvestStoreRetired = true;

void restorationEngineRetired;
void harvestStoreRetired;
`);
  // @safe-global/types-kit@4.0.1 has declarations that reference a package
  // subpath it does not export. Keep that unrelated upstream defect from
  // masking private Jinn declaration leaks while leaving skipLibCheck disabled.
  writeFileSync(join(smokeDir, 'safe-types-shim.d.ts'), `
declare module '@safe-global/types-kit/types' {
  export type SafeVersion = string;
  export type TransactionOptions = unknown;
  export type TransactionResult = unknown;
}
`);
  writeFileSync(join(smokeDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      types: ['node'],
    },
    files: ['consumer.mts', 'safe-types-shim.d.ts'],
  }));
  const tsc = join(smokeDir, 'node_modules', '.bin', 'tsc');
  run(tsc, ['--project', 'tsconfig.json'], 'public declaration graph compile');

  console.log('smoke-test-pack-private-runtime: ok');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
