/**
 * Native-v1 product lifecycle. This module deliberately has no dependency on the legacy daemon,
 * bridge records, TaskEngine, DeliveryWatcher, or the mixed compatibility composition root.
 * Deployments adapt the B2/B4/B5/B6/B7 production components to these narrow owned ports.
 */

export interface NativeOperatorHealth {
  readonly mode: 'native-v1';
  readonly role: 'requester' | 'solver' | 'evaluator';
  readonly roleKeyIds: Readonly<Record<string, string>>;
  readonly sourceLag: number;
  readonly sourceLagBySource: Readonly<Record<string, number>>;
  readonly leaseOwned: boolean;
  readonly venue: {
    readonly canonicalBlock: string;
    readonly finalizedBlock: string;
    readonly caughtUp: boolean;
  };
  readonly backendReady: boolean;
  readonly backendRequired: boolean;
  readonly executableDigest?: `sha256:${string}`;
  readonly evidenceReady: boolean;
  readonly evidenceRequired: boolean;
  readonly publicSourceReady: boolean;
  readonly uncertainOperations: number;
  readonly nativeFallbackCount: 0;
}

export interface NativeOperatorHost {
  start(): Promise<void>;
  health(): Promise<NativeOperatorHealth>;
  close(): Promise<void>;
}

export interface NativeOperatorHostInput {
  readonly role: NativeOperatorHealth['role'];
  readonly roleKeyIds: Readonly<Record<string, string>>;
  readonly lease: {
    acquire(): void | Promise<void>;
    owned(): boolean | Promise<boolean>;
    renew?(): void | Promise<void>;
    release(): void | Promise<void>;
  };
  /** Defaults to ten seconds, below the production lease's thirty-second TTL. */
  readonly leaseRenewIntervalMs?: number;
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
  readonly discovery: { sync(): Promise<{ readonly lag: number; readonly bySource?: Readonly<Record<string, number>> }> };
  readonly recovery: { recoverBackends(): Promise<void> };
  readonly readiness: {
    readonly backendRequired: boolean;
    readonly evidenceRequired: boolean;
    backend(): Promise<boolean>;
    evidence(): Promise<boolean>;
    publicSource(): Promise<boolean>;
    readonly executableDigest?: `sha256:${string}`;
  };
  readonly work: {
    start(): Promise<void>;
    stop(): void | Promise<void>;
    /** A terminal asynchronous loop failure. Healthy native workers never suppress this. */
    failure?(): unknown;
  };
}

export class NativeOperatorHostError extends Error {
  override readonly name = 'NativeOperatorHostError';
}

export function createNativeOperatorHost(input: NativeOperatorHostInput): NativeOperatorHost {
  let sourceLag = Number.POSITIVE_INFINITY;
  let sourceLagBySource: Readonly<Record<string, number>> = {};
  let backendReady = false;
  let evidenceReady = false;
  let publicSourceReady = false;
  let started = false;
  let closed = false;
  let acquired = false;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  let renewing = false;
  let renewalFailure: unknown;

  async function cleanup(): Promise<void> {
    if (closed) return;
    closed = true;
    if (renewalTimer !== undefined) {
      clearInterval(renewalTimer);
      renewalTimer = undefined;
    }
    const failures: unknown[] = [];
    try {
      await input.work.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (acquired && await input.lease.owned()) await input.lease.release();
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
    if (renewalFailure !== undefined) {
      throw new NativeOperatorHostError(`native worker lease renewal failed: ${String(renewalFailure)}`);
    }
    const workFailure = input.work.failure?.();
    if (workFailure !== undefined) {
      throw new NativeOperatorHostError(`native background work loop failed: ${String(workFailure)}`);
    }
    const venue = await input.venue.health();
    return {
      mode: 'native-v1',
      role: input.role,
      roleKeyIds: { ...input.roleKeyIds },
      sourceLag,
      sourceLagBySource: { ...sourceLagBySource },
      leaseOwned: await input.lease.owned(),
      venue: {
        canonicalBlock: venue.canonicalBlock.toString(10),
        finalizedBlock: venue.finalizedBlock.toString(10),
        caughtUp: venue.caughtUp,
      },
      backendReady,
      backendRequired: input.readiness.backendRequired,
      ...(input.readiness.executableDigest === undefined ? {} : { executableDigest: input.readiness.executableDigest }),
      evidenceReady,
      evidenceRequired: input.readiness.evidenceRequired,
      publicSourceReady,
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
      if (input.lease.renew !== undefined) {
        renewalTimer = setInterval(() => {
          if (closed || renewing || input.lease.renew === undefined) return;
          renewing = true;
          void Promise.resolve(input.lease.renew()).catch(async (cause: unknown) => {
            renewalFailure = cause;
            await cleanup().catch((cleanupCause: unknown) => {
              renewalFailure = new AggregateError([cause, cleanupCause], 'native lease renewal cleanup failed');
            });
          }).finally(() => { renewing = false; });
        }, input.leaseRenewIntervalMs ?? 10_000);
        renewalTimer.unref?.();
      }
      try {
        await input.bindings.verify();
        await input.venue.rollbackToFinalized();
        await input.operations.reconcileTransactions();
        await input.operations.reconcilePublications();
        const discovery = await input.discovery.sync();
        sourceLag = discovery.lag;
        sourceLagBySource = discovery.bySource ?? {};
        await input.recovery.recoverBackends();
        const venue = await input.venue.health();
        [backendReady, evidenceReady, publicSourceReady] = await Promise.all([
          input.readiness.backend(),
          input.readiness.evidence(),
          input.readiness.publicSource(),
        ]);
        if (!await input.lease.owned()) throw new NativeOperatorHostError('native worker lease is not owned');
        if (renewalFailure !== undefined) throw new NativeOperatorHostError('native worker lease renewal failed during startup');
        if (input.operations.uncertainCount() !== 0) {
          throw new NativeOperatorHostError('native startup has a nonterminal uncertain operation');
        }
        if (sourceLag !== 0) throw new NativeOperatorHostError(`native source lag is ${sourceLag}`);
        if (!venue.caughtUp || venue.canonicalBlock < venue.finalizedBlock) {
          throw new NativeOperatorHostError('native venue is not caught up to finalized chain state');
        }
        if ((input.readiness.backendRequired && !backendReady)
          || (input.readiness.evidenceRequired && !evidenceReady)
          || !publicSourceReady) {
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
