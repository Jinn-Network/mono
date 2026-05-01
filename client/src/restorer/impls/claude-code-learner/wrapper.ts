import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ReadyStatus,
  EnableResult,
  ImplIntentPeek,
  IntentEnableMetadata,
} from '../../types.js';
import type { RestorationJob } from '../../../types/desired-state.js';
import type { ClaudeCodeLearnerImpl } from './restorer.js';
import { harvestOutput } from './harvest.js';

export interface ClaudeCodeLearnerWrapperConfig {
  /** The shim configured with a harness adapter (Plan 2). */
  shim: ClaudeCodeLearnerImpl;
  /**
   * Specialist impls to delegate Execute to when the kind matches. Order
   * matters: first matching specialist wins. Typically this is the
   * existing buildRestorerImpls list MINUS the wrapper itself.
   */
  specialists: RestorerImpl[];
}

/**
 * First-match wrapper per spec §12. `supports()` is true for restoration
 * only (`type !== 'evaluation'`); internally delegates Execute and
 * contextual gates (`isReady`, `enableMetadata`, `onEnable` / `onDisable`)
 * to the kind-matched specialist when one exists, while the plugin's outer
 * phases (Orient, Strategize, Plan, Debrief, Improve, Memory consolidation)
 * wrap around it as the learning envelope.
 *
 * For intents with no specialist, the wrapper runs the plugin's full
 * pipeline including its own Execute (which spawns step-worker subagents).
 */
export class ClaudeCodeLearnerWrapper implements RestorerImpl {
  readonly name = 'claude-code-learner';
  readonly version: string;
  private readonly shim: ClaudeCodeLearnerImpl;
  private readonly specialists: RestorerImpl[];

  constructor(config: ClaudeCodeLearnerWrapperConfig) {
    this.shim = config.shim;
    this.specialists = config.specialists;
    this.version = config.shim.version;
  }

  supports(spec: ImplIntentPeek): boolean {
    return spec.type !== 'evaluation';
  }

  async isReady(spec?: ImplIntentPeek): Promise<ReadyStatus> {
    if (spec) {
      const specialist = this.findSpecialist(spec);
      if (!specialist?.isReady) return { ready: true };
      return specialist.isReady(spec);
    }
    // No spec context — wrapper itself has no external deps; return ready.
    return { ready: true };
  }

  enableMetadata(spec?: ImplIntentPeek): IntentEnableMetadata | undefined {
    if (!spec) return undefined;
    const specialist = this.findSpecialist(spec);
    return specialist?.enableMetadata?.(spec);
  }

  async canAttempt(intent: RestorationJob): Promise<{ ok: true } | { ok: false; reason: string }> {
    const spec = {
      kind: intent.spec?.kind ?? '',
      type: intent.type ?? ('restoration' as const),
    };
    return (await this.findSpecialist(spec)?.canAttempt?.(intent)) ?? { ok: true };
  }

  async onEnable(args: Record<string, string | undefined>, spec?: ImplIntentPeek): Promise<EnableResult> {
    if (spec) {
      const specialist = this.findSpecialist(spec);
      if (specialist?.onEnable) return specialist.onEnable(args, spec);
    }
    return { status: 'ready' };
  }

  async onDisable(spec?: ImplIntentPeek): Promise<void> {
    if (spec) {
      const specialist = this.findSpecialist(spec);
      await specialist?.onDisable?.();
    }
    // no-op when no spec or no matching specialist
  }

  /**
   * Look up the first specialist whose supports() returns true for this
   * intent's kind/type. The wrapper itself is excluded from the
   * specialists list at construction time.
   */
  private findSpecialist(spec: ImplIntentPeek): RestorerImpl | null {
    for (const candidate of this.specialists) {
      if (candidate.supports(spec)) return candidate;
    }
    return null;
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const intentSpec = {
      kind: ctx.intent.spec?.kind ?? '',
      type: ctx.intent.type ?? 'restoration',
    } as { kind: string; type?: 'restoration' | 'evaluation' };

    const specialist = this.findSpecialist(intentSpec);

    if (!specialist) {
      // No specialist — run the plugin's full pipeline in one pass.
      return this.shim.run(ctx);
    }

    // Specialist path: two shim invocations bracketing the specialist.

    // Pass 1 — outer pre-Execute phases (Orient, Strategize, Plan).
    await this.shim.runWithAdapterEnv(ctx, {
      JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE: 'pre-execute',
    });

    // Specialist runs the actual Execute. It writes its own kind-specific
    // outputs but does NOT generally populate workingDir/.execute/, so
    // we synthesize a minimal Execute summary from its RestorationOutput
    // before invoking the post-Execute phases.
    const specialistOut = await specialist.run(ctx);
    synthesizeExecuteSummaryFromSpecialist(ctx.workingDir, specialist.name, specialistOut);

    // Pass 2 — outer post-Execute phases (Debrief, Improve, Memory consolidation).
    await this.shim.runWithAdapterEnv(ctx, {
      JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE: 'post-execute',
    });

    // Final harvest combines all phases now that workingDir is fully populated.
    const harvested = harvestOutput(ctx.workingDir);
    return {
      ...specialistOut,
      venueRef: { name: 'claude-code-learner' },
      gating: {
        ...harvested.gating,
        ...specialistOut.gating,
        executeSpecialist: specialist.name,
      },
    };
  }
}

/**
 * Specialists historically write their kind-specific outputs but do not
 * populate the workingDir/.execute/ artifacts the plugin's Debrief phase
 * expects. Synthesize a minimal summary from the specialist's
 * RestorationOutput so the post-Execute phases have something to read
 * and the harvester can lift Execute fields.
 *
 * If the specialist later writes its own real summary.json, the harvester
 * picks that up unchanged on the final harvest pass — this synthesizer is
 * a fallback only.
 */
function synthesizeExecuteSummaryFromSpecialist(
  workingDir: string,
  specialistName: string,
  specialistOut: RestorationOutput,
): void {
  const path = join(workingDir, '.execute', 'summary.json');
  if (existsSync(path)) return; // specialist wrote its own; don't clobber.
  mkdirSync(join(workingDir, '.execute'), { recursive: true });
  const synthetic = {
    stepsCompleted: [`specialist:${specialistName}`],
    stepsFailed: [],
    decisions: [],
    elapsedMs: 0,
    returnReason: 'all-steps-completed',
    synthesizedFromSpecialist: true,
    venueRef: specialistOut.venueRef,
    specialistGating: specialistOut.gating,
  };
  writeFileSync(path, JSON.stringify(synthetic, null, 2));
}
