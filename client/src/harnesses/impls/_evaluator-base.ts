/**
 * EvaluatorHarness — shared lifecycle base for the v0 evaluator harnesses (#1583).
 *
 * Hard-codes the four identical lifecycle members that prediction-v0-evaluator,
 * prediction-apy-v0-evaluator, and portfolio-v0-evaluator all copy-pasted:
 * `supports`, `isReady`, `canAttempt`, and the run-time stub guard. Concrete
 * evaluators extend this, supply `name`, a `shape` (solverType + whether a
 * restorationRequestId is required), a `stub` getter over their own config, and
 * their bespoke `run()` — which must call `this.assertLive()` as its first line.
 *
 * Scoped to the three v0 evaluators. `prediction-v1-evaluator` is intentionally
 * NOT migrated (it has an extra `context.solutionTaskCid` canAttempt check);
 * `jinn-repo-evaluator` / `swe-rebench-v2-evaluator` differ in stub storage and
 * override isReady/onEnable. They may adopt this base in a later PR.
 */
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../types.js';
import type { Task } from '../../types/task.js';

export interface EvaluatorHarnessShape {
  /** The solverType this evaluator grades, e.g. 'portfolio.v0'. */
  readonly solverType: string;
  /**
   * When true (the default), canAttempt requires task.restorationRequestId.
   * prediction-apy-v0-evaluator sets this false — it does not check it.
   */
  readonly requiresRestorationRequestId?: boolean;
}

export abstract class EvaluatorHarness implements Harness {
  abstract readonly name: string;
  readonly version = '1.0.0';

  /** Subclass reports whether it was built in stub mode (CLI, no live daemon). */
  protected abstract get stub(): boolean;

  /** Subclass supplies its solverType + canAttempt policy. */
  protected abstract readonly shape: EvaluatorHarnessShape;

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === this.shape.solverType && ctx.role === 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { solverType, requiresRestorationRequestId = true } = this.shape;
    if (task.solverType !== solverType) {
      return { ok: false, reason: `solverType is not ${solverType}` };
    }
    if (task.role !== 'evaluation') {
      return { ok: false, reason: 'role is not evaluation' };
    }
    if (requiresRestorationRequestId && !task.restorationRequestId) {
      return { ok: false, reason: 'restorationRequestId is required' };
    }
    if (typeof task.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  /** Guard the CLI stub path; call as the FIRST line of run(). */
  protected assertLive(): void {
    if (this.stub) {
      throw new Error(`${this.name}: stub registry cannot run evaluation (requires live daemon)`);
    }
  }

  abstract run(ctx: HarnessContext): Promise<Solution>;
}
