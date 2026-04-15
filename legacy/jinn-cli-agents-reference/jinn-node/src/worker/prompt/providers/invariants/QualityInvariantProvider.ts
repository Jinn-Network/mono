/**
 * QualityInvariantProvider - Provides quality-related invariants
 *
 * This provider consolidates:
 * - Verification directive (after child work is merged)
 * - Coding standards (for coding jobs)
 * 
 * Domain: quality - Standards, verification, practices
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

const MAX_VERIFICATION_ATTEMPTS = 3;

/**
 * QualityInvariantProvider provides verification and coding standards invariants
 */
export class QualityInvariantProvider implements InvariantProvider {
    name = 'quality';

    enabled(_config: BlueprintBuilderConfig): boolean {
        return true;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const invariants: Invariant[] = [];

        invariants.push(...this.getVerificationInvariants(ctx));
        invariants.push(...this.getCodingStandardsInvariants(ctx));

        return invariants;
    }

    private getVerificationInvariants(ctx: BuildContext): Invariant[] {
        const additionalContext = ctx.metadata.additionalContext;
        const verificationRequired = additionalContext?.verificationRequired === true;

        if (!verificationRequired) {
            return [];
        }

        const verificationAttempt = additionalContext?.verificationAttempt ?? 1;
        const isLastAttempt = verificationAttempt >= MAX_VERIFICATION_ATTEMPTS;

        const invariants: Invariant[] = [
            {
                id: 'QUAL-VERIFY',
                type: 'BOOLEAN',
                condition: `You must verify deliverables satisfy your goal invariants after merging child work (attempt ${verificationAttempt}/${MAX_VERIFICATION_ATTEMPTS}). For UI work, you must use browser_automation tools.`,
                assessment: 'Verify that each GOAL-* invariant has been explicitly checked against the merged deliverables.',
                examples: {
                    do: ['For each GOAL-* invariant, verify it is actually satisfied; for UI: use browser_automation to run the app'],
                    dont: ['Report COMPLETED without explicitly verifying each invariant against deliverables'],
                },
            },
        ];

        if (isLastAttempt) {
            invariants.push({
                id: 'QUAL-VERIFY-FINAL',
                type: 'BOOLEAN',
                condition: `You must report FAILED with explanation if you cannot verify all invariants are satisfied (final attempt).`,
                assessment: 'Verify that if any invariants cannot be satisfied, the status is FAILED with specific explanations.',
                examples: {
                    do: ['If invariants cannot be satisfied, report FAILED with specifics'],
                    dont: ['Report COMPLETED if invariants remain unverified'],
                },
            });
        }

        return invariants;
    }

    private getCodingStandardsInvariants(ctx: BuildContext): Invariant[] {
        const isCodingJob = ctx.metadata.additionalContext?.isCodingJob === true;

        if (!isCodingJob) {
            return [];
        }

        return [
            {
                id: 'QUAL-CODING',
                type: 'BOOLEAN',
                condition: 'You write code that can be tested and automated',
                assessment: 'Key functionality is accessible for testing. UI elements can be reliably selected. State can be inspected.',
                examples: {
                    do: ['Expose entry points for testing', 'Use stable selectors (data attributes, unique IDs)'],
                    dont: ['Bury all logic in closures with no external access', 'Use fragile CSS selectors'],
                },
            }
        ];
    }
}
