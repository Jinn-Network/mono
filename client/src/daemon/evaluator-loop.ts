/**
 * The ONE fleet daemon's native evaluator loop (one-swap M4a, umbrella #2461, DR-2026-08-05).
 *
 * The evaluator counterpart of `WorkLoop`: it drives the native evaluator composition's `tick()`
 * (recover in-flight work → poll the signed opportunity source → acquire subject material →
 * evaluate → deliver+settle a verdict) on the shared `runLoop` cadence, so it heartbeats,
 * admission-gates and watchdog-registers exactly like every other loop in `LOOP_REGISTRY`.
 *
 * `admission: 'ready-only'` (registered in `loop-heartbeat.ts`): the evaluator tick is the
 * claim/verdict-settlement path and, like `work`, ALSO reconciles in-flight settlements every tick
 * — the deliberate default per the M3 N2 ruling, so a degraded daemon pauses it rather than letting
 * it settle against a chain view it cannot trust.
 */
import type { NativeEvaluatorComposition } from './native-evaluator-composition.js';
import { runLoop } from './loop-heartbeat.js';
import type { Store } from '../store/store.js';

export interface EvaluatorLoopConfig {
  readonly composition: NativeEvaluatorComposition;
  readonly store: Store;
  readonly pollIntervalMs: number;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

export class EvaluatorLoop {
  private stopped = false;

  constructor(private readonly config: EvaluatorLoopConfig) {}

  private logger(): NonNullable<EvaluatorLoopConfig['logger']> {
    return this.config.logger ?? { info: () => undefined, warn: () => undefined };
  }

  async tick(): Promise<void> {
    const outcome = await this.config.composition.tick();
    this.logger().info(
      `[evaluator] tick: sourceEvents=${outcome.sourceEvents} coordinator=${outcome.coordinator.length}`,
    );
  }

  async run(): Promise<void> {
    await runLoop({
      name: 'evaluator',
      store: this.config.store,
      tick: () => this.tick(),
      intervalMs: this.config.pollIntervalMs,
      stopSignal: () => this.stopped,
      emitSource: 'evaluator',
      onError: (err) => {
        this.logger().warn(
          `[evaluator] tick failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  }

  stop(): void {
    this.stopped = true;
  }
}
