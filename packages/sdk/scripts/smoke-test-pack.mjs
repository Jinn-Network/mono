#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tarballArg = process.argv[2] ?? 'jinn-sdk.tgz';
const installTarget = tarballArg.includes('.tgz') || tarballArg.startsWith('.') || isAbsolute(tarballArg)
  ? (isAbsolute(tarballArg) ? tarballArg : resolve(sdkRoot, tarballArg))
  : tarballArg;
const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-sdk-pack-smoke-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tempRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const cmd = [command, ...args].join(' ');
    throw new Error(`${cmd} failed with exit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

try {
  writeFileSync(
    join(tempRoot, 'package.json'),
    `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`,
  );
  run('npm', ['install', '--silent', installTarget]);

  writeFileSync(
    join(tempRoot, 'smoke.mjs'),
    `
      import { SkippableError } from '@jinn-network/sdk';
      import { REQUIRES_LIVE_DAEMON_READINESS } from '@jinn-network/sdk/harness';
      import { validateSolverPluginManifest } from '@jinn-network/sdk/plugins';
      import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
      import {
        PredictionV1TaskSchema,
        buildSolutionOutput,
      } from '@jinn-network/sdk/solvernets/prediction-v1';

      if (typeof SkippableError !== 'function') throw new Error('missing root export');
      if (REQUIRES_LIVE_DAEMON_READINESS?.reason !== 'requires live daemon') throw new Error('missing harness export');
      if (typeof validateSolverPluginManifest !== 'function') throw new Error('missing plugins export');
      if (typeof getSolverNetContract !== 'function') throw new Error('missing solvernets export');
      if (typeof PredictionV1TaskSchema?.parse !== 'function') throw new Error('missing prediction-v1 schema export');
      if (typeof buildSolutionOutput !== 'function') throw new Error('missing prediction-v1 builder export');
    `,
  );
  run('node', ['smoke.mjs']);
  console.log(`sdk pack smoke passed for ${installTarget.includes('/') ? basename(installTarget) : installTarget}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
