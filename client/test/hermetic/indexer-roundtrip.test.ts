/**
 * Hermetic gate — real indexer round-trip on the snapshot (closes #341 / spec §6
 * Home 1 "Indexer round-trip | [new] local Ponder vs snapshot").
 *
 * This is the sole indexer round-trip coverage: it proves BOTH that the
 * daemon's GraphQL queries match the indexer schema (it throws on GraphQL
 * schema errors) AND a real on-chain → indexed round-trip. It posts a REAL task
 * on the snapshot's V3 router, spawns a local Ponder pointed at the snapshot
 * (via the env-gated "snapshot mode" in packages/indexer/ponder.config.ts), and
 * polls Ponder's GraphQL until the task is indexed — catching the fufn /
 * 2026-05-23 indexer-schema-drift regression class end to end.
 *
 * Deterministic: the chain is the committed snapshot (spawnAnvilFromState, no
 * live RPC); Ponder indexes only the snapshot's JinnRouter. SKIP-CLEAN when the
 * fixture is absent.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { spawnAnvilFromState, type AnvilHarness } from '../_support/chain/anvil.js';
import { spawnPonderIndexer, type PonderHandle } from '../_support/indexer/ponder.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(TEST_DIR, '..', '_support', 'fixtures', 'anvil-base-v3-state');
const SNAPSHOT_STATE = join(SNAPSHOT_DIR, 'state.json');
const SNAPSHOT_ADDRESSES = join(SNAPSHOT_DIR, 'addresses.json');
const CONTRACTS_DIR = resolve(TEST_DIR, '..', '..', '..', 'contracts');

const SNAPSHOT_PRESENT = existsSync(SNAPSHOT_STATE) || existsSync(SNAPSHOT_DIR);
const describeMaybe = SNAPSHOT_PRESENT ? describe : describe.skip;

if (!SNAPSHOT_PRESENT) {
  // eslint-disable-next-line no-console
  console.error(
    `[hermetic] snapshot fixture absent at ${SNAPSHOT_STATE} — skipping indexer round-trip. ` +
      `Run \`tsx contracts/scripts/build-anvil-snapshot.ts\` (needs BASE_RPC_URL) and commit the fixture.`,
  );
}

const SNAPSHOT_CHAIN_ID = 8453;
const OPERATOR_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex;

async function loadArtifact(p: string): Promise<{ abi: Abi }> {
  const raw = JSON.parse(await readFile(join(CONTRACTS_DIR, p), 'utf8')) as { abi: Abi };
  return { abi: raw.abi };
}

function decodeFirst(receipt: { logs: readonly unknown[] }, abi: Abi, eventName: string): Record<string, unknown> {
  for (const log of receipt.logs as Log[]) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === eventName) return decoded.args as Record<string, unknown>;
    } catch { /* not this event */ }
  }
  throw new Error(`missing ${eventName} event`);
}

interface GqlTasks {
  data?: { tasks?: { items?: Array<{ id: string; taskCidDigest: string; manifestDigest: string; chainId: number }> } };
  errors?: Array<{ message?: string }>;
}

describeMaybe('hermetic indexer round-trip (spec §6 Home 1 / #341)', () => {
  let chain: AnvilHarness | null = null;
  let indexer: PonderHandle | null = null;
  let publicClient: PublicClient;
  let operator: PrivateKeyAccount;
  let routerAddress: Address;
  let routerAbi: Abi;
  let mechAbi: Abi;
  let marketplaceAbi: Abi;
  let mockMechAddress: Address;
  let marketplaceAddress: Address;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    chain = await spawnAnvilFromState({ statePath: SNAPSHOT_STATE });
    publicClient = createPublicClient({ chain: base, transport: http(chain.rpcUrl) }) as unknown as PublicClient;
    operator = privateKeyToAccount(OPERATOR_PRIVATE_KEY);

    const manifest = JSON.parse(await readFile(SNAPSHOT_ADDRESSES, 'utf8')) as { router: Address; mockMech: Address };
    routerAddress = manifest.router;
    mockMechAddress = manifest.mockMech;
    routerAbi = (await loadArtifact('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json')).abi;
    mechAbi = (await loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json')).abi;
    marketplaceAbi = (await loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json')).abi;
    marketplaceAddress = (await publicClient.readContract({
      address: routerAddress, abi: routerAbi, functionName: 'mechMarketplace',
    })) as Address;
  }, 60_000);

  afterAll(async () => {
    if (indexer) { try { await indexer.teardown(); } catch { /* best-effort */ } }
    if (chain) { try { await chain.teardown(); } catch { /* best-effort */ } }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it(
    'posts a task on the snapshot router and Ponder indexes it (real round-trip)',
    async () => {
      const rpcUrl = chain!.rpcUrl;
      const mechRate = (await publicClient.readContract({ address: mockMechAddress, abi: mechAbi, functionName: 'maxDeliveryRate' })) as bigint;
      const responseTimeout = (await publicClient.readContract({ address: marketplaceAddress, abi: marketplaceAbi, functionName: 'minResponseTimeout' })) as bigint;

      // `anvil --load-state` restores ONLY the dumped tip block — blocks below it
      // don't exist. Ponder's finality lookback queries ~30 blocks below its start
      // block, so mine a buffer of real blocks above the loaded tip and index from
      // there (the sub-start lookback then lands on a block that genuinely exists).
      await chain!.mineBlocks(100);
      const startBlock = await publicClient.getBlockNumber();

      // ── Post a real task on the snapshot's V3 router ───────────────────────
      const block = await publicClient.getBlock();
      const nowSec = Number(block.timestamp);
      // Tokenless-OLAS pivot: TaskPolicy is { maxClaims, allowSolverSelfEvaluation } (bool, default false → self-eval blocked).
      const policy = { maxClaims: 10, allowSolverSelfEvaluation: false };
      const salt = `indexer:${nowSec}:${startBlock}`;
      const taskCidDigest = keccak256(toBytes(`task:${salt}`)) as Hex;
      const manifestDigest = keccak256(toBytes(`manifest:${salt}`)) as Hex;
      const budget = mechRate * 10n + mechRate * 10n;

      const wallet = createWalletClient({ account: operator, chain: base, transport: http(rpcUrl) });
      const hash = await wallet.writeContract({
        address: routerAddress, abi: routerAbi, functionName: 'createTask',
        args: [taskCidDigest, manifestDigest, policy, mechRate, mechRate, responseTimeout],
        value: budget, account: operator, chain: base,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('createTask reverted');
      const taskId = BigInt(String(decodeFirst(receipt, routerAbi, 'TaskCreated')['taskId']));
      expect(taskId).toBeGreaterThan(0n);

      // Advance past Ponder's finality window so the task's block is indexed —
      // Ponder only indexes finalized blocks, and nothing else advances the tip.
      await chain!.mineBlocks(50);

      // ── Spawn Ponder in snapshot mode, targeting the snapshot router ───────
      for (const k of ['JINN_INDEXER_SNAPSHOT_ROUTER', 'JINN_INDEXER_SNAPSHOT_CHAIN_ID', 'JINN_INDEXER_SNAPSHOT_START_BLOCK']) {
        savedEnv[k] = process.env[k];
      }
      process.env['JINN_INDEXER_SNAPSHOT_ROUTER'] = routerAddress;
      process.env['JINN_INDEXER_SNAPSHOT_CHAIN_ID'] = String(SNAPSHOT_CHAIN_ID);
      process.env['JINN_INDEXER_SNAPSHOT_START_BLOCK'] = String(startBlock);

      // Ponder dev cold-compiles the complete indexer on hosted Linux runners.
      // Keep this below the enclosing 240s test timeout while allowing the cold
      // path enough headroom before the 90s indexed-data poll below.
      indexer = await spawnPonderIndexer({ rpcUrl, chainId: SNAPSHOT_CHAIN_ID, readyTimeoutMs: 120_000 });

      // ── Poll Ponder's GraphQL until the task is indexed ────────────────────
      const query = `query { tasks(limit: 100) { items { id taskCidDigest manifestDigest chainId } } }`;
      const deadline = Date.now() + 90_000;
      let indexed: { id: string; taskCidDigest: string; manifestDigest: string; chainId: number } | undefined;
      let lastErr = '';
      while (Date.now() < deadline && !indexed) {
        try {
          const res = await fetch(indexer.graphqlUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
          });
          const json = (await res.json()) as GqlTasks;
          if (json.errors?.length) {
            // A GraphQL error here is a real daemon-vs-indexer SCHEMA drift signal.
            lastErr = json.errors.map((e) => e.message ?? '?').join('; ');
            throw new Error(`indexer GraphQL schema error: ${lastErr}`);
          }
          indexed = json.data?.tasks?.items?.find((t) => t.taskCidDigest?.toLowerCase() === taskCidDigest.toLowerCase());
        } catch (err) {
          // Schema errors must surface; transient connection/not-yet-synced retries.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('schema error')) throw err;
          lastErr = msg;
        }
        if (!indexed) await new Promise<void>((r) => setTimeout(r, 1000));
      }

      expect(indexed, `task ${taskCidDigest} was never indexed by Ponder (last: ${lastErr})`).toBeTruthy();
      // The indexed row must round-trip the on-chain fields the daemon reads.
      expect(indexed!.manifestDigest.toLowerCase()).toBe(manifestDigest.toLowerCase());
      expect(Number(indexed!.chainId)).toBe(SNAPSHOT_CHAIN_ID);
    },
    180_000,
  );
});
