/**
 * Thin wrapper around @safe-global/protocol-kit isolating import/init quirks.
 *
 * NodeNext treats protocol-kit's .d.ts as CJS (the package lacks "type":"module"),
 * so `import Safe from '...'` resolves to the module namespace rather than the class.
 * This adapter defines a minimal SafeInstance interface for what we actually use,
 * decoupling the earning bootstrap from SDK type-level instability.
 */

import type { MetaTransactionData, TransactionResult } from '@safe-global/types-kit';
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, getBytes, hexlify, concat } from 'ethers';

export type { MetaTransactionData, TransactionResult };

const SAFE_EXECUTION_FALLBACK_GAS_LIMIT = 2_000_000;
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
] as const;

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

async function resolveSafeExecutionRpcUrl(rpcUrl: string): Promise<string> {
  if (!rpcUrl.includes('tenderly.co')) {
    return rpcUrl;
  }

  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();

    if (network.chainId === 8453n) {
      return 'https://base.publicnode.com';
    }

    if (network.chainId === 84532n) {
      return 'https://sepolia.base.org';
    }
  } catch {
    // Fall back to the configured RPC if chain detection fails.
  }

  return rpcUrl;
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

/**
 * Build + sign + execute a batch of calls through a deployed Safe.
 * For 1-of-1 Safes the signer is the sole owner, so sign + execute in one shot.
 */
export async function executeSafeTxBatch(
  safe: SafeInstance,
  transactions: MetaTransactionData[],
): Promise<TransactionResult> {
  const safeTx = await safe.createTransaction({ transactions });
  const signedTx = await safe.signTransaction(safeTx);

  try {
    return await safe.executeTransaction(signedTx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('GS013')) {
      throw err;
    }

    // Safe SDK gas estimation intermittently fails on certain inner calls
    // (notably staking approve+stake batches) even when the transaction itself succeeds.
    return safe.executeTransaction(signedTx, {
      gasLimit: SAFE_EXECUTION_FALLBACK_GAS_LIMIT,
    });
  }
}

/**
 * Execute a single Safe transaction directly via the Safe contract, bypassing
 * Safe SDK gas estimation for calls that are known to misbehave under viem.
 */
export async function executeSafeTxDirect(opts: {
  rpcUrl: string;
  signerKey: string;
  safeAddress: string;
  to: string;
  value?: bigint;
  data: string;
  gasLimit?: bigint;
}): Promise<{ hash: string }> {
  const executionRpcUrl = await resolveSafeExecutionRpcUrl(opts.rpcUrl);
  const provider = new JsonRpcProvider(executionRpcUrl);
  const providerSigner = new Wallet(opts.signerKey, provider);
  const safeRead = new Contract(opts.safeAddress, SAFE_ABI, providerSigner.provider);
  const nonce: bigint = await safeRead.nonce();
  const value = opts.value ?? 0n;

  const safeTxHash: string = await safeRead.getTransactionHash(
    opts.to,
    value,
    opts.data,
    0,
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    nonce,
  );

  const signature = await providerSigner.signMessage(getBytes(safeTxHash));
  const sigBytes = getBytes(signature);
  const r = hexlify(sigBytes.slice(0, 32));
  const s = hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4;
  const adjustedSig = concat([r, s, new Uint8Array([v])]);

  const safeWrite = new Contract(opts.safeAddress, SAFE_ABI, providerSigner);
  const tx = await safeWrite.execTransaction(
    opts.to,
    value,
    opts.data,
    0,
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    adjustedSig,
    { gasLimit: opts.gasLimit ?? SAFE_EXECUTION_FALLBACK_GAS_LIMIT },
  );

  return { hash: tx.hash };
}
