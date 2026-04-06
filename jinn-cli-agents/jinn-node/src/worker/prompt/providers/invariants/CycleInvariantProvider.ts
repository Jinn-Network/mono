/**
 * CycleInvariantProvider - Injects cyclic operation directive for continuous jobs
 *
 * When a job is marked as cyclic and is re-dispatched for a new cycle,
 * this provider injects invariants that instruct the agent to reassess
 * all JOB invariants and dispatch work as needed to ensure ongoing satisfaction.
 *
 * Domain: cycle - Continuous/ongoing operation
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

/**
 * CycleInvariantProvider injects cyclic operation directive when cycleRun is set
 */
export class CycleInvariantProvider implements InvariantProvider {
    name = 'cycle';

    enabled(_config: BlueprintBuilderConfig): boolean {
        return true;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const additionalContext = ctx.metadata.additionalContext;
        const cycleInfo = additionalContext?.cycle;

        // Only inject if this is a cycle run
        if (!cycleInfo?.isCycleRun) {
            return [];
        }

        const cycleNumber = cycleInfo.cycleNumber ?? 1;
        const previousCycleCompletedAt = cycleInfo.previousCycleCompletedAt;

        const invariants: Invariant[] = [
            {
                id: 'CYCLE-001',
                type: 'BOOLEAN',
                condition: `You must evaluate the current state of all job invariants (Cycle ${cycleNumber}) and take action to ensure they remain satisfied. You must perform direct work, dispatch child jobs for assessment, or dispatch child jobs for remediation as needed.`,
                assessment: 'Verify current state has been evaluated and appropriate action has been taken to maintain satisfaction of all job invariants.',
                examples: {
                    do: [
                        'Dispatch child jobs to assess invariant satisfaction if assessment is complex',
                        'Dispatch child jobs to remediate unsatisfied invariants',
                        'Perform direct assessment and work if straightforward',
                    ],
                    dont: [
                        'Assume previous cycle state is still valid without checking',
                        'Report COMPLETED without addressing invariants that need attention',
                    ],
                },
            },
            {
                id: 'CYCLE-002',
                type: 'BOOLEAN',
                condition: `You must build on work from the previous cycle (completed at ${previousCycleCompletedAt || 'unknown'}). Check hierarchy.children for existing child jobs and use dispatch_existing_job to continue their work. Only use dispatch_new_job for genuinely new work scopes.`,
                assessment: 'Verify existing children are re-dispatched via dispatch_existing_job by jobName. Only new work scopes use dispatch_new_job.',
                examples: {
                    do: [
                        'Check hierarchy.children for existing child jobs before dispatching',
                        'Use dispatch_existing_job({ jobName: "Content Manager" }) for existing children',
                        'Use dispatch_new_job only for new capabilities not in hierarchy',
                    ],
                    dont: [
                        'Use dispatch_new_job for a child that already exists in hierarchy',
                        'Duplicate job definitions for recurring work',
                        'Lose context between cycles by always using dispatch_new_job',
                    ],
                },
            },
        ];

        return invariants;
    }
}
