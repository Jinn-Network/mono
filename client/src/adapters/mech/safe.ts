import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { TxSubmissionLedger } from '../../tx-retry.js';
import { buildFallbackTransport, parseRpcUrls } from '../../rpc/transport.js';

export function buildSafeSignature(signerAddress: string): Hex {
  const r = signerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
  const s = '0'.repeat(64);
  const v = '01';
  return `0x${r}${s}${v}` as Hex;
}

export interface SafeTransactionParams {
  safeAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

export interface SafeExecutionOptions {
  /**
   * Inert since the single-broadcaster cutover (venue-base owns the submission ledger; contract
   * 12, plan Task 7). Kept only so existing callers keep compiling; stage 5 deletes this field.
   */
  ledger?: TxSubmissionLedger;
  beforeBroadcast?: () => void | Promise<void>;
  onBroadcast?: (txHash: Hex) => void | Promise<void>;
}

export class SafeBroadcastFenceError extends Error {
  readonly name = 'SafeBroadcastFenceError';

  constructor(cause: unknown) {
    super('Safe transaction broadcast fence rejected the wallet write', { cause });
  }
}

export class SafePostBroadcastHookError extends Error {
  readonly name = 'SafePostBroadcastHookError';

  constructor(
    readonly txHash: Hex,
    cause: unknown,
  ) {
    super(`Safe transaction ${txHash} was broadcast but post-broadcast persistence failed`, {
      cause,
    });
  }
}

/**
 * The generic venue-base broadcast port (execution finding E5). The composition root installs
 * exactly one broadcaster per process, bound to one Safe at construction — `execute` takes only
 * `{to, value, data, logicalTx, operation?}`, not `safeAddress`, and `SafeBroadcastReceipt`
 * (venue-base) structurally satisfies the narrower return shape below (it carries `txHash` plus
 * block/log/`alreadySettled` fields this port does not need). Kept as a structural port —
 * client/src/adapters never imports venue-base directly; the composition root (Task 12) is the
 * only place that binds a real `BaseVenueSafeBroadcaster` to this interface.
 */
export interface VenueBroadcaster {
  /** The Safe this broadcaster is bound to — fixed at venue construction (finding E5). */
  readonly safeAddress: `0x${string}`;
  execute(request: {
    readonly to: `0x${string}`;
    readonly value: bigint;
    readonly data: `0x${string}`;
    readonly logicalTx: string;
    readonly operation?: 0 | 1;
  }): Promise<{ readonly txHash: `0x${string}` }>;
}

let venueBroadcaster: VenueBroadcaster | undefined;

/** Installed once by the composition root. From stage 1 this is the only tx path (contract 12). */
export function setVenueBroadcaster(broadcaster: VenueBroadcaster): void {
  venueBroadcaster = broadcaster;
}

export function clearVenueBroadcaster(): void {
  venueBroadcaster = undefined;
}

export function getVenueBroadcaster(): VenueBroadcaster | undefined {
  return venueBroadcaster;
}

/**
 * Derives a deterministic logical-operation identity for the venue broadcaster's reconcile path
 * (finding E5): `existing.logicalTx === request.logicalTx` is how the broadcaster's retry loop
 * adopts an already-pending tx instead of re-signing and double-broadcasting. Identical calldata
 * to the same target from the same Safe IS the same logical operation (a retry of the exact same
 * call), so it is correct for a retry to adopt the pending tx. Distinct operations differ in
 * `data` — the calldata encodes the function selector and its arguments (requestId, taskId,
 * digest, ...) — so they never collide here.
 */
function deriveLogicalTx(params: SafeTransactionParams): string {
  const encoded = encodePacked(
    ['address', 'address', 'uint256', 'bytes'],
    [params.safeAddress, params.to, params.value, params.data],
  );
  return `legacy:${keccak256(encoded)}`;
}

/**
 * Single-broadcaster rule (composition design §6.1, cutover stage 1). Every legacy transaction
 * leg still calls this function with its exact original signature; from stage 1 it does nothing
 * but derive the logical-operation identity and hand the Safe call to the one installed
 * venue-base broadcaster. Two independent nonce stacks against one Safe is the #525/#562/#897
 * failure class and is excluded here by construction — venue-base owns the nonce ledger and
 * retry loop now (contract 12); `_publicClient`/`_walletClient` are accepted only so call sites
 * do not need to change.
 */
export async function executeSafeTransaction(
  _publicClient: PublicClient,
  _walletClient: WalletClient,
  params: SafeTransactionParams,
  options: SafeExecutionOptions = {},
): Promise<Hex> {
  const broadcaster = venueBroadcaster;
  if (broadcaster === undefined) {
    throw new Error(
      'executeSafeTransaction: no venue broadcaster installed — the composition root must call setVenueBroadcaster before any loop starts',
    );
  }
  if (broadcaster.safeAddress.toLowerCase() !== params.safeAddress.toLowerCase()) {
    throw new Error(
      `executeSafeTransaction: params.safeAddress (${params.safeAddress}) does not match the ` +
        `installed venue broadcaster's Safe (${broadcaster.safeAddress}) — refusing to ` +
        'broadcast from the wrong Safe',
    );
  }

  try {
    await options.beforeBroadcast?.();
  } catch (fenceError) {
    throw new SafeBroadcastFenceError(fenceError);
  }

  const receipt = await broadcaster.execute({
    to: params.to,
    value: params.value,
    data: params.data,
    logicalTx: deriveLogicalTx(params),
  });
  const txHash = receipt.txHash as Hex;

  try {
    await options.onBroadcast?.(txHash);
  } catch (hookError) {
    throw new SafePostBroadcastHookError(txHash, hookError);
  }

  return txHash;
}

export function createClients(
  rpcUrl: string | readonly string[],
  privateKey: Hex,
  chain?: Chain,
): { publicClient: PublicClient; walletClient: WalletClient; account: ReturnType<typeof privateKeyToAccount> } {
  const account = privateKeyToAccount(privateKey);
  const selectedChain = chain ?? base;
  const transport = buildFallbackTransport(parseRpcUrls(rpcUrl));

  const publicClient = createPublicClient({
    chain: selectedChain,
    transport,
  });

  const walletClient = createWalletClient({
    account,
    chain: selectedChain,
    transport,
  });

  return { publicClient: publicClient as unknown as PublicClient, walletClient: walletClient as unknown as WalletClient, account };
}
