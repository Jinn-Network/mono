/**
 * T1.3 — read-contract conformance (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 4 "contract conformance test in the release tiers").
 *
 * Boot-less by design: unlike T1.1 (Anvil fork) and T1.2 (spawned daemon), this scenario
 * needs no daemon, no RPC, no filesystem state beyond the repo checkout itself. Three checks:
 *
 * 1. The REAL producer (`assembleStatusV1`, not a test-authored fixture) is called against a
 *    minimal `GatheredStatusRaw` and its output validated against `statusV1ResponseSchema`,
 *    asserting the stamped `contractVersion` matches `CURRENT_CONTRACT_VERSION`. Building the
 *    fixture from `CURRENT_CONTRACT_VERSION` and asserting equality against itself would be a
 *    tautology (a review finding on an earlier version of this scenario) — this calls the
 *    production code path so a producer that stops stamping `contractVersion`, or stamps the
 *    wrong one, actually fails the test.
 * 2. `CONTRACT_SHAPE_SHA` (`version.ts`) matches a live recompute of the schema's hash — a
 *    forcing function: a shape change without updating that constant fails here, three lines
 *    from `CURRENT_CONTRACT_VERSION`, prompting a version-bump decision.
 * 3. The committed `openapi.v1.json` regenerates clean.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { statusV1ResponseSchema } from '../../../src/api/contract/status.js';
import { CURRENT_CONTRACT_VERSION, CONTRACT_SHAPE_SHA } from '../../../src/api/contract/version.js';
import { assembleStatusV1, type GatheredStatusRaw } from '../../../src/api/status-build.js';
import { buildOpenApiDocument } from '../../../scripts/generate-openapi.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

/** A minimal but real `GatheredStatusRaw` — the sqlite_only shape from status-build.test.ts. */
function minimalGatheredStatusRaw(): GatheredStatusRaw {
  return {
    hintsScope: 'sqlite_only',
    shutdownState: 'running',
    dbPath: '/tmp/x.db',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 0,
    fleet: null,
    rpc: { ok: true },
    master: { address: null },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1000',
  };
}

export async function runT13ContractConformance(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  return runScenario('T1.3', opts, async ({ log }) => {
    log('Phase 1: call the real assembleStatusV1() producer and validate its output');
    const produced = assembleStatusV1(minimalGatheredStatusRaw());
    const parsed = statusV1ResponseSchema.parse(produced);
    log('  parsed OK');

    log('Phase 2: assert the producer stamped contractVersion === CURRENT_CONTRACT_VERSION');
    if (parsed.contractVersion.major !== CURRENT_CONTRACT_VERSION.major
      || parsed.contractVersion.minor !== CURRENT_CONTRACT_VERSION.minor) {
      throw new Error(
        `contractVersion mismatch: produced=${JSON.stringify(parsed.contractVersion)} current=${JSON.stringify(CURRENT_CONTRACT_VERSION)}`,
      );
    }
    log(`  contractVersion=${JSON.stringify(parsed.contractVersion)}`);

    log('Phase 3: assert CONTRACT_SHAPE_SHA matches a live recompute of the schema hash');
    const jsonSchema = z.toJSONSchema(statusV1ResponseSchema, { target: 'draft-2020-12', unrepresentable: 'any' });
    const liveSha = createHash('sha256').update(JSON.stringify(jsonSchema)).digest('hex');
    if (liveSha !== CONTRACT_SHAPE_SHA) {
      throw new Error(
        `CONTRACT_SHAPE_SHA is stale: committed=${CONTRACT_SHAPE_SHA} live=${liveSha}. ` +
        'The contract schema changed — update CONTRACT_SHAPE_SHA in src/api/contract/version.ts ' +
        '(and consider whether CURRENT_CONTRACT_VERSION needs a bump).',
      );
    }
    log(`  CONTRACT_SHAPE_SHA=${liveSha} matches`);

    log('Phase 4: assert the committed openapi.v1.json regenerates clean');
    const openapiPath = fileURLToPath(new URL('../../../openapi.v1.json', import.meta.url));
    const committed = readFileSync(openapiPath, 'utf-8');
    const fresh = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    if (committed !== fresh) {
      throw new Error(
        `${path.basename(openapiPath)} is out of date — run \`yarn generate:openapi\` and commit the result.`,
      );
    }
    log('  openapi.v1.json matches regeneration');

    log('contract conformance OK');
    return { verdict: 'pass' };
  });
}
