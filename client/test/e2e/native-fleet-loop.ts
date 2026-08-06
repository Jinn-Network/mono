// client/test/e2e/native-fleet-loop.ts
/**
 * Native fleet G-loop rig (one-swap M7, umbrella #2461, DR-2026-08-05).
 *
 * Public command: `JINN_E2E_MODE=native yarn e2e:daemon-harness` (or `yarn e2e:daemon-harness:native`).
 *
 * Per the coordinator ruling the native variant forks **Base Sepolia 84532** — an Anvil `--fork-url`
 * of a Sepolia RPC, driving the pinned `BASE_SEPOLIA_TODAY` addresses that `assertNativeDeployment`
 * requires unrelaxed (the legacy variant keeps its Base-mainnet fork). This is the opposite fork
 * target from `daemon-harness-cycle.ts`, and it is deliberate: native boot refuses any chain but
 * 84532 with the exact today addresses, so the rig must fork the chain those addresses live on.
 *
 * What THIS rig proves on the fork, and what it leaves to the deploy-time gate:
 *
 *  PROVEN-on-fork (asserted here):
 *   - `assertNativeDeployment` passes against the forked BASE_SEPOLIA_TODAY contracts (real code on
 *     the fork), chainId 84532, `today` generation — the native boot gate.
 *   - The trust/identity boot leg end-to-end against REAL Base Sepolia finality: the fixture writes a
 *     finalized on-chain calldata anchor (Anvil 1.6 advances the `finalized` tag to latest-64, so a
 *     buried anchor reads back finalized), `openNativeTrustCatalog` resolves it through the
 *     production `createBaseSepoliaFinalizedAnchorClient`, and every native role identity
 *     (`openRoleIdentitySet`) proves its effective-time binding for BOTH operators. This is the
 *     single most novel, finality-gated leg of the native boot, and it runs here without any mock.
 *
 *  SEEDED-fixture / DEPLOY-TIME (documented, not asserted here — see the leg table this prints and
 *  the M7 PR body):
 *   - A live requester record source serving a signed `.well-known` introduction: the full
 *     `buildFleetNativeRuntime` boot fetches it at construction (`buildNativeDiscoverySources`), so
 *     the discovery/solve/adopt legs need the M6 serving plane live for both operators.
 *   - A funded, mech-registered operator Safe (FleetBootstrapper on a Sepolia fork) and the escrowed
 *     marketplace post/claim/deliver legs.
 *   - Container-graded evaluation (DR decision 3a) — Docker, deploy-time by construction.
 *
 * Skips cleanly (exit 0) when no Base Sepolia RPC is reachable, exactly like the legacy variant skips
 * on an absent harness key — a CI runner without outbound RPC must not red-gate.
 */
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { spawnAnvilFork } from '../_support/chain/anvil.js';
import { assertNativeDeployment } from '../../src/daemon/native-vertical-mode.js';
import { openNativeTrustCatalog } from '../../src/daemon/native-trust-catalog.js';
import {
  createBaseSepoliaFinalizedAnchorClient,
  createViemBaseSepoliaReadClients,
} from '../../src/daemon/native-base-sepolia-infrastructure.js';
import { openRoleIdentitySet } from '../../src/daemon/role-identities.js';
import { ANVIL_PRIVATE_KEYS } from './_daemon-harness-helpers.js';
import { buildTwoOperatorNativeSetup } from './fixtures/native-fleet/config.js';
import { createForkAnchorSubmitter } from './fixtures/native-fleet/anchor.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PASSWORD = 'native-e2e-fleet-password';

function sepoliaRpcFromEnv(): string | undefined {
  return process.env['JINN_E2E_SEPOLIA_RPC']
    ?? process.env['BASE_SEPOLIA_RPC_URL']
    ?? 'https://base-sepolia.publicnode.com';
}

async function reachable(rpcUrl: string): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const chainId = await client.getChainId();
    return chainId === 84532;
  } catch {
    return false;
  }
}

export async function runNativeFleetLoop(): Promise<void> {
  const rpcUrl = sepoliaRpcFromEnv();
  if (rpcUrl === undefined || !(await reachable(rpcUrl))) {
    console.log('\n=== native-fleet e2e — SKIPPED: no reachable Base Sepolia (84532) RPC ===');
    return;
  }

  console.log('\n=== native-fleet G-loop rig — fork Base Sepolia 84532 ===');
  const anvil = await spawnAnvilFork({ forkUrl: rpcUrl, chain: baseSepolia, silent: true });
  const root = await mkdtemp(join(tmpdir(), 'native-fleet-rig-'));
  try {
    console.log(`anvil rpc: ${anvil.rpcUrl}`);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]!);
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(anvil.rpcUrl) });
    await anvil.setBalance(account.address, 100n * 10n ** 18n);

    // ── LEG 0: native boot gate — assertNativeDeployment + forked contract code ──────────────
    assertNativeDeployment({ network: 'testnet', chain: BASE_SEPOLIA_TODAY });
    for (const [name, address] of Object.entries({
      taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
      mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
      activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
    })) {
      const code = await publicClient.getBytecode({ address: address as `0x${string}` });
      if (code === undefined || code === '0x') {
        throw new Error(`native boot gate: forked ${name} at ${address} has no code — wrong fork target?`);
      }
    }
    console.log('  ✓ LEG 0 PROVEN — assertNativeDeployment + forked BASE_SEPOLIA_TODAY contract code');

    // ── LEG 1: on-chain-anchored trust catalog + role-identity boot, REAL fork finality ──────
    const submitAnchor = createForkAnchorSubmitter({ rpcUrl: anvil.rpcUrl, publicClient, walletClient, account });
    const setup = await buildTwoOperatorNativeSetup({
      rootDir: root,
      password: PASSWORD,
      rpcUrl: anvil.rpcUrl,
      ipfsApiUrl: 'http://127.0.0.1:5001',
      ceremonyAccount: account,
      submitAnchor,
      aPublicBaseUrl: 'http://127.0.0.1:7401/a',
      bPublicBaseUrl: 'http://127.0.0.1:7402/b',
      aSafeAddress: account.address,
    });
    console.log('  · authored trust catalog with an on-chain finalized anchor');

    const bootDate = new Date(setup.bootTime);
    const now = () => bootDate;
    const anchorClient = createBaseSepoliaFinalizedAnchorClient(
      createViemBaseSepoliaReadClients(publicClient).anchor,
    );
    const trust = await openNativeTrustCatalog({
      path: setup.trustRootsPath,
      expectedPolicyGenesisDigest: setup.trustPolicyGenesisDigest,
      anchorClient,
      now: bootDate,
    });
    console.log('  · openNativeTrustCatalog accepted the fork-anchored catalog (production anchor client)');

    const aSolver = await openRoleIdentitySet({
      agent: setup.operatorA.agentIri,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: setup.operatorA.solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    const aRequester = await openRoleIdentitySet({
      agent: setup.operatorA.agentIri,
      requiredRoles: ['requester-submission', 'requester-discovery'],
      storePath: setup.operatorA.requesterStore!.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    const admission = await openRoleIdentitySet({
      agent: setup.operatorA.admissionAgent!,
      requiredRoles: ['admission'],
      storePath: setup.operatorA.admissionStore!.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    const bSolver = await openRoleIdentitySet({
      agent: setup.operatorB.agentIri,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: setup.operatorB.solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    // Independence check: A and B are honestly distinct — different agents, different keys.
    if (aSolver.get('solver-delivery').keyId === bSolver.get('solver-delivery').keyId) {
      throw new Error('operators A and B minted the same solver key — not honestly separate');
    }
    if (admission.get('admission').keyId === aRequester.get('requester-submission').keyId) {
      throw new Error('admission custody is not a distinct key from the requester');
    }
    console.log('  ✓ LEG 1 PROVEN — fork-finalized trust anchor + every native role identity boots (A + B)');

    // ── LEG 2+: the marketplace + serving legs the fork can seed but not fully self-provide ───
    printLegTable();
    console.log('\n=== native-fleet rig: boot legs PROVEN on fork; loop legs are seeded/deploy-time (table above) ===');
  } finally {
    await anvil.teardown();
  }
}

function printLegTable(): void {
  console.log('\nG-loop leg status (rig scope):');
  const rows: Array<[string, string]> = [
    ['LEG 0  boot gate (assertNativeDeployment + forked code)', 'PROVEN-on-fork'],
    ['LEG 1  trust anchor + role-identity boot (A + B)', 'PROVEN-on-fork'],
    ['LEG 2  requester source .well-known serving (M6)', 'SEEDED (deploy-time serves it live)'],
    ['LEG 3  operator Safe funded + mech-registered', 'DEPLOY-TIME (FleetBootstrapper on live Sepolia)'],
    ['LEG 4  requester post (M5e) — escrowed createTask', 'DEPLOY-TIME (needs funded Safe)'],
    ['LEG 5  operator B discover + claim + deliver (M3)', 'DEPLOY-TIME (needs live source + funded Safe)'],
    ['LEG 6  native evaluate (M4a) — container-graded', 'DEPLOY-TIME (Docker; DR decision 3a)'],
    ['LEG 7  operator A adopt (M5f)', 'DEPLOY-TIME (needs a real delivery)'],
  ];
  for (const [leg, status] of rows) console.log(`  - ${leg}: ${status}`);
}

/** Self-execute only when run directly (`tsx native-fleet-loop.ts`), not when imported for delegation. */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runNativeFleetLoop().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
