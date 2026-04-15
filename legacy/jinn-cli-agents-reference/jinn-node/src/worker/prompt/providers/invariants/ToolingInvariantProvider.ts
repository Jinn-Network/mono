/**
 * ToolingInvariantProvider - Provides beads issue tracking invariants for coding jobs
 *
 * This provider injects instructions for using the beads (bd) CLI for issue tracking
 * during coding work. It's only enabled when:
 * 1. config.enableBeadsAssertions is true
 * 2. The job has codeMetadata (is a coding job)
 * 
 * Domain: tooling - Tool-specific workflows (beads)
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

/**
 * ToolingInvariantProvider provides beads issue tracking workflow instructions
 */
export class ToolingInvariantProvider implements InvariantProvider {
    name = 'tooling';

    enabled(config: BlueprintBuilderConfig): boolean {
        return config.enableBeadsAssertions;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        if (!ctx.metadata.codeMetadata) {
            return [];
        }

        return [{
            id: 'TOOL-BEADS',
            type: 'BOOLEAN',
            condition: 'You track work using beads issue tracking, closing issues when complete',
            assessment: 'Issues relevant to this work are closed. .beads/issues.jsonl reflects completed work and is committed.',
            examples: {
                do: ['Claim relevant issues, close them when done, commit .beads/issues.jsonl'],
                dont: ['Use markdown TODOs instead of beads', 'Leave issues open after completing work'],
            },
        }];
    }
}
