/**
 * Hermetic gate — 11-step bootstrap-from-scratch on the snapshot.
 *
 * Spec: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
 * §3.1 ("This gate also owns bootstrap-from-scratch correctness (the 11-step
 * FleetBootstrapper flow), which is the flakiest, most RPC-hungry thing in the
 * current tiers. Moving it here, on a snapshot, removes the setup storm that
 * causes most multi-day blocks.") and §6 Home 1 ("Bootstrap 11-step from scratch
 * | staking.ts + Tier-1 T1.1 + daemon-harness setup | [consolidate] one
 * bootstrap on the snapshot").
 *
 * This is the deterministic home for what the legacy `staking.ts` validator and
 * the `T1.1-bootstrap-fresh-anvil` tier scenario did against a LIVE Base fork —
 * the exact flow whose RPC-hunger and provider flakiness caused multi-day cut
 * blocks. Here it runs against the committed `--dump-state` snapshot via
 * `spawnAnvilFromState`: zero live RPC, so a red is a real bootstrap regression,
 * never infra.
 *
 * Flow (the production FleetBootstrapper, not a re-implementation):
 *   wallet → safe_predicted → awaiting_funding (ETH-only gate) → safe_deployed →
 *   service_created → service_activated → agents_registered → service_deployed →
 *   service_staked → mech_deployed → complete.
 * Funding is ETH-only on the master EOA (stOLAS mode — the OLAS bond is funded by
 * the distributor, not the Safe; see staking.ts Phase 3). The OLAS service
 * registry, staking contract, and stOLAS distributor are the REAL Base contracts
 * captured in the snapshot fork.
 *
 * Asserts the flow actually reached STAKED on-chain state (service state =
 * Deployed, service present in the staking contract's getServiceIds) — not just
 * "bootstrap() didn't throw" — mirroring staking.ts Phase 5.
 *
 * SKIP-CLEAN: if the committed fixture is absent (large + human-generated; see
 * docs/snapshots/base-v3-snapshot.md), the suite skips with a clear pointer
 * rather than failing — the gate workflow asserts the fixture's presence
 * separately and fails loud there.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { base } from 'viem/chains';
import {
  spawnAnvilFromState,
  jsonRpc as anvilJsonRpc,
  type AnvilHarness,
} from '../_support/chain/anvil.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { SERVICE_REGISTRY_L2_ABI, getChainConfig } from '../../src/earning/contracts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(TEST_DIR, '..', '_support', 'fixtures', 'anvil-base-v3-state');
const SNAPSHOT_STATE = join(SNAPSHOT_DIR, 'state.json');

const SNAPSHOT_PRESENT = existsSync(SNAPSHOT_STATE) || existsSync(SNAPSHOT_DIR);
const describeMaybe = SNAPSHOT_PRESENT ? describe : describe.skip;

if (!SNAPSHOT_PRESENT) {
  // eslint-disable-next-line no-console
  console.error(
    `[hermetic] snapshot fixture absent at ${SNAPSHOT_STATE} — skipping bootstrap-from-scratch ` +
      `suite. Run \`tsx contracts/scripts/build-anvil-snapshot.ts\` (needs BASE_RPC_URL) and ` +
      `commit the fixture to exercise this scenario.`,
  );
}

const PASSWORD = 'test-password';
const HUNDRED_ETH_HEX = '0x56BC75E2D63100000'; // 100 ETH in wei
const CHAIN_CONFIG = getChainConfig('base');

describeMaybe('hermetic bootstrap-from-scratch (spec §3.1 / §6 Home 1)', () => {
  let chain: AnvilHarness | null = null;
  let earningDir: string | null = null;

  beforeAll(async () => {
    chain = await spawnAnvilFromState({ statePath: SNAPSHOT_STATE });
    earningDir = await mkdtemp(join(tmpdir(), 'jinn-hermetic-bootstrap-'));
  }, 120_000);

  afterAll(async () => {
    if (chain) {
      try { await chain.teardown(); } catch { /* best-effort */ }
    }
    if (earningDir) {
      try { await rm(earningDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it(
    'runs the real 11-step FleetBootstrapper to a STAKED service on the snapshot',
    async () => {
      const rpcUrl = chain!.rpcUrl;
      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const stakingAbi = parseAbi([
        'function getServiceIds() view returns (uint256[])',
        'function getStakingState(uint256) view returns (uint8)',
      ]);

      // Snapshot the staking set BEFORE bootstrapping. The build-time warm-up
      // operator already left a fully-staked service in the fixture that would
      // satisfy every state assertion below (state===Deployed(4), in
      // getServiceIds, stakingState===1). Without a before/after diff, a
      // regression that REUSES an existing service instead of staking a fresh one
      // would false-pass. We assert the bootstrapped service is NOT in this set
      // and IS in the post-run set — proving THIS run executed a real stake.
      const serviceIdsBefore = (await publicClient.readContract({
        address: CHAIN_CONFIG.stakingContract as Address,
        abi: stakingAbi,
        functionName: 'getServiceIds',
      })).map(Number);

      // ── awaiting_funding: generate the master EOA (ETH-only gate) ───────────
      const bootstrapper1 = new FleetBootstrapper({ earningDir: earningDir!, chain: 'base', rpcUrl });
      const phase2 = await bootstrapper1.bootstrap(PASSWORD);
      expect(phase2.funding, `expected awaiting_funding gate, got ok=${phase2.ok} message=${phase2.message}`).toBeTruthy();
      const eoaAddress = phase2.funding!.master_address as Address;
      expect(eoaAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // ── fund the freshly-generated EOA with ETH on the loaded state ─────────
      await anvilJsonRpc(rpcUrl, 'anvil_setBalance', [eoaAddress, HUNDRED_ETH_HEX]);
      await anvilJsonRpc(rpcUrl, 'evm_mine', []);
      const fundClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const ethBalance = await fundClient.getBalance({ address: eoaAddress });
      expect(ethBalance, 'master EOA ETH balance still 0 after anvil_setBalance').toBeGreaterThan(0n);

      // ── re-bootstrap to completion (fresh provider avoids stale balance cache) ─
      const bootstrapper2 = new FleetBootstrapper({ earningDir: earningDir!, chain: 'base', rpcUrl });
      const phase4 = await bootstrapper2.bootstrap(PASSWORD);
      expect(phase4.ok, `bootstrap did not complete: ${phase4.message}`).toBe(true);

      const firstService = phase4.fleet_state.services[0];
      const serviceId = firstService?.service_id;
      const safeAddress = firstService?.safe_address as Address | undefined;
      expect(serviceId, 'no service_id after bootstrap complete').toBeDefined();
      expect(safeAddress, 'no safe_address after bootstrap complete').toBeTruthy();

      // ── prove the flow actually reached STAKED state on-chain (staking.ts §5) ─
      // Service state must be Deployed (4) — the terminal of service_deployed.
      const service = await publicClient.readContract({
        address: CHAIN_CONFIG.serviceRegistry as Address,
        abi: SERVICE_REGISTRY_L2_ABI,
        functionName: 'getService',
        args: [BigInt(serviceId!)],
      });
      expect(Number(service.state), 'service state is not Deployed(4)').toBe(4);

      // Service must be staked BY THIS RUN — present in getServiceIds now.
      const serviceIds = (await publicClient.readContract({
        address: CHAIN_CONFIG.stakingContract as Address,
        abi: stakingAbi,
        functionName: 'getServiceIds',
      })).map(Number);
      expect(
        serviceIds.includes(serviceId!),
        `service ${serviceId} not in staked set [${serviceIds.join(', ')}]`,
      ).toBe(true);

      // …and FRESH: it must NOT have been staked before this run. This is what
      // makes the test prove a real bootstrap-from-scratch rather than passing on
      // the build warm-up's leftover staked service (the §5 fidelity bar).
      // NB: the staking set is slot-bounded — a fresh stake can take a slot
      // without the set's length growing — so we assert membership + freshness,
      // not growth.
      expect(
        serviceIdsBefore.includes(serviceId!),
        `service ${serviceId} was already staked before this run ([${serviceIdsBefore.join(', ')}]) — bootstrap must stake a FRESH service, not reuse the warm-up's`,
      ).toBe(false);

      // staking state should be Staked (1) — read defensively (smoke the wiring).
      const stakingState = await publicClient.readContract({
        address: CHAIN_CONFIG.stakingContract as Address,
        abi: stakingAbi,
        functionName: 'getStakingState',
        args: [BigInt(serviceId!)],
      });
      expect(Number(stakingState)).toBe(1);
    },
    240_000,
  );
});
