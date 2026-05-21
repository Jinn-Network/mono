import type { Address, PublicClient, WalletClient } from 'viem';
import type { JinnMviConfig } from '../earning/contracts.js';
import type { FleetStateStore } from '../earning/store.js';
import type { JinnOnchainNetwork } from '../earning/viem-clients.js';
import type { Store } from '../store/store.js';
import type {
  JinnClaimLoopConfig,
  JinnClaimSubmissionMode,
  JinnMessengerMode,
} from './jinn-claim-loop.js';

export interface JinnClaimL1ClientBundle {
  public: PublicClient;
  wallet: WalletClient;
}

export function shouldWireJinnClaimL1Signer(args: {
  enabled: boolean;
  intervalMs: number;
  submissionMode: JinnClaimSubmissionMode;
  distributorAddress?: string;
  ethereumRpcUrl?: string;
}): boolean {
  return (
    args.enabled &&
    args.intervalMs > 0 &&
    args.submissionMode === 'submit' &&
    !!args.distributorAddress &&
    !!args.ethereumRpcUrl
  );
}

export function buildJinnClaimLoopConfig(args: {
  enabled: boolean;
  intervalMs: number;
  submissionMode: JinnClaimSubmissionMode;
  messengerMode: JinnMessengerMode;
  mvi: Pick<JinnMviConfig, 'claimEmitter' | 'distributor' | 'messenger'>;
  l2Client: PublicClient;
  l2ProofClient?: PublicClient;
  l2Wallet: WalletClient;
  l1Clients?: JinnClaimL1ClientBundle;
  store: FleetStateStore;
  chain: JinnOnchainNetwork;
  optimismPortalAddress?: Address;
  disputeGameFactoryAddress?: Address;
  jinnStore?: Store;
}): JinnClaimLoopConfig | undefined {
  if (!args.enabled || args.intervalMs <= 0 || !args.mvi.claimEmitter) {
    return undefined;
  }

  const base = {
    intervalMs: args.intervalMs,
    submissionMode: args.submissionMode,
    l2Client: args.l2Client,
    l2ProofClient: args.l2ProofClient,
    l2Wallet: args.l2Wallet,
    store: args.store,
    chain: args.chain,
    claimEmitterAddress: args.mvi.claimEmitter as Address,
    messengerMode: args.messengerMode,
    optimismPortalAddress: args.optimismPortalAddress,
    disputeGameFactoryAddress: args.disputeGameFactoryAddress,
    jinnStore: args.jinnStore,
  } satisfies Omit<JinnClaimLoopConfig, 'l1Client' | 'l1Wallet'>;

  if (args.submissionMode === 'emit-only') {
    return base;
  }

  if (!args.l1Clients || !args.mvi.distributor || !args.mvi.messenger) {
    return undefined;
  }

  return {
    ...base,
    l1Client: args.l1Clients.public,
    l1Wallet: args.l1Clients.wallet,
    distributorAddress: args.mvi.distributor as Address,
    messengerAddress: args.mvi.messenger as Address,
  };
}
