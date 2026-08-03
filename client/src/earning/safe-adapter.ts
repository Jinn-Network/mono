/**
 * Thin wrapper around @safe-global/protocol-kit isolating import/init quirks.
 *
 * NodeNext treats protocol-kit's .d.ts as CJS (the package lacks "type":"module"),
 * so `import Safe from '...'` resolves to the module namespace rather than the class.
 * This adapter defines a minimal SafeInstance interface for what we actually use,
 * decoupling the earning bootstrap from SDK type-level instability.
 */

import type { MetaTransactionData, TransactionResult } from '@safe-global/types-kit';
import {
  bytesToHex,
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  hexToBytes,
  http,
  toHex,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SAFE_ABI } from '../contracts/abis.js';
import {
  isNonceTooLowError,
  removeConflictingLegacyGasPrice,
  type TxSubmissionLedger,
  withNonceLedger,
  withRecoverableRetry,
} from '../tx-retry.js';

export type { MetaTransactionData, TransactionResult };

/**
 * Lower bound used only when on-chain `eth_estimateGas` itself fails (RPC error,
 * contract reverts during simulation, etc.). Real bootstrap operations call
 * `estimateGas` first and apply a 30 % buffer; this fallback exists so a
 * temporarily flaky RPC does not block a tx that would otherwise succeed.
 *
 * Set high enough to cover the most gas-heavy Safe wrapper we know about
 * (mech deploy on Base Sepolia: ~2.23M as of 2026-05-04). 5M leaves headroom
 * for small drifts without tripping a sane RPC's per-tx upper bound.
 */
const SAFE_EXECUTION_FALLBACK_GAS_LIMIT = 5_000_000;

/** Buffer applied to `estimateGas` results to absorb minor variance between
 *  estimation and actual execution gas (storage refunds, warm/cold slot
 *  differences, etc.). 30 % matches viem's `multiplier` default ballpark and
 *  keeps us well clear of the cap on the heaviest call we measure. */
const SAFE_EXECUTION_GAS_ESTIMATE_BUFFER_NUMERATOR = 130n;
const SAFE_EXECUTION_GAS_ESTIMATE_BUFFER_DENOMINATOR = 100n;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SafeInitFn = (config: any) => Promise<SafeInstance>;

/** Minimal interface covering the Safe SDK methods we actually call. */
export interface SafeInstance {
  getAddress(): Promise<string>;
  isSafeDeployed(): Promise<boolean>;
  createSafeDeploymentTransaction(): Promise<{ to: string; value: string; data: string }>;
  createTransaction(props: {
    transactions: MetaTransactionData[];
  }): Promise<SafeTransaction>;
  signTransaction(tx: SafeTransaction): Promise<SafeTransaction>;
  executeTransaction(
    tx: SafeTransaction,
    options?: Record<string, unknown>,
  ): Promise<TransactionResult>;
}

/** Opaque handle -- we never inspect SafeTransaction internals. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface SafeTransaction {}

/**
 * Resolve the `Safe.init` function regardless of CJS/ESM interop shape.
 */
async function resolveSafeInit(): Promise<SafeInitFn> {
  // Dynamic import avoids NodeNext static-analysis issues.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@safe-global/protocol-kit');
  const SafeClass = mod.default?.default ?? mod.default ?? mod;

  if (typeof SafeClass?.init !== 'function') {
    throw new Error(
      'Failed to resolve Safe.init from @safe-global/protocol-kit. ' +
        `Got: ${typeof SafeClass} (keys: ${Object.keys(SafeClass ?? {}).join(', ')})`,
    );
  }

  return SafeClass.init.bind(SafeClass) as SafeInitFn;
}

async function resolveExecutionRpcUrl(rpcUrl: string): Promise<string> {
  if (!rpcUrl.includes('tenderly.co')) {
    return rpcUrl;
  }
  try {
    const id = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
    if (id === 8453) return 'https://base.publicnode.com';
    if (id === 84532) return 'https://sepolia.base.org';
  } catch {
    /* fall through */
  }
  return rpcUrl;
}

function chainForId(chainId: number, rpcUrl: string): Chain {
  if (chainId === 8453) return base;
  if (chainId === 84532) return baseSepolia;
  return {
    id: chainId,
    name: 'Custom',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export interface PredictedSafeResult {
  safe: SafeInstance;
  address: string;
}

/**
 * Initialise a Safe SDK instance for a not-yet-deployed Safe (CREATE2 prediction).
 */
export async function initPredictedSafe(opts: {
  rpcUrl: string;
  signerKey: string;
  owners: string[];
  threshold: number;
}): Promise<PredictedSafeResult> {
  const init = await resolveSafeInit();
  const safe = await init({
    provider: opts.rpcUrl,
    signer: opts.signerKey,
    predictedSafe: {
      safeAccountConfig: {
        owners: opts.owners,
        threshold: opts.threshold,
      },
      // Pin Safe 1.3.0 explicitly. protocol-kit v7 changed the DEFAULT Safe
      // contract version 1.3.0 -> 1.4.1; the operator Safe is registered as the
      // OLAS service multisig, and OLAS GnosisSafeSameAddressMultisig enforces
      // keccak256(proxy.code) == an immutable proxyHash set for the 1.3.0
      // GnosisSafeProxy. A 1.4.1 SafeProxy has different runtime bytecode, so an
      // unpinned v7 default would deploy 1.4.1 and revert `service_deployed`
      // with UnauthorizedMultisig. Pinning preserves the proven Phase-0/1a path.
      // (jinn-mono#963; tx-retry.ts also assumes 1.3.0 GS013 revert wrapping.)
      safeDeploymentConfig: {
        safeVersion: '1.3.0',
      },
    },
  });

  const address = await safe.getAddress();
  return { safe, address };
}

/**
 * Initialise a Safe SDK instance for an already-deployed Safe.
 */
export async function initDeployedSafe(opts: {
  rpcUrl: string;
  signerKey: string;
  safeAddress: string;
}): Promise<SafeInstance> {
  const init = await resolveSafeInit();
  return init({
    provider: opts.rpcUrl,
    signer: opts.signerKey,
    safeAddress: opts.safeAddress,
  });
}

export interface ExecuteSafeTxBatchOptions {
  /** Public client used to resolve chain id / pending nonce / gas fees. */
  publicClient: PublicClient;
  /** Agent EOA that signs and broadcasts the Safe's `execTransaction` wrapper. */
  from: Address;
  /** Defaults to the module-wide default ledger (see `tx-retry.ts`) when omitted. */
  ledger?: TxSubmissionLedger;
  chainId?: number;
}

/**
 * Build + sign + execute a batch of calls through a deployed Safe.
 * For 1-of-1 Safes the signer is the sole owner, so sign + execute in one shot.
 *
 * Issue #525/#562/#897: this used to hand off to the Safe SDK's own
 * `executeTransaction` with no pinned nonce, letting the SDK's internal viem
 * client auto-fill the nonce from the `pending` transaction count. Two
 * concurrent batches from the same agent EOA (e.g. two bootstrap steps racing
 * under the shared master signer) would both read the same pending nonce and
 * collide. Routes through the same `withNonceLedger` + shared per-EOA
 * `withEoaBroadcastLock` critical section as `executeSafeTxDirect`, so both
 * paths -- and venue-base's own broadcaster, once `setDefaultEoaBroadcastLock`
 * is installed -- serialize against each other.
 */
export async function executeSafeTxBatch(
  safe: SafeInstance,
  transactions: MetaTransactionData[],
  options: ExecuteSafeTxBatchOptions,
): Promise<TransactionResult> {
  return withNonceLedger(
    {
      publicClient: options.publicClient,
      ledger: options.ledger,
      from: options.from,
      chainId: options.chainId,
    },
    (nonceLedger) => withRecoverableRetry(
      async (attemptIndex) => {
        const safeTx = await safe.createTransaction({ transactions });
        const signedTx = await safe.signTransaction(safeTx);
        const feeResult = await nonceLedger.feeResultForAttempt(attemptIndex, {
          forceEstimate: true,
        });
        const txOptions: Record<string, unknown> = {
          nonce: nonceLedger.nonce,
          ...feeResult.overrides,
        };

        const execute = async (execOptions: Record<string, unknown>) => {
          const result = await safe.executeTransaction(signedTx, execOptions);
          await nonceLedger.recordSubmitted({
            hash: result.hash as Hex,
            logicalTx: 'safe.executeTransaction.batch',
            fees: feeResult.snapshot,
          });
          return result;
        };

        try {
          return await execute(txOptions);
        } catch (err) {
          // Issue #562: a daemon respawn (or, now that the nonce is pinned, a
          // genuine race that the shared lock did not fully absorb) can leave
          // the pinned value behind the RPC's pending nonce -- refresh so the
          // next retry attempt submits with the fresh value.
          if (isNonceTooLowError(err)) {
            const refreshed = await nonceLedger.refreshNonce();
            console.error(`[safe-adapter] executeSafeTxBatch refreshed pinned nonce -> ${refreshed}`);
          }

          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes('GS013')) {
            throw err;
          }

          // Safe SDK gas estimation intermittently fails on certain inner calls
          // (notably staking approve+stake batches) even when the transaction itself succeeds.
          return execute({ ...txOptions, gasLimit: SAFE_EXECUTION_FALLBACK_GAS_LIMIT });
        }
      },
      {
        onRetry: ({ attempt, message }) => {
          console.error(`[safe-adapter] executeSafeTxBatch retry ${attempt}: ${message}`);
        },
      },
    ),
  );
}

/**
 * Execute a single Safe transaction directly via the Safe contract, bypassing
 * Safe SDK gas estimation for calls that are known to misbehave under viem.
 */
export async function executeSafeTxDirect(opts: {
  rpcUrl: string;
  signerKey: Hex;
  safeAddress: string;
  to: string;
  value?: bigint;
  data: Hex;
  gasLimit?: bigint;
  ledger?: TxSubmissionLedger;
}): Promise<{ hash: string }> {
  const executionRpcUrl = await resolveExecutionRpcUrl(opts.rpcUrl);
  const chainId = await createPublicClient({ transport: http(executionRpcUrl) }).getChainId();
  const chain = chainForId(chainId, executionRpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(executionRpcUrl),
  });
  const account = privateKeyToAccount(opts.signerKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(executionRpcUrl),
  });

  const safeAddress = opts.safeAddress as Address;
  const to = opts.to as Address;
  const value = opts.value ?? 0n;
  const explicitGasLimit = opts.gasLimit;

  const hash = await withNonceLedger({
    publicClient,
    walletClient,
    ledger: opts.ledger,
    from: account.address,
    chainId,
    recoverStuckNonce: true,
  }, async (nonceLedger) => withRecoverableRetry(
    async (attemptIndex) => {
      const nonce = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: 'nonce',
      });

      const safeTxHash = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: 'getTransactionHash',
        args: [to, value, opts.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
      });

      const sigHex = await walletClient.signMessage({
        account,
        message: { raw: hexToBytes(safeTxHash) },
      });
      const sigBytes = hexToBytes(sigHex);
      const r = bytesToHex(sigBytes.slice(0, 32)) as Hex;
      const s = bytesToHex(sigBytes.slice(32, 64)) as Hex;
      const v = sigBytes[64]! + 4;
      const adjustedSig = concat([r, s, toHex(v, { size: 1 })]);

      const data = encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'execTransaction',
        args: [to, value, opts.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, adjustedSig],
      });

      // Estimate gas dynamically — Safe wrappers around heavy contract creates
      // (mech deploy, large storage writes) have drifted past static defaults
      // before. Estimate once per attempt, apply a 30 % buffer, fall back to
      // SAFE_EXECUTION_FALLBACK_GAS_LIMIT only if the RPC genuinely cannot
      // estimate (transient failures, vendor-specific eth_estimateGas quirks).
      let resolvedGas: bigint;
      if (explicitGasLimit !== undefined) {
        resolvedGas = explicitGasLimit;
      } else {
        try {
          const estimated = await publicClient.estimateGas({
            account: account.address,
            to: safeAddress,
            data,
            value: 0n,
          });
          resolvedGas =
            (estimated * SAFE_EXECUTION_GAS_ESTIMATE_BUFFER_NUMERATOR) /
            SAFE_EXECUTION_GAS_ESTIMATE_BUFFER_DENOMINATOR;
        } catch (err) {
          console.error(
            `[safe-adapter] estimateGas failed for Safe.execTransaction; falling back to ${SAFE_EXECUTION_FALLBACK_GAS_LIMIT.toLocaleString()}: ${
              err instanceof Error ? err.message.split('\n')[0] : String(err)
            }`,
          );
          resolvedGas = BigInt(SAFE_EXECUTION_FALLBACK_GAS_LIMIT);
        }
      }

      const feeResult = await nonceLedger.feeResultForAttempt(attemptIndex, {
        forceEstimate: true,
      });
      const txParams: Parameters<typeof walletClient.sendTransaction>[0] = {
        account,
        to: safeAddress,
        data,
        gas: resolvedGas + BigInt(attemptIndex) * 50_000n,
        nonce: nonceLedger.nonce,
        ...feeResult.overrides,
      };
      removeConflictingLegacyGasPrice(txParams);
      try {
        const hash = await walletClient.sendTransaction(txParams);
        await nonceLedger.recordSubmitted({
          hash,
          logicalTx: 'safe.execTransaction.direct',
          fees: feeResult.snapshot,
          to: safeAddress,
          data,
          value: 0n,
        });
        return hash;
      } catch (err) {
        // Issue #562: a daemon respawn can leave nonceLedger.nonce behind the
        // RPC's pending nonce. Refresh in place so the next retry attempt
        // submits with the fresh value instead of looping on the stale one.
        if (isNonceTooLowError(err)) {
          const refreshed = await nonceLedger.refreshNonce();
          console.error(
            `[safe-adapter] executeSafeTxDirect refreshed pinned nonce -> ${refreshed}`,
          );
        }
        throw err;
      }
    },
    {
      onRetry: ({ attempt, message }) => {
        console.error(`[safe-adapter] executeSafeTxDirect retry ${attempt}: ${message}`);
      },
    },
  ));

  return { hash };
}
