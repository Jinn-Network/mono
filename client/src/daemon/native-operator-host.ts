/**
 * Native-v1 product lifecycle. This module deliberately has no dependency on the legacy daemon,
 * bridge records, TaskEngine, DeliveryWatcher, or the mixed compatibility composition root.
 * Deployments adapt the B2/B4/B5/B6/B7 production components to these narrow owned ports.
 */

export interface NativeOperatorHealth {
  readonly mode: 'native-v1';
  readonly roleKeyIds: Readonly<Record<string, string>>;
  readonly sourceLag: number;
  readonly leaseOwned: boolean;
  readonly venue: {
    readonly canonicalBlock: string;
    readonly finalizedBlock: string;
    readonly caughtUp: boolean;
  };
  readonly backendReady: boolean;
  readonly evidenceReady: boolean;
  readonly uncertainOperations: number;
  readonly nativeFallbackCount: 0;
}

export interface NativeOperatorHost {
  start(): Promise<void>;
  health(): Promise<NativeOperatorHealth>;
  close(): Promise<void>;
}

export interface NativeOperatorHostInput {
  readonly roleKeyIds: Readonly<Record<string, string>>;
  readonly lease: {
    acquire(): void | Promise<void>;
    owned(): boolean;
    release(): void | Promise<void>;
  };
  readonly bindings: { verify(): Promise<void> };
  readonly venue: {
    rollbackToFinalized(): Promise<void>;
    health(): Promise<{ readonly canonicalBlock: bigint; readonly finalizedBlock: bigint; readonly caughtUp: boolean }>;
    close(): void | Promise<void>;
  };
  readonly operations: {
    reconcileTransactions(): Promise<void>;
    reconcilePublications(): Promise<void>;
    uncertainCount(): number;
  };
  readonly discovery: { sync(): Promise<{ readonly lag: number }> };
  readonly recovery: { recoverBackends(): Promise<void> };
  readonly readiness: {
    backend(): Promise<boolean>;
    evidence(): Promise<boolean>;
  };
  readonly work: { start(): Promise<void>; stop(): void | Promise<void> };
}

export class NativeOperatorHostError extends Error {
  override readonly name = 'NativeOperatorHostError';
}

export function createNativeOperatorHost(input: NativeOperatorHostInput): NativeOperatorHost {
  let sourceLag = Number.POSITIVE_INFINITY;
  let backendReady = false;
  let evidenceReady = false;
  let started = false;
  let closed = false;
  let acquired = false;

  async function cleanup(): Promise<void> {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await input.work.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (acquired && input.lease.owned()) await input.lease.release();
    } catch (error) {
      failures.push(error);
    }
    try {
      await input.venue.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'native operator host cleanup failed');
    }
  }

  async function health(): Promise<NativeOperatorHealth> {
    const venue = await input.venue.health();
    return {
      mode: 'native-v1',
      roleKeyIds: { ...input.roleKeyIds },
      sourceLag,
      leaseOwned: input.lease.owned(),
      venue: {
        canonicalBlock: venue.canonicalBlock.toString(10),
        finalizedBlock: venue.finalizedBlock.toString(10),
        caughtUp: venue.caughtUp,
      },
      backendReady,
      evidenceReady,
      uncertainOperations: input.operations.uncertainCount(),
      nativeFallbackCount: 0,
    };
  }

  return {
    async start() {
      if (closed) throw new NativeOperatorHostError('native operator host is closed');
      if (started) return;
      await input.lease.acquire();
      acquired = true;
      try {
        await input.bindings.verify();
        await input.venue.rollbackToFinalized();
        await input.operations.reconcileTransactions();
        await input.operations.reconcilePublications();
        sourceLag = (await input.discovery.sync()).lag;
        await input.recovery.recoverBackends();
        const venue = await input.venue.health();
        [backendReady, evidenceReady] = await Promise.all([
          input.readiness.backend(),
          input.readiness.evidence(),
        ]);
        if (!input.lease.owned()) throw new NativeOperatorHostError('native worker lease is not owned');
        if (input.operations.uncertainCount() !== 0) {
          throw new NativeOperatorHostError('native startup has a nonterminal uncertain operation');
        }
        if (sourceLag !== 0) throw new NativeOperatorHostError(`native source lag is ${sourceLag}`);
        if (!venue.caughtUp || venue.canonicalBlock < venue.finalizedBlock) {
          throw new NativeOperatorHostError('native venue is not caught up to finalized chain state');
        }
        if (!backendReady || !evidenceReady) {
          throw new NativeOperatorHostError('native backend or evidence runtime is not ready');
        }
        await input.work.start();
        started = true;
      } catch (startupError) {
        try {
          await cleanup();
        } catch (cleanupError) {
          throw new AggregateError(
            [startupError, cleanupError],
            'native operator host startup and cleanup failed',
          );
        }
        throw startupError;
      }
    },
    health,
    async close() {
      await cleanup();
    },
  };
}
