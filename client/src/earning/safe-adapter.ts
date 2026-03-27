/**
 * Thin wrapper around @safe-global/protocol-kit isolating import/init quirks.
 *
 * NodeNext treats protocol-kit's .d.ts as CJS (the package lacks "type":"module"),
 * so `import Safe from '...'` resolves to the module namespace rather than the class.
 * This adapter defines a minimal SafeInstance interface for what we actually use,
 * decoupling the earning bootstrap from SDK type-level instability.
 */

import type { MetaTransactionData, TransactionResult } from '@safe-global/types-kit';

export type { MetaTransactionData, TransactionResult };

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
  return safe.executeTransaction(signedTx);
}
