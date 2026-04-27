import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { encodeEventTopics, getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  migrateAgentIds,
  findAgentIdForOwner,
} from '../../src/earning/migrate-agent-id.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveMasterAddress,
  deriveAgentSigner,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState, type ServiceState } from '../../src/earning/types.js';
import {
  IDENTITY_REGISTRY_ABI,
  getChainConfig,
} from '../../src/earning/contracts.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** Build a minimal `getLogs`-shaped Registered log for the typed-event API. */
function makeRegisteredLog(
  agentId: bigint,
  owner: string,
  txHash: string,
  blockNumber = 1n,
) {
  // viem's getLogs (with typed event) returns logs whose `args` is the
  // decoded set. We don't drive viem's decoder here — we hand-shape the
  // object the way our code consumes it (`log.args.{agentId,agentURI,owner}`,
  // `log.transactionHash`).
  return {
    address: REGISTRY,
    blockNumber,
    transactionHash: txHash,
    logIndex: 0,
    transactionIndex: 0,
    blockHash: '0x' + 'ab'.repeat(32),
    removed: false,
    data: '0x',
    topics: encodeEventTopics({
      abi: IDENTITY_REGISTRY_ABI,
      eventName: 'Registered',
      args: { agentId, owner: owner as `0x${string}` },
    }),
    args: {
      agentId,
      agentURI: '',
      owner,
    },
    eventName: 'Registered',
  };
}

interface FakePublicClient {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (args: any) => Promise<any[]>;
}

function makeFakePublicClient(opts: {
  blockNumber?: bigint;
  logs?: any[];
  onGetLogs?: (args: any) => void;
}): FakePublicClient {
  const blockNumber = opts.blockNumber ?? 100n;
  return {
    getBlockNumber: async () => blockNumber,
    getLogs: async (args: any) => {
      opts.onGetLogs?.(args);
      return opts.logs ?? [];
    },
  };
}

async function setupFleet(
  earningDir: string,
  services: ServiceState[],
): Promise<{ store: FleetStateStore; mnemonic: string }> {
  const mnemonic = generateMnemonic();
  const encrypted = await encryptMnemonic(mnemonic, 'pw');
  const store = new FleetStateStore(earningDir);
  await store.saveMnemonicKeystore(encrypted);
  await store.save({
    ...createDefaultFleetState('base'),
    master_address: deriveMasterAddress(mnemonic),
    services,
  });
  return { store, mnemonic };
}

function legacyCompleteService(index: number, agentAddress: string): ServiceState {
  return {
    index,
    agent_address: agentAddress,
    safe_address: '0x' + (index.toString(16).padStart(2, '0')).repeat(20),
    service_id: 100 + index,
    mech_address: '0x' + 'd' + 'd'.repeat(38) + index.toString(16),
    staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
    step: 'complete',
    error: null,
    // Legacy: missing all the j07-added fields
    agent_id: null,
    agent_uri: null,
    identity_registry_address: null,
    agent_registered_tx: null,
    safe_bound_to_agent: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('migrateAgentIds (jinn-mono-jgp)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('mints when state=complete && agent_id=null and no on-chain NFT exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-migrate-'));
    dirs.push(dir);

    const config = getChainConfig('base');
    config.rpcUrl = 'http://127.0.0.1:8545';

    // Pre-derive the agent signer for index=1 so the fake state matches.
    const mnemonicTmp = generateMnemonic();
    const tmpAgent = deriveAgentSigner(mnemonicTmp, 1);
    const { store, mnemonic } = await setupFleet(dir, [
      legacyCompleteService(1, tmpAgent.address),
    ]);
    // Override agent_address with the actual agent we'll derive
    const realAgent = deriveAgentSigner(mnemonic, 1);
    await store.updateService(1, { agent_address: realAgent.address });

    // Fake chain: no past Registered events for this owner.
    const publicClient = makeFakePublicClient({ blockNumber: 100n, logs: [] });

    // Track wallet writes — ensure exactly one mint happens.
    const sentTxs: any[] = [];
    const fakeWalletClient = {
      sendTransaction: async (req: any) => {
        sentTxs.push(req);
        return '0x' + 'aa'.repeat(32);
      },
    };
    // Also stub waitForTransactionReceiptWithRetry path: we monkey-patch by
    // overriding publicClient with the receipt walk, since
    // waitForTransactionReceiptWithRetry calls publicClient.waitForTransactionReceipt.
    (publicClient as any).waitForTransactionReceipt = async () => ({
      status: 'success',
      logs: [
        // Hand-build a Registered log on the registry address with topic + data.
        {
          address: REGISTRY,
          topics: encodeEventTopics({
            abi: IDENTITY_REGISTRY_ABI,
            eventName: 'Registered',
            args: { agentId: 7n, owner: realAgent.address as `0x${string}` },
          }),
          data:
            // ABI-encoded empty string: offset 0x20 + length 0
            '0x' +
            '0000000000000000000000000000000000000000000000000000000000000020' +
            '0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });

    const result = await migrateAgentIds({
      stateStore: store,
      config,
      network: 'base',
      mnemonic,
      publicClient: publicClient as any,
      walletClientFactory: () => fakeWalletClient as any,
    });

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].agent_id).toBe('7');
    expect(result.migrated[0].identity_registry_address).toBe(getAddress(REGISTRY));
    expect(result.migrated[0].agent_registered_tx).toBe('0x' + 'aa'.repeat(32));
    expect(result.migrated[0].step).toBe('complete'); // unchanged
    expect(sentTxs).toHaveLength(1); // exactly one mint tx

    // Persisted state reflects the migration.
    const persisted = await store.load('base');
    expect(persisted.services[0].agent_id).toBe('7');
  });

  it('skips services that already have agent_id', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-migrate-'));
    dirs.push(dir);

    const config = getChainConfig('base');
    config.rpcUrl = 'http://127.0.0.1:8545';

    const tmp = generateMnemonic();
    const tmpAgent = deriveAgentSigner(tmp, 1);
    const { store, mnemonic } = await setupFleet(dir, [
      {
        ...legacyCompleteService(1, tmpAgent.address),
        agent_id: '999',
        agent_uri: '',
        identity_registry_address: REGISTRY,
        agent_registered_tx: '0x' + 'cc'.repeat(32),
      },
    ]);
    const realAgent = deriveAgentSigner(mnemonic, 1);
    await store.updateService(1, { agent_address: realAgent.address });

    // Spy on publicClient.getLogs — we should never call it for an
    // already-populated service.
    let getLogsCalls = 0;
    const publicClient = makeFakePublicClient({
      blockNumber: 100n,
      logs: [],
      onGetLogs: () => {
        getLogsCalls++;
      },
    });

    const result = await migrateAgentIds({
      stateStore: store,
      config,
      network: 'base',
      mnemonic,
      publicClient: publicClient as any,
    });

    expect(result.migrated).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].agent_id).toBe('999');
    expect(getLogsCalls).toBe(0); // short-circuit before any chain read
  });

  it('recovers existing agentId from chain (no double-mint) when Safe owner already has an NFT', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-migrate-'));
    dirs.push(dir);

    const config = getChainConfig('base');
    config.rpcUrl = 'http://127.0.0.1:8545';

    const tmp = generateMnemonic();
    const tmpAgent = deriveAgentSigner(tmp, 1);
    const { store, mnemonic } = await setupFleet(dir, [
      legacyCompleteService(1, tmpAgent.address),
    ]);
    const realAgent = deriveAgentSigner(mnemonic, 1);
    await store.updateService(1, { agent_address: realAgent.address });

    // Chain returns a prior Registered event for this owner (agentId=42)
    const priorTx = '0x' + 'ee'.repeat(32);
    const publicClient = makeFakePublicClient({
      blockNumber: 100n,
      logs: [makeRegisteredLog(42n, realAgent.address, priorTx)],
    });

    // If the migration wrongly tries to mint, this will throw.
    const fakeWalletClient = {
      sendTransaction: async () => {
        throw new Error('Migration must NOT call sendTransaction when an NFT is recovered from chain');
      },
    };

    const result = await migrateAgentIds({
      stateStore: store,
      config,
      network: 'base',
      mnemonic,
      publicClient: publicClient as any,
      walletClientFactory: () => fakeWalletClient as any,
    });

    expect(result.failed).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].agent_id).toBe('42');
    expect(result.migrated[0].agent_registered_tx).toBe(priorTx);
    expect(result.migrated[0].identity_registry_address).toBe(getAddress(REGISTRY));
  });

  it('one failing service does not abort migration of others', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-migrate-'));
    dirs.push(dir);

    const config = getChainConfig('base');
    config.rpcUrl = 'http://127.0.0.1:8545';

    // Two services, both pre-j07 complete with no agent_id.
    const tmp = generateMnemonic();
    const a1 = deriveAgentSigner(tmp, 1);
    const a2 = deriveAgentSigner(tmp, 2);
    const { store, mnemonic } = await setupFleet(dir, [
      legacyCompleteService(1, a1.address),
      legacyCompleteService(2, a2.address),
    ]);
    const realA1 = deriveAgentSigner(mnemonic, 1);
    const realA2 = deriveAgentSigner(mnemonic, 2);
    await store.updateService(1, { agent_address: realA1.address });
    await store.updateService(2, { agent_address: realA2.address });

    // Service 1 fails the chain lookup; service 2 succeeds (recovered).
    const recoveredTx = '0x' + 'fe'.repeat(32);
    const publicClient: any = {
      getBlockNumber: async () => 100n,
      getLogs: async (args: any) => {
        const owner = (args.args?.owner ?? '').toLowerCase();
        if (owner === realA1.address.toLowerCase()) {
          throw new Error('forced RPC error for service 1');
        }
        if (owner === realA2.address.toLowerCase()) {
          return [makeRegisteredLog(101n, realA2.address, recoveredTx)];
        }
        return [];
      },
    };

    const result = await migrateAgentIds({
      stateStore: store,
      config,
      network: 'base',
      mnemonic,
      publicClient,
    });

    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].index).toBe(2);
    expect(result.migrated[0].agent_id).toBe('101');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service.index).toBe(1);
    expect(result.failed[0].error).toMatch(/forced RPC error/);
  });

  it('ignores services not in step=complete', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-migrate-'));
    dirs.push(dir);

    const config = getChainConfig('base');
    config.rpcUrl = 'http://127.0.0.1:8545';

    const tmp = generateMnemonic();
    const a1 = deriveAgentSigner(tmp, 1);
    const { store, mnemonic } = await setupFleet(dir, [
      // step=mech_deployed should be ignored — the normal bootstrap loop handles it
      { ...legacyCompleteService(1, a1.address), step: 'mech_deployed' },
    ]);

    const publicClient = makeFakePublicClient({});

    const result = await migrateAgentIds({
      stateStore: store,
      config,
      network: 'base',
      mnemonic,
      publicClient: publicClient as any,
    });

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ── findAgentIdForOwner unit ────────────────────────────────────────────────

describe('findAgentIdForOwner', () => {
  it('returns null when no Registered event exists for the owner', async () => {
    const publicClient = makeFakePublicClient({ blockNumber: 100n, logs: [] });
    const owner = '0x1111111111111111111111111111111111111111';
    const result = await findAgentIdForOwner(publicClient as any, REGISTRY as `0x${string}`, owner as `0x${string}`);
    expect(result).toBeNull();
  });

  it('returns the agentId from the first matching log', async () => {
    const owner = '0x2222222222222222222222222222222222222222';
    const log = makeRegisteredLog(99n, owner, '0x' + '11'.repeat(32));
    const publicClient = makeFakePublicClient({ blockNumber: 100n, logs: [log] });
    const result = await findAgentIdForOwner(publicClient as any, REGISTRY as `0x${string}`, owner as `0x${string}`);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('99');
    expect(result!.txHash).toBe('0x' + '11'.repeat(32));
  });

  it('chunks the scan by chunkSize', async () => {
    const owner = '0x3333333333333333333333333333333333333333';
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    const publicClient = {
      getBlockNumber: async () => 25n,
      getLogs: async (args: any) => {
        ranges.push({ from: args.fromBlock as bigint, to: args.toBlock as bigint });
        return [];
      },
    };
    const result = await findAgentIdForOwner(
      publicClient as any,
      REGISTRY as `0x${string}`,
      owner as `0x${string}`,
      { fromBlock: 0n, chunkSize: 9n },
    );
    expect(result).toBeNull();
    // 0..9, 10..19, 20..25 → 3 chunks
    expect(ranges).toEqual([
      { from: 0n, to: 9n },
      { from: 10n, to: 19n },
      { from: 20n, to: 25n },
    ]);
  });
});
