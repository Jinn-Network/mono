import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
} from '../../types.js';
import type { DefaultLearningRestorerImpl } from './restorer.js';
import { harvestOutput } from './harvest.js';

export interface DefaultLearningWrapperConfig {
  /** The shim configured with a harness adapter (Plan 2). */
  shim: DefaultLearningRestorerImpl;
  /**
   * Specialist impls to delegate Execute to when the kind matches. Order
   * matters: first matching specialist wins. Typically this is the
   * existing buildRestorerImpls list MINUS the wrapper itself.
   */
  specialists: RestorerImpl[];
}

/**
 * First-match wrapper per spec §12. Wins for every kind via supports()
 * returning true; internally delegates Execute to the kind-specific
 * specialist when one exists, while the plugin's outer phases (Orient,
 * Strategize, Plan, Debrief, Improve, Memory consolidation) wrap around
 * it as the learning envelope.
 *
 * For intents with no specialist, the wrapper runs the plugin's full
 * pipeline including its own Execute (which spawns step-worker subagents).
 */
export class DefaultLearningWrapper implements RestorerImpl {
  readonly name = 'default-learner';
  readonly version: string;
  private readonly shim: DefaultLearningRestorerImpl;
  private readonly specialists: RestorerImpl[];

  constructor(config: DefaultLearningWrapperConfig) {
    this.shim = config.shim;
    this.specialists = config.specialists;
    this.version = config.shim.version;
  }

  supports(_spec: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return true;
  }

  /**
   * Look up the first specialist whose supports() returns true for this
   * intent's kind/type. The wrapper itself is excluded from the
   * specialists list at construction time.
   */
  private findSpecialist(spec: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | null {
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
      // No specialist — run the plugin's full pipeline.
      return this.shim.run(ctx);
    }

    // Specialist path: tell the plugin coordinator to skip its own
    // Execute phase by setting an env hint the coordinator skill reads.
    const prevSkip = process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE;
    process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE = 'true';
    try {
      // Run the plugin (it will skip Execute internally, leaving
      // workingDir/.execute/ empty).
      await this.shim.run(ctx);
    } finally {
      if (prevSkip === undefined) {
        delete process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE;
      } else {
        process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE = prevSkip;
      }
    }

    // Now the specialist runs. It writes its own workingDir/.execute/
    // outputs (and any other artifacts the kind contract requires).
    const specialistOut = await specialist.run(ctx);

    // Re-harvest workingDir to combine the plugin's outer-phase artifacts
    // with the specialist's Execute outputs into a single
    // RestorationOutput. We also bring forward the specialist's
    // venueRef + any kind-specific gating fields.
    const harvested = harvestOutput(ctx.workingDir);
    return {
      ...specialistOut,
      venueRef: { name: 'default-learner' },
      gating: {
        ...harvested.gating,
        ...specialistOut.gating,
        executeSpecialist: specialist.name,
      },
    };
  }
}
