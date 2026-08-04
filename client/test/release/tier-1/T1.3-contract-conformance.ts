/**
 * T1.3 — read-contract conformance (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 4 "contract conformance test in the release tiers").
 *
 * Boot-less by design: unlike T1.1 (Anvil fork) and T1.2 (spawned daemon), this scenario
 * needs no daemon, no RPC, no filesystem state beyond the repo checkout itself. It validates
 * a captured/fixture `StatusV1Response` payload against `client/src/api/contract/status.ts`'s
 * schema, asserts `contractVersion` is present, and asserts the committed
 * `client/openapi.v1.json` regenerates clean (drift here means someone edited a contract
 * schema without regenerating the artifact — exactly what this gate exists to catch).
 */
import * as path from 'node:path';
import { statusV1ResponseSchema } from '../../../src/api/contract/status.js';
import { CURRENT_CONTRACT_VERSION } from '../../../src/api/contract/version.js';
import { buildOpenApiDocument } from '../../../scripts/generate-openapi.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

/**
 * A captured-shaped `StatusV1Response` fixture — every required field present, the optional
 * per-vertical blocks omitted (a real daemon omits them too when the corresponding subsystem
 * isn't wired; see `status-build.ts`'s `assembleStatusV1`). Kept in this module (not a
 * separate JSON file) so a schema change and its fixture update land in the same diff.
 */
function fixtureStatusV1Payload(): unknown {
  return {
    contractVersion: { major: CURRENT_CONTRACT_VERSION.major, minor: CURRENT_CONTRACT_VERSION.minor },
    statusMode: 'full',
    version: '0.2.0',
    latestVersion: null,
    daemon: { shutdownState: null, startedAt: '2026-08-01T00:00:00.000Z', dbPath: '/tmp/jinn.db', timestamp: '2026-08-04T00:00:00.000Z' },
    rpc: { ok: true, chainId: 8453, blockNumber: '12345678' },
    fleet: { loaded: true, chain: 'base', stakingMode: 'standard', masterAddress: '0xmaster', services: [], stakedLikeCount: 0, completeCount: 0 },
    autoRestake: { enabled: false, checkIntervalMs: 0 },
    activity: { counts: {}, recent: [] },
    rewards: { claimLoopIntervalMs: 0, lastClaimTickAt: null, claimedStakingRewardsWei: '0', claimedStakingRewardsLast24hWei: null },
    balances: {
      eth: {
        master: { address: '0xmaster', balanceWei: '0' },
        agent: { address: null, balanceWei: null },
        safe: { address: null, balanceWei: null },
      },
    },
    masterGas: { address: '0xmaster', dailyEstimateWei: '0' },
    earnings: { hint: 'fixture' },
    nextActions: [],
    costSurface: { harnesses: {} },
    harness: { ready: true, name: null, reason: null },
    security: { lastPasswordRotationAt: null },
    effectiveMode: 'legacy',
  };
}

export async function runT13ContractConformance(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  return runScenario('T1.3', opts, async ({ log }) => {
    log('Phase 1: validate a fixture StatusV1 payload against statusV1ResponseSchema');
    const fixture = fixtureStatusV1Payload();
    const parsed = statusV1ResponseSchema.parse(fixture);
    log('  parsed OK');

    log('Phase 2: assert contractVersion is present and matches the current contract version');
    if (parsed.contractVersion.major !== CURRENT_CONTRACT_VERSION.major
      || parsed.contractVersion.minor !== CURRENT_CONTRACT_VERSION.minor) {
      throw new Error(
        `contractVersion mismatch: fixture=${JSON.stringify(parsed.contractVersion)} current=${JSON.stringify(CURRENT_CONTRACT_VERSION)}`,
      );
    }
    log(`  contractVersion=${JSON.stringify(parsed.contractVersion)}`);

    log('Phase 3: assert the committed openapi.v1.json regenerates clean');
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
