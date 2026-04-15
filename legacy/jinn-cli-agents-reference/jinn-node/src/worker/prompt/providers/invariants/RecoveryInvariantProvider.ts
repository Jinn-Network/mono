/**
 * RecoveryInvariantProvider - Injects loop recovery directive after loop termination
 *
 * When a job is re-dispatched after loop protection terminated the previous run,
 * this provider injects a strong invariant with context about what went wrong
 * and guidance for approaching the task differently.
 * 
 * Domain: recovery - Error handling, loop recovery
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

const MAX_LOOP_RECOVERY_ATTEMPTS = 3;

/**
 * RecoveryInvariantProvider injects recovery directive when loopRecovery is set
 */
export class RecoveryInvariantProvider implements InvariantProvider {
    name = 'recovery';

    enabled(_config: BlueprintBuilderConfig): boolean {
        return true;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const additionalContext = ctx.metadata.additionalContext;
        const loopRecovery = additionalContext?.loopRecovery;

        if (!loopRecovery) {
            return [];
        }

        const attempt = loopRecovery.attempt ?? 1;
        const isLastAttempt = attempt >= MAX_LOOP_RECOVERY_ATTEMPTS;
        const loopMessage = loopRecovery.loopMessage || 'Previous run terminated due to unproductive loop';

        const invariants: Invariant[] = [
            {
                id: 'RECOV-LOOP',
                type: 'BOOLEAN',
                condition: `You must approach this task differently (attempt ${attempt}/${MAX_LOOP_RECOVERY_ATTEMPTS}). Previous run was terminated because: "${loopMessage}".`,
                assessment: 'Verify that the current approach differs from the sequence of actions that caused the loop.',
                examples: {
                    do: ['Verify CURRENT state of files before making changes; if already correct, acknowledge and move on'],
                    dont: ['Repeat the same sequence of actions that caused the loop'],
                },
            },
        ];

        if (isLastAttempt) {
            invariants.push({
                id: 'RECOV-FINAL',
                type: 'BOOLEAN',
                condition: `You must report FAILED with explanation if you cannot complete the task without entering a loop (final attempt).`,
                assessment: 'Verify that if the task is genuinely blocked, the status is FAILED with specific details about the blocking issue.',
                examples: {
                    do: ['If genuinely blocked, report FAILED with specifics about what is preventing completion'],
                    dont: ['Enter another loop on the final attempt'],
                },
            });
        }

        return invariants;
    }
}
