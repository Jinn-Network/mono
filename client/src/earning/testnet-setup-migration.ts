import {
  encodeFunctionData,
  getAddress,
  pad,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { STAKING_ABI, STOLAS_DISTRIBUTOR_ABI } from './contracts.js';
import type { FleetState, ServiceState, StakingMode } from './types.js';
import {
  type EarningMigrationArchiveEntry,
  type EarningMigrationRetireStatus,
  type FleetStateStore,
} from './store.js';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';

export const DEPRECATED_BASE_SEPOLIA_STAKING_PROXY =
  '0xf358b5c1ac4ddc4e807b5baf008826bf193eab3b';
export const DEPRECATED_BASE_SEPOLIA_STAKING_PROXIES = [
  DEPRECATED_BASE_SEPOLIA_STAKING_PROXY,
  '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
  '0x3A14c71e94F3d38A6BE4319808B259FbFb47B86f',
] as const;

const MIGRATION_KIND = 'base-sepolia-standard-setup' as const;

export interface TestnetSetupMigrationPlan {
  services: ServiceState[];
}

export interface TestnetSetupMigrationRetireFailedEnvelope {
  kind: 'retire_failed';
  retire_error: string | null;
  tx_hash: string | null;
  message: string;
}

export interface TestnetSetupMigrationResult {
  state: FleetState;
  migratedCount: number;
  archivePaths: string[];
  /**
   * Set when at least one service's retire failed and the wipe was suppressed.
   * The migration archived the failure but left local state intact.
   * Callers should surface this to the operator.
   */
  retireFailedEnvelope?: TestnetSetupMigrationRetireFailedEnvelope;
}

export interface TestnetSetupMigrationParams {
  stateStore: FleetStateStore;
  state: FleetState;
  chain: 'base' | 'base-sepolia';
  stakingMode: StakingMode;
  currentStakingContract: string;
  distributorAddress?: string;
  publicClient: PublicClient;
  masterWallet: WalletClient;
  sendTransaction?: typeof viemSendTransactionWithRetry;
  waitForReceipt?: typeof waitForTransactionReceiptWithRetry;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function isDeprecatedService(
  svc: ServiceState,
  currentStakingContract: string,
): boolean {
  return (
    svc.service_id !== null &&
    DEPRECATED_BASE_SEPOLIA_STAKING_PROXIES.some(proxy =>
      sameAddress(svc.staking_address, proxy) &&
      !sameAddress(currentStakingContract, proxy),
    )
  );
}

export function detectDeprecatedTestnetSetup(params: {
  state: FleetState;
  chain: 'base' | 'base-sepolia';
  stakingMode: StakingMode;
  currentStakingContract: string;
}): TestnetSetupMigrationPlan {
  // Closed-loop / release runners may pin gold operators that still sit on a
  // deprecated staking proxy but already have a live Safe+mech. Migrating them
  // mid-gate archives the complete fleet and fails agent_already_bound.
  if (process.env['JINN_SKIP_TESTNET_SETUP_MIGRATION'] === '1') {
    return { services: [] };
  }
  if (params.chain !== 'base-sepolia' || params.stakingMode !== 'standard') {
    return { services: [] };
  }
  return {
    services: params.state.services.filter(svc =>
      isDeprecatedService(svc, params.currentStakingContract),
    ),
  };
}

function migrationId(svc: ServiceState): string {
  const serviceId = svc.service_id ?? 'none';
  const staking = svc.staking_address
    ? getAddress(svc.staking_address).toLowerCase()
    : 'none';
  return `${MIGRATION_KIND}:${svc.index}:${serviceId}:${staking}`;
}

function archiveEntryForService(params: {
  svc: ServiceState;
  currentStakingContract: string;
  backupStatePath: string;
  existing?: EarningMigrationArchiveEntry;
}): Omit<EarningMigrationArchiveEntry, 'created_at' | 'updated_at'> {
  return {
    migration_id: migrationId(params.svc),
    kind: MIGRATION_KIND,
    chain: 'base-sepolia',
    service_index: params.svc.index,
    backup_state_path: params.existing?.backup_state_path || params.backupStatePath,
    from: {
      service_id: params.svc.service_id,
      safe_address: params.svc.safe_address,
      mech_address: params.svc.mech_address,
      staking_address: params.svc.staking_address,
      step: params.svc.step,
      agent_id: params.svc.agent_id ?? null,
    },
    to: {
      staking_address: getAddress(params.currentStakingContract),
    },
    retire_status: params.existing?.retire_status ?? 'pending',
    retire_tx_hash: params.existing?.retire_tx_hash ?? null,
    retire_error: params.existing?.retire_error ?? null,
    state_reset_at: params.existing?.state_reset_at ?? null,
  };
}

function isTerminalRetireStatus(status: EarningMigrationRetireStatus): boolean {
  return status === 'retired' || status === 'already_inactive';
}

async function readOldSetupState(
  publicClient: PublicClient,
  stakingProxy: string,
  serviceId: number,
): Promise<number | null> {
  try {
    return Number(
      await publicClient.readContract({
        address: getAddress(stakingProxy) as Address,
        abi: STAKING_ABI,
        functionName: 'getStakingState',
        args: [BigInt(serviceId)],
      }),
    );
  } catch {
    return null;
  }
}

async function retireOldSetup(
  params: {
    svc: ServiceState;
    distributorAddress?: string;
    publicClient: PublicClient;
    masterWallet: WalletClient;
    sendTransaction: typeof viemSendTransactionWithRetry;
    waitForReceipt: typeof waitForTransactionReceiptWithRetry;
  },
): Promise<{
  retire_status: EarningMigrationRetireStatus;
  retire_tx_hash?: string | null;
  retire_error?: string | null;
}> {
  if (params.svc.service_id === null || !params.svc.staking_address) {
    return {
      retire_status: 'already_inactive',
      retire_tx_hash: null,
      retire_error: null,
    };
  }

  const oldState = await readOldSetupState(
    params.publicClient,
    params.svc.staking_address,
    params.svc.service_id,
  );
  if (oldState === 0) {
    return {
      retire_status: 'already_inactive',
      retire_tx_hash: null,
      retire_error: null,
    };
  }

  if (!params.distributorAddress) {
    return {
      retire_status: 'failed',
      retire_tx_hash: null,
      retire_error: 'No distributor configured for automatic setup retirement.',
    };
  }

  let txHash: Hex | null = null;
  try {
    const stakingProxy = getAddress(params.svc.staking_address);
    const operation = pad(stakingProxy as Hex, { size: 32 });
    const data = encodeFunctionData({
      abi: STOLAS_DISTRIBUTOR_ABI,
      functionName: 'unstakeAndWithdraw',
      args: [stakingProxy as Address, BigInt(params.svc.service_id), operation],
    }) as Hex;

    txHash = await params.sendTransaction(
      params.masterWallet,
      params.publicClient,
      {
        account: params.masterWallet.account!,
        to: getAddress(params.distributorAddress) as Address,
        data,
        gas: 2_500_000n,
      },
    );
    const receipt = await params.waitForReceipt(params.publicClient, txHash);
    if (receipt.status !== 'success') {
      return {
        retire_status: 'failed',
        retire_tx_hash: txHash,
        retire_error: `Previous setup retirement transaction failed (${txHash}).`,
      };
    }
    return {
      retire_status: 'retired',
      retire_tx_hash: txHash,
      retire_error: null,
    };
  } catch (error) {
    return {
      retire_status: 'failed',
      retire_tx_hash: txHash,
      retire_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function migrateDeprecatedTestnetSetup(
  params: TestnetSetupMigrationParams,
): Promise<TestnetSetupMigrationResult> {
  const plan = detectDeprecatedTestnetSetup({
    state: params.state,
    chain: params.chain,
    stakingMode: params.stakingMode,
    currentStakingContract: params.currentStakingContract,
  });
  if (plan.services.length === 0) {
    return { state: params.state, migratedCount: 0, archivePaths: [] };
  }

  console.error('Upgrading your Jinn earning setup...');

  const sendTransaction = params.sendTransaction ?? viemSendTransactionWithRetry;
  const waitForReceipt = params.waitForReceipt ?? waitForTransactionReceiptWithRetry;
  let archive = await params.stateStore.loadMigrationArchive();
  let backupPathForNewEntries: string | null = null;
  let nextState = params.state;
  const archivePaths = new Set<string>();
  let migratedCount = 0;
  let retireFailedEnvelope: TestnetSetupMigrationRetireFailedEnvelope | undefined;

  for (const svc of plan.services) {
    const id = migrationId(svc);
    const existing = archive.entries.find(e => e.migration_id === id);
    let backupStatePath = existing?.backup_state_path;
    if (!backupStatePath) {
      backupPathForNewEntries ??= await params.stateStore.backupStateFile('testnet-setup-migration');
      backupStatePath = backupPathForNewEntries ?? '';
    }

    let entry = await params.stateStore.upsertMigrationArchiveEntry(
      archiveEntryForService({
        svc,
        currentStakingContract: params.currentStakingContract,
        backupStatePath,
        existing,
      }),
    );
    if (entry.backup_state_path) {
      archivePaths.add(entry.backup_state_path);
    }

    if (!isTerminalRetireStatus(entry.retire_status)) {
      const retire = await retireOldSetup({
        svc,
        distributorAddress: params.distributorAddress,
        publicClient: params.publicClient,
        masterWallet: params.masterWallet,
        sendTransaction,
        waitForReceipt,
      });
      entry = await params.stateStore.upsertMigrationArchiveEntry({
        ...entry,
        ...retire,
      });
      if (retire.retire_status === 'failed') {
        // Retire failed — do NOT wipe local state. The operator's service is
        // still running on-chain against the old setup. Preserve all fields so
        // they can continue operating. Surface the error via the envelope so
        // callers (bootstrap, /v1/bootstrap) can show an actionable message.
        //
        // Also mark wipe_suppressed=true on the archive entry. Pre-PR archive
        // entries with retire_status='failed' but no wipe_suppressed flag had
        // their state wiped anyway; consumers (bootstrap-endpoint) filter on
        // wipe_suppressed === true to avoid surfacing a spurious retire_failed
        // envelope for those legacy entries.
        entry = await params.stateStore.upsertMigrationArchiveEntry({
          ...entry,
          wipe_suppressed: true,
        });
        console.error(
          'Previous Jinn setup could not be fully retired automatically; it was archived for recovery. Local state is preserved — resolve the retire failure before upgrading.',
        );
        retireFailedEnvelope = {
          kind: 'retire_failed',
          retire_error: retire.retire_error ?? null,
          tx_hash: retire.retire_tx_hash ?? null,
          message: 'We could not retire your previous setup. Your service state is preserved; resolve the retire failure before upgrading.',
        };
        // Count as a migration attempt even though state was not wiped, so
        // callers know we ran the migration path.
        migratedCount += 1;
        continue;
      }
    }

    nextState = await params.stateStore.updateService(svc.index, {
      service_id: null,
      safe_address: null,
      mech_address: null,
      staking_address: null,
      step: 'awaiting_stake',
      error: null,
      safe_bound_to_agent: false,
    });
    await params.stateStore.upsertMigrationArchiveEntry({
      ...entry,
      state_reset_at: new Date().toISOString(),
    });
    archive = await params.stateStore.loadMigrationArchive();
    migratedCount += 1;
  }

  if (archivePaths.size > 0) {
    console.error(`Previous setup archived for recovery at: ${[...archivePaths].join(', ')}`);
  }
  console.error('Jinn earning setup upgraded.');

  return {
    state: nextState,
    migratedCount,
    archivePaths: [...archivePaths],
    ...(retireFailedEnvelope ? { retireFailedEnvelope } : {}),
  };
}
