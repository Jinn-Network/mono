/**
 * Legacy backfill: ERC-8004 IdentityRegistry mint for `complete` services
 * that pre-date jinn-mono-j07.
 *
 * j07 added an `agent_registered` step to the bootstrap state machine,
 * slotted between `mech_deployed` and `complete`. Operators that completed
 * bootstrap BEFORE j07 landed have `state == 'complete' && agent_id == null`
 * and are stuck — they cannot publish per-execution metadata via
 * `setMetadata` (jinn-mono-3zk wires that, but it is gated on a non-null
 * `agent_id`).
 *
 * This module detects such services and runs the agent-registration mint
 * idempotently for each. It is safe to re-run: services that already have
 * an `agent_id` are skipped, and a chain-side lookup recovers the existing
 * agentId for any operator whose state file was lost but whose Safe still
 * owns the NFT (per the entity-model decision record §4.1, the operator
 * agent NFT is stable across executions / re-stakes — we MUST never
 * mint a duplicate).
 *
 * Wired in two places:
 *   - daemon startup (`main.ts` after `bootstrap`), gated by
 *     `runLegacyMigrations` config flag (default true)
 *   - explicit CLI subcommand `jinn migrate-agent-id`
 *
 * Tracked as jinn-mono-jgp.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import {
  EVENT_TOPICS,
  IDENTITY_REGISTRY_ABI,
  IDENTITY_REGISTRY_ADDRESSES,
  getChainConfig,
  type ChainConfig,
} from './contracts.js';
import { FleetStateStore } from './store.js';
import {
  createJinnPublicClient,
  createJinnWalletClient,
  type JinnOnchainNetwork,
} from './viem-clients.js';
import {
  decryptMnemonic,
  deriveAgentSigner,
} from './wallet.js';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import type { ServiceState } from './types.js';
import type { Account } from 'viem/accounts';

export interface MigrateAgentIdsDeps {
  /** Persistence layer for fleet state. */
  stateStore: FleetStateStore;
  /** Resolved chain config (identity registry, RPC URL, chain ID). */
  config: ChainConfig;
  /** Network the chain config is for. */
  network: JinnOnchainNetwork;
  /** Decrypted HD mnemonic for the master wallet (used to derive agent signers). */
  mnemonic: string;
  /**
   * Optional override for the public client (tests). Defaults to a fresh
   * client built from `config.rpcUrl` + `network`.
   */
  publicClient?: PublicClient;
  /**
   * Optional factory for wallet clients (tests). Defaults to the production
   * `createJinnWalletClient`. Receives the agent EOA private-key account.
   */
  walletClientFactory?: (account: ReturnType<typeof deriveAgentSigner>) => WalletClient;
  /**
   * Lower bound for the `Registered` event scan. Mainnet/testnet defaults are
   * adequate; tests override to keep mocks compact. The scan walks forward
   * from this block to `latest` in chunks.
   */
  scanFromBlock?: bigint;
  /**
   * Block-range chunk size for the `getLogs` scan. Defaults to 9_999n
   * (under typical RPC limits like Alchemy's 10k cap).
   */
  scanChunkSize?: bigint;
}

export interface MigrateAgentIdsFailure {
  service: ServiceState;
  error: string;
}

export interface MigrateAgentIdsResult {
  /** Services that were successfully migrated this run (state file updated). */
  migrated: ServiceState[];
  /** Services with `state == 'complete'` and `agent_id` already populated. */
  skipped: ServiceState[];
  /** Services that failed migration; the rest of the run continues. */
  failed: MigrateAgentIdsFailure[];
}

const REGISTERED_TOPIC = EVENT_TOPICS.Registered;

/**
 * Typed `Registered` event item for `publicClient.getLogs({ event, args })`.
 * The runtime topic hash is identical to `EVENT_TOPICS.Registered` (both are
 * `keccak256(stringToBytes('Registered(uint256,string,address)'))`).
 */
const REGISTERED_EVENT = parseAbiItem(
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
);

/**
 * Scan past `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
 * events on the IdentityRegistry, filtered by indexed `owner`, and return
 * the most recent agentId minted for that owner (or null if none).
 *
 * This is the duplicate-mint guard: per DR §4.1, the operator agent NFT
 * is stable across executions and survives Safe rotation. If an
 * operator's state file lost the `agent_id` (e.g. corrupted backup),
 * we MUST recover the existing token rather than minting a new one.
 *
 * The scan uses the indexed `owner` topic so the RPC can return only
 * matching logs cheaply. We chunk by `scanChunkSize` to stay under
 * provider log-limit caps. The mint is one-shot per owner in our flow,
 * so we expect 0 or 1 hits.
 */
export async function findAgentIdForOwner(
  publicClient: PublicClient,
  identityRegistry: Address,
  owner: Address,
  options: { fromBlock?: bigint; chunkSize?: bigint } = {},
): Promise<{ agentId: string; agentURI: string; txHash: string } | null> {
  const fromBlock = options.fromBlock ?? 0n;
  const chunkSize = options.chunkSize ?? 9_999n;
  const latest = await publicClient.getBlockNumber();

  for (let start = fromBlock; start <= latest; start += chunkSize + 1n) {
    const end = start + chunkSize > latest ? latest : start + chunkSize;
    const logs = await publicClient.getLogs({
      address: identityRegistry,
      event: REGISTERED_EVENT,
      args: { owner },
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const args = log.args as { agentId?: bigint; agentURI?: string; owner?: string };
      if (args.agentId === undefined) continue;
      return {
        agentId: args.agentId.toString(),
        agentURI: args.agentURI ?? '',
        txHash: log.transactionHash ?? '',
      };
    }
  }

  return null;
}

/**
 * Parse `agentId` from a fresh `IdentityRegistry.register()` receipt.
 * Mirrors `FleetBootstrapper.parseAgentIdFromReceipt` (private) so we
 * don't have to re-export the bootstrap class for tests.
 */
function parseAgentIdFromReceipt(
  receipt: TransactionReceipt,
  identityRegistry: string,
): { agentId: string; agentURI: string } | null {
  const target = identityRegistry.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target) continue;
    if (log.topics[0] !== REGISTERED_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_REGISTRY_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });
      if (decoded.eventName !== 'Registered') continue;
      if (!('agentId' in decoded.args)) continue;
      return {
        agentId: (decoded.args.agentId as bigint).toString(),
        agentURI: 'agentURI' in decoded.args ? String(decoded.args.agentURI ?? '') : '',
      };
    } catch {
      // Not a matching event
    }
  }
  return null;
}

/**
 * Mint a fresh ERC-8004 agent NFT for the agent EOA derived at the
 * given fleet service index. Used only when the chain-side lookup
 * confirms no existing token. Returns the parsed agentId + tx hash.
 *
 * Mirrors `FleetBootstrapper.stepRegisterAgent` (private), but does
 * NOT mutate the persisted `step` — the migration writes only to the
 * agent_id / agent_uri / identity_registry_address / agent_registered_tx
 * fields and leaves `step` at `complete` so the daemon picks up
 * normally.
 */
async function mintAgentNftForOwner(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: ReturnType<typeof deriveAgentSigner>,
  identityRegistry: Address,
): Promise<{ agentId: string; agentURI: string; txHash: string }> {
  const agentURI = '';
  const data = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [agentURI],
  }) as Hex;

  const txHash = await viemSendTransactionWithRetry(walletClient, publicClient, {
    account: account as Account,
    to: identityRegistry,
    data,
  });

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash);
  if (receipt.status !== 'success') {
    throw new Error(`IdentityRegistry.register() tx reverted (tx: ${txHash})`);
  }

  const parsed = parseAgentIdFromReceipt(receipt, identityRegistry);
  if (parsed === null) {
    throw new Error(
      `IdentityRegistry.register() succeeded but Registered event was not found (tx: ${txHash})`,
    );
  }
  return { agentId: parsed.agentId, agentURI: parsed.agentURI, txHash };
}

/**
 * Backfill `agent_id` on every service whose state is `complete` but
 * which has no persisted agentId.
 *
 * Behaviour:
 *   - `state == 'complete' && agent_id == null` → migrated (recover existing
 *     NFT from chain if the agent EOA already owns one, else mint a new one).
 *   - `state == 'complete' && agent_id != null` → skipped.
 *   - any other step → ignored (the normal `stepRegisterAgent` path handles
 *     them when bootstrap resumes).
 *
 * Failures are isolated per service; one mint reverting does not abort
 * the rest of the migration.
 */
export async function migrateAgentIds(
  deps: MigrateAgentIdsDeps,
): Promise<MigrateAgentIdsResult> {
  const { stateStore, config, network, mnemonic } = deps;

  const identityRegistry =
    config.identityRegistry
      ?? IDENTITY_REGISTRY_ADDRESSES[config.chainId];
  if (!identityRegistry) {
    throw new Error(
      `IdentityRegistry address not configured for chainId=${config.chainId}; ` +
      `update IDENTITY_REGISTRY_ADDRESSES in earning/contracts.ts.`,
    );
  }
  const registryAddr = getAddress(identityRegistry) as Address;

  const publicClient =
    deps.publicClient ?? createJinnPublicClient(config.rpcUrl, network);

  const state = await stateStore.load(network);

  const migrated: ServiceState[] = [];
  const skipped: ServiceState[] = [];
  const failed: MigrateAgentIdsFailure[] = [];

  for (const svc of state.services) {
    if (svc.step !== 'complete') continue;

    if (svc.agent_id) {
      skipped.push(svc);
      continue;
    }

    try {
      const agentSigner = deriveAgentSigner(mnemonic, svc.index);
      const agentEoa = getAddress(agentSigner.address) as Address;

      // 1. Duplicate-mint guard: scan chain for an existing Registered
      //    event whose `owner` is this agent EOA. If found, recover
      //    instead of minting (DR §4.1).
      const existing = await findAgentIdForOwner(publicClient, registryAddr, agentEoa, {
        fromBlock: deps.scanFromBlock,
        chunkSize: deps.scanChunkSize,
      });

      let agentId: string;
      let agentURI: string;
      let txHash: string;

      if (existing) {
        console.error(
          `[migrate-agent-id] Service ${svc.index}: recovered existing agentId=${existing.agentId} ` +
          `for agent EOA ${agentEoa} (tx=${existing.txHash || 'unknown'}); no mint needed.`,
        );
        agentId = existing.agentId;
        agentURI = existing.agentURI;
        txHash = existing.txHash;
      } else {
        console.error(
          `[migrate-agent-id] Service ${svc.index}: minting ERC-8004 agent NFT ` +
          `(IdentityRegistry=${registryAddr}, agentEOA=${agentEoa})`,
        );
        const walletClient =
          deps.walletClientFactory?.(agentSigner)
          ?? createJinnWalletClient(config.rpcUrl, network, agentSigner);
        const minted = await mintAgentNftForOwner(
          publicClient,
          walletClient,
          agentSigner,
          registryAddr,
        );
        agentId = minted.agentId;
        agentURI = minted.agentURI;
        txHash = minted.txHash;
        console.error(
          `[migrate-agent-id] Service ${svc.index}: minted agentId=${agentId} (tx=${txHash})`,
        );
      }

      // Persist immediately. We deliberately leave `step: 'complete'` —
      // the migration's job is purely to backfill the agent fields, not
      // to rewind the state machine. The daemon (main.ts) reads agent_id
      // from the loaded state and wires the IdentityPublisher accordingly.
      await stateStore.updateService(svc.index, {
        agent_id: agentId,
        agent_uri: agentURI,
        identity_registry_address: registryAddr,
        agent_registered_tx: txHash || null,
        // Keep safe_bound_to_agent at its persisted value (default false);
        // setAgentWallet is tracked by jinn-mono-aev.
      });

      const refreshed = (await stateStore.load(network)).services.find(s => s.index === svc.index);
      if (refreshed) {
        migrated.push(refreshed);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[migrate-agent-id] Service ${svc.index}: migration failed — ${message}`,
      );
      failed.push({ service: svc, error: message });
    }
  }

  return { migrated, skipped, failed };
}

/**
 * Convenience wrapper: build deps from a config-shaped object + password
 * and run the migration. Used by main.ts (daemon startup) and the CLI
 * subcommand. Tests call `migrateAgentIds` directly with mocked deps.
 */
export interface RunLegacyAgentIdMigrationOptions {
  earningDir: string;
  network: JinnOnchainNetwork;
  rpcUrl: string;
  password: string;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  testnetStolasDeploymentPath?: string;
}

export async function runLegacyAgentIdMigration(
  options: RunLegacyAgentIdMigrationOptions,
): Promise<MigrateAgentIdsResult> {
  const stateStore = new FleetStateStore(options.earningDir);
  const config = getChainConfig(options.network, {
    testnetL2DeploymentPath: options.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: options.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: options.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: options.testnetStolasDeploymentPath,
  });
  config.rpcUrl = options.rpcUrl;
  const mnemonic = await decryptMnemonic(
    await stateStore.loadMnemonicKeystore(),
    options.password,
  );
  return migrateAgentIds({
    stateStore,
    config,
    network: options.network,
    mnemonic,
  });
}
