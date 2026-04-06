/**
 * StrategyInvariantProvider - Injects strategy directives for delegation
 *
 * When goal invariants >= threshold, this provider adds a prominent invariant
 * instructing the agent to decompose and delegate rather than execute directly.
 * 
 * Domain: strategy - How to approach work (delegation)
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';
import type { IpfsMetadata } from '../../../types.js';

const DELEGATION_THRESHOLD = 4;

/**
 * StrategyInvariantProvider injects a delegation directive when invariant count is high
 */
export class StrategyInvariantProvider implements InvariantProvider {
    name = 'strategy';

    enabled(_config: BlueprintBuilderConfig): boolean {
        return true;
    }

    async provide(
        ctx: BuildContext,
        builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const goalInvariantCount = this.countGoalInvariants(ctx.metadata);

        const hasCompletedChildren =
            (builtContext.hierarchy?.children?.filter(
                (c) => c.status === 'COMPLETED' || c.status === 'FAILED'
            ) ?? []).length > 0;

        if (hasCompletedChildren) {
            return [];
        }

        if (goalInvariantCount < DELEGATION_THRESHOLD) {
            return [];
        }

        return [
            {
                id: 'STRAT-DELEGATE',
                type: 'BOOLEAN',
                condition: `You decompose work across children rather than executing ${goalInvariantCount} goal invariants directly`,
                assessment: `Work is distributed: each child has fewer or more specific invariants than parent. No child mirrors parent 1:1.`,
                examples: {
                    do: [
                        `${goalInvariantCount} GOALs -> 3 children, each handling 2-3 related GOALs`,
                        'Complex GOAL -> split into specific sub-tasks for children',
                    ],
                    dont: [
                        `Execute all ${goalInvariantCount} GOALs inline`,
                        `1 child with same ${goalInvariantCount} GOALs (deferral, not decomposition)`,
                    ],
                },
            },
        ];
    }

    private countGoalInvariants(metadata: IpfsMetadata): number {
        if (!metadata?.blueprint) return 0;
        try {
            const blueprint =
                typeof metadata.blueprint === 'string'
                    ? JSON.parse(metadata.blueprint)
                    : metadata.blueprint;
            return Array.isArray(blueprint.invariants) ? blueprint.invariants.length : 0;
        } catch {
            return 0;
        }
    }
}
