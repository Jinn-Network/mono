import { getAddress, type Address, type TransactionReceipt } from 'viem';
import type { ChainConfig } from '../contracts.js';
import type { FleetStateStore } from '../store.js';
import type { FleetState, ServiceState, StakingMode } from '../types.js';
import type { createJinnPublicClient, JinnOnchainNetwork } from '../viem-clients.js';
import type { bindAgentWalletToSafe } from '../agent-wallet-binding.js';

/**
 * Read-only dependency bag handed to every extracted bootstrap step.
 *
 * Built fresh per step invocation by `FleetBootstrapper.stepContext()`. The
 * spied helper closures (getStakingState, getBondTokenBalance,
 * parseAgentIdFromReceipt, stolasPreflightCheck, sweepAbandonedSafeForService)
 * dispatch back through the live instance at call time, so a `vi.spyOn`
 * installed after construction is honoured. See the plan's "Binding rule".
 */
export interface StepContext {
  readonly store: FleetStateStore;
  readonly config: ChainConfig;
  readonly publicClient: ReturnType<typeof createJinnPublicClient>;
  readonly chain: JinnOnchainNetwork;
  readonly stakingMode: StakingMode;
  readonly targetServices: number;
  readonly debug: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly safeBindingMaxAttempts: number;
  readonly safeBindingRetryDelayMs: number;

  // Non-spied helper closures (route through the instance for live config).
  readonly bindAgentWalletWithRetry: (
    args: Parameters<typeof bindAgentWalletToSafe>[0],
    label: string,
  ) => Promise<Awaited<ReturnType<typeof bindAgentWalletToSafe>>>;
  readonly getServiceState: (serviceId: number) => Promise<number>;
  readonly waitForSuccessfulTx: (txHash: string, label: string) => Promise<void>;
  readonly firstServiceUpdate: (
    index: number,
    patch: Partial<ServiceState>,
  ) => Promise<ServiceState>;
  readonly stakingAddressForService: (svc: ServiceState) => Address;
  readonly shouldPreserveExistingSetup: (svc: ServiceState) => boolean;
  readonly parseServiceIdFromReceipt: (
    receipt: TransactionReceipt,
  ) => Promise<number | null>;
  readonly parseMultisigFromReceipt: (receipt: TransactionReceipt) => string | null;

  // Spied helper closures — bound off the live instance (see Binding rule).
  readonly getStakingState: (
    serviceId: number,
    stakingAddress?: string | null,
  ) => Promise<number>;
  readonly getBondTokenBalance: (address: string) => Promise<bigint>;
  readonly parseAgentIdFromReceipt: (
    receipt: TransactionReceipt,
    identityRegistry: string,
  ) => string | null;
  readonly stolasPreflightCheck: () => Promise<void>;
  readonly sweepAbandonedSafeForService: (
    state: FleetState,
    mnemonic: string,
    serviceIndex: number,
    abandonedSafeAddress: string,
  ) => Promise<void>;
}

/** Checksum-address helper shared by step modules (mirrors bootstrap.ts). */
export const addr = (value: string): Address => getAddress(value) as Address;
