/**
 * Daemon-side bootstrap of the SolverNet subsystem.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` Task 11 (daemon
 * startup integration). Wires persistence and launch recovery so the daemon
 * can resume in-flight launches. Wave-4 D4 retired the ERC-8004 registry
 * client and the operator catalog refresher; owned launched records remain
 * the source for the SolverNet endpoints.
 *
 * Order of operations (mirrors the per-section ordering in
 * `launch-state-machine.ts`):
 *
 *   1. Resume any record stuck in `status: 'launching'` →
 *      `recoverInFlightLaunches`. Safe to call when no records are in flight.
 *   2. Load owned records → identify which ones have
 *      `status in {'launched','paused'} && generatorEnabled`; those carry the
 *      live record/config refs the SolverNet endpoints read and mutate.
 *
 * The lifecycle-transition resume scan retired with Wave-4 D3. The catalog
 * refresher retired with Wave-4 D4.
 *
 * Note: the launch state machine uses a noop subgraph client
 * internally for the mempool-drop recovery path. Until a real subgraph
 * extension lands, recovery falls back to re-broadcasting dropped
 * transactions, which is safe and idempotent.
 */

import {
  uploadToIpfs,
  fetchFromIpfs,
} from '../adapters/mech/ipfs.js';
import {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
} from '../erc8004/abis.js';
import type {
  IpfsClient,
  MetadataPublisher,
  SetMetadataPublishResult,
  SubgraphClient,
} from './launch-publisher.js';
import {
  recoverInFlightLaunches,
  type LaunchActionDeps,
  type ResolveSigner,
} from './launch-state-machine.js';
import type { LaunchedSolverNetRecord, SolverNetStore } from './store.js';

import { encodeFunctionData, type PublicClient, type WalletClient } from 'viem';
import {
  viemSendTransactionWithRetry,
  type TxRetryWalletClient,
} from '../tx-retry.js';

// Noop SubgraphClient used by the launch state-machine recovery path
// (mempool-drop detection) until a real subgraph extension is wired (Task 25).
const NOOP_SUBGRAPH_CLIENT: SubgraphClient = {
  async fetchSetMetadataEvents() { return []; },
  async fetchSetMetadataEventsForCid() { return []; },
};

// ── Public types ────────────────────────────────────────────────────────────

/**
 * One spawn-ready entry surfaced to `main.ts`. The SolverNet config API
 * endpoint mutates `configRef.current` so subsequent reads see the change
 * without a disk reload.
 */
export interface PendingGeneratorSpawn {
  /** Snapshot of the launched record at subsystem-init time. */
  record: LaunchedSolverNetRecord;
  /**
   * Live mirror of the launched record. The SolverNet generator-config
   * endpoint mutates `recordRef.current` immediately after persisting to
   * disk, so subsequent reads do not wait for a reload.
   */
  recordRef: { current: LaunchedSolverNetRecord };
  /**
   * Live mirror of the hot-applyable runtime generator config. The
   * subsystem seeds it with the record's last-saved config (or all-default
   * empty config when no per-record overrides are set yet).
   */
  configRef: { current: unknown };
}

/**
 * What `initSolverNetSubsystem` returns. `pendingGenerators` go to the
 * SolverNet endpoints (record/config refs). Wave-4 D4 dropped the catalog
 * cache and registry client.
 */
export interface SolverNetSubsystem {
  /** All launched records currently on disk (post-recovery). */
  records: LaunchedSolverNetRecord[];
  /**
   * Subset of `records` where `status` is `launched` or `paused` and
   * `generatorEnabled === true`, paired with the live refs the API
   * endpoints share.
   */
  pendingGenerators: PendingGeneratorSpawn[];
  /** Outcome of the launch recovery scan. Useful for test assertions and logging. */
  recovery: {
    inFlightLaunches: { resumed: number; failed: Array<{ solverNetId: string; error: Error }> };
  };
  /** Idempotent; catalog refresher is gone so this is a no-op. */
  stop(): void;
}

export interface InitSolverNetSubsystemDeps {
  store: SolverNetStore;
  ipfs: IpfsClient;
  publisher: MetadataPublisher;
  resolveSigner: ResolveSigner;
  /** Resolves a tx hash to a confirmed receipt. Same as the state machines. */
  awaitTxConfirmation: LaunchActionDeps['awaitTxConfirmation'];
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
  /** Override the wall clock for deterministic tests. */
  now?: () => Date;
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Initialise the SolverNet subsystem at daemon startup.
 *
 * Call after `FleetBootstrapper` resolves (so the master Safe + agent EOA
 * referenced by launched records are available). Errors during the recovery
 * scans are captured per-record into `recovery.inFlightLaunches.failed` so a
 * single broken record cannot block daemon startup.
 */
export async function initSolverNetSubsystem(
  deps: InitSolverNetSubsystemDeps,
): Promise<SolverNetSubsystem> {
  const logger = deps.logger ?? {
    warn: (msg: string) => console.warn(msg),
    info: (msg: string) => console.log(msg),
  };

  const inFlightLaunches = await recoverInFlightLaunches({
    store: deps.store,
    ipfs: deps.ipfs,
    publisher: deps.publisher,
    subgraph: NOOP_SUBGRAPH_CLIENT,
    awaitTxConfirmation: deps.awaitTxConfirmation,
    resolveSigner: deps.resolveSigner,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (inFlightLaunches.failed.length > 0) {
    logger.warn(
      `[solvernet] launch recovery: ${inFlightLaunches.resumed} resumed, ` +
        `${inFlightLaunches.failed.length} failed`,
    );
  } else if (inFlightLaunches.resumed > 0) {
    logger.info(`[solvernet] launch recovery: ${inFlightLaunches.resumed} resumed`);
  }

  const records = await deps.store.loadOwnedRecords();
  const pendingGenerators: PendingGeneratorSpawn[] = records
    .filter((r) => (r.status === 'launched' || r.status === 'paused') && r.generatorEnabled)
    .map((record) => ({
      record,
      recordRef: { current: record },
      configRef: {
        current: record.generatorConfig ?? {},
      },
    }));
  logger.info(
    `[solvernet] loaded ${records.length} owned record(s); ` +
      `${pendingGenerators.length} ready for generator spawn`,
  );

  return {
    records,
    pendingGenerators,
    recovery: {
      inFlightLaunches,
    },
    stop() {
      // Catalog refresher retired with Wave-4 D4.
    },
  };
}

// ── Adapter helpers ─────────────────────────────────────────────────────────

/**
 * Wrap the existing global `uploadToIpfs` / `fetchFromIpfs` helpers in the
 * `IpfsClient` interface used by the launch state machine.
 */
export function createIpfsClientAdapter(args: {
  registryUrl: string;
  gatewayUrl: string;
}): IpfsClient {
  return {
    upload: (data) => uploadToIpfs(args.registryUrl, data),
    fetch: (cid) => fetchFromIpfs(args.gatewayUrl, cid),
  };
}

/**
 * Adapter that turns a viem (walletClient, publicClient, identityRegistryAddress)
 * triple into a `MetadataPublisher` whose `value` is treated as raw bytes
 * (the JCS-encoded SolverNet lifecycle payload).
 */
export function createMetadataPublisherFromViem(args: {
  identityRegistryAddress: `0x${string}`;
  walletClient: WalletClient;
  publicClient: PublicClient;
}): MetadataPublisher {
  return {
    async setMetadata({ agentId, key, value }): Promise<SetMetadataPublishResult> {
      const account = args.walletClient.account;
      if (!account) {
        throw new Error('createMetadataPublisherFromViem: walletClient has no account configured');
      }
      const chain = args.walletClient.chain;
      if (!chain) {
        throw new Error('createMetadataPublisherFromViem: walletClient has no chain configured');
      }
      const data = encodeFunctionData({
        abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
        functionName: 'setMetadata',
        args: [BigInt(agentId), key, uint8ArrayToHex(value)],
      });
      const txHash = await viemSendTransactionWithRetry(
        args.walletClient as unknown as TxRetryWalletClient,
        args.publicClient,
        {
          account,
          to: args.identityRegistryAddress,
          data,
          value: 0n,
        },
        { logicalTx: 'solvernet.setMetadata' },
      );
      const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
      };
    },
  };
}

function uint8ArrayToHex(bytes: Uint8Array): `0x${string}` {
  let hex = '0x';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex as `0x${string}`;
}
