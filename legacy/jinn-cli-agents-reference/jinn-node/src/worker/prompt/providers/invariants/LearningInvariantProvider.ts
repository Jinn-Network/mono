/**
 * LearningInvariantProvider - Converts prescriptive learnings to learning invariants
 *
 * This provider extracts learnings from the recognition phase result
 * and converts prescriptive insights into invariant format.
 * 
 * Domain: learning - Historical patterns from similar jobs
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

interface RecognitionLearning {
    sourceRequestId?: string;
    title?: string;
    insight?: string;
    actions?: string[];
    warnings?: string[];
    confidence?: string;
    artifactCid?: string;
}

/**
 * LearningInvariantProvider converts recognition learnings to invariants
 */
export class LearningInvariantProvider implements InvariantProvider {
    name = 'learning';

    enabled(config: BlueprintBuilderConfig): boolean {
        return config.enableRecognitionLearnings;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const recognition = ctx.recognition;

        if (!recognition) {
            return [];
        }

        const invariants: Invariant[] = [];
        const learnings = this.extractLearnings(recognition.rawLearnings);

        let invariantIndex = 1;
        for (const learning of learnings) {
            const invariant = this.learningToInvariant(learning, invariantIndex);
            if (invariant) {
                invariants.push(invariant);
                invariantIndex++;
            }
        }

        return invariants;
    }

    private extractLearnings(rawLearnings: unknown): RecognitionLearning[] {
        if (!rawLearnings) {
            return [];
        }

        if (Array.isArray(rawLearnings)) {
            return rawLearnings;
        }

        if (typeof rawLearnings === 'object' && rawLearnings !== null) {
            const obj = rawLearnings as Record<string, unknown>;
            if (Array.isArray(obj.learnings)) {
                return obj.learnings;
            }
        }

        return [];
    }

    private learningToInvariant(
        learning: RecognitionLearning,
        index: number
    ): Invariant | null {
        if (!learning.insight && (!learning.warnings || learning.warnings.length === 0)) {
            return null;
        }

        const descriptionParts: string[] = [];

        if (learning.insight) {
            descriptionParts.push(learning.insight);
        }

        if (learning.warnings && learning.warnings.length > 0) {
            descriptionParts.push(`Warning: ${learning.warnings.join('; ')}`);
        }

        const description = descriptionParts.join('. ');

        // Build ONE high-quality do example from the primary action
        const doExample = learning.actions && learning.actions.length > 0
            ? `[Historical Pattern] ${learning.actions[0]}`
            : '[Historical Pattern] Apply this learning from similar jobs';

        // Build ONE high-quality dont example from the primary warning
        const dontExample = learning.warnings && learning.warnings.length > 0
            ? `Ignore warning: ${learning.warnings[0]}`
            : 'Ignore learnings from similar jobs';

        // Build commentary with source info
        const commentaryParts: string[] = [
            'CRITICAL: You must EXECUTE tool calls, not just describe them'
        ];

        if (learning.title) {
            commentaryParts.push(`Learning: ${learning.title}`);
        }
        if (learning.sourceRequestId) {
            commentaryParts.push(`From: ${learning.sourceRequestId.slice(0, 10)}...`);
        }

        return {
            id: `LEARN-${String(index).padStart(3, '0')}`,
            type: 'BOOLEAN',
            condition: `You must apply this learning from similar jobs: ${description}`,
            assessment: 'Verify the learning has been applied and the warning has been heeded.',
            examples: {
                do: [doExample],
                dont: [dontExample],
            },
        };
    }
}
