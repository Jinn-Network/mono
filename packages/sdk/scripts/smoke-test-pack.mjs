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
      import {
        AutopilotAdoptionReceiptSchema,
        AutopilotCorrelationSchema,
        AutopilotDeliveryExpectationSchema,
        AutopilotDeliveryObservationSchema,
        AutopilotMutationResultSchema,
        AutopilotReviewResultSchema,
        AutopilotSessionCapsuleSchema,
        TaskSubmitRequestV1Schema,
        TaskSubmitResultV1Schema,
        parseAutopilotAdoptionReceiptComment,
      } from '@jinn-network/sdk/autopilot';
      import {
        AutopilotDeliveryExpectationSchema as SolverNetDeliveryExpectationSchema,
        TaskSubmitRequestV1Schema as SolverNetTaskSubmitRequestV1Schema,
      } from '@jinn-network/sdk/solvernets/jinn-repo';
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import { dirname, join } from 'node:path';

      if (typeof SkippableError !== 'function') throw new Error('missing root export');
      if (REQUIRES_LIVE_DAEMON_READINESS?.reason !== 'requires live daemon') throw new Error('missing harness export');
      if (typeof validateSolverPluginManifest !== 'function') throw new Error('missing plugins export');
      if (typeof getSolverNetContract !== 'function') throw new Error('missing solvernets export');
      if (typeof PredictionV1TaskSchema?.parse !== 'function') throw new Error('missing prediction-v1 schema export');
      if (typeof buildSolutionOutput !== 'function') throw new Error('missing prediction-v1 builder export');
      if (typeof TaskSubmitRequestV1Schema?.parse !== 'function') throw new Error('missing Autopilot submit request export');
      if (typeof TaskSubmitResultV1Schema?.parse !== 'function') throw new Error('missing Autopilot submit result export');
      if (typeof AutopilotDeliveryExpectationSchema?.parse !== 'function') throw new Error('missing delivery expectation export');
      if (typeof AutopilotDeliveryObservationSchema?.parse !== 'function') throw new Error('missing delivery observation export');
      if (SolverNetTaskSubmitRequestV1Schema !== TaskSubmitRequestV1Schema) throw new Error('SolverNet submit schema identity drift');
      if (SolverNetDeliveryExpectationSchema !== AutopilotDeliveryExpectationSchema) throw new Error('SolverNet delivery schema identity drift');

      const require = createRequire(import.meta.url);
      const manifestPath = require.resolve('@jinn-network/sdk/fixtures/autopilot/manifest.json');
      const fixtureRoot = dirname(manifestPath);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const decoders = {
        AutopilotSessionCapsuleSchema,
        AutopilotMutationResultSchema,
        AutopilotReviewResultSchema,
        AutopilotAdoptionReceiptSchema,
        AutopilotCorrelationSchema,
        TaskSubmitRequestV1Schema,
        TaskSubmitResultV1Schema,
        AutopilotDeliveryExpectationSchema,
        AutopilotDeliveryObservationSchema,
      };
      for (const entry of manifest.fixtures) {
        const bytes = readFileSync(join(fixtureRoot, entry.path));
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== entry.sha256) throw new Error('fixture hash mismatch: ' + entry.path);
        if (entry.schema === 'AutopilotAdoptionReceiptComment') {
          if (parseAutopilotAdoptionReceiptComment(bytes.toString('utf8').trimEnd()) === null) {
            throw new Error('comment fixture does not decode');
          }
        } else {
          const decoder = decoders[entry.schema];
          if (!decoder) throw new Error('unknown fixture schema: ' + entry.schema);
          const decoded = decoder.safeParse(JSON.parse(bytes.toString('utf8'))).success;
          if (decoded !== (entry.decode === 'accept')) throw new Error('fixture disposition mismatch: ' + entry.path);
        }
      }
    `,
  );
  run('node', ['smoke.mjs']);
  console.log(`sdk pack smoke passed for ${installTarget.includes('/') ? basename(installTarget) : installTarget}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
