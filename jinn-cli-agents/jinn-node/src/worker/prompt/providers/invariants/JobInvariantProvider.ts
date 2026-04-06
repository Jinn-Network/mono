/**
 * JobInvariantProvider - Passes through job-specific invariants
 *
 * This provider extracts invariants from the job's blueprint (metadata.blueprint)
 * and passes them through with JOB- prefix.
 *
 * Blueprint MUST be valid JSON with an invariants array. Invalid blueprints
 * cause explicit failures per the code spec's fail-fast principle.
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

/**
 * Expected structure of a job blueprint
 */
interface JobBlueprint {
    invariants: Array<{
        id: string;
        type: string;
        condition: string;
        assessment?: string;
        examples?: {
            do: string[];
            dont: string[];
        };
        // Legacy fields for backward compatibility
        invariant?: string;
        measurement?: string;
    }>;
}

/**
 * JobInvariantProvider passes through job invariants from metadata.blueprint
 */
export class GoalInvariantProvider implements InvariantProvider {
    name = 'job';

    enabled(_config: BlueprintBuilderConfig): boolean {
        return true;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const blueprintStr = ctx.metadata?.blueprint;

        if (!blueprintStr) {
            // No blueprint is valid - system invariants still apply
            return [];
        }

        // Parse the blueprint JSON - fail fast if invalid
        const blueprint = this.parseBlueprint(blueprintStr, ctx.requestId);

        // Map to Invariant format - preserve original IDs from template
        // Template authors should use appropriate prefixes (GOAL-, JOB-, DELEGATE-, etc.)
        // This ensures measurement IDs match exactly for proper UI rendering
        return blueprint.invariants.map((inv) => {
            const id = inv.id;
            const condition = inv.condition || inv.invariant || (inv as unknown as { description?: string }).description || '';
            const assessment = inv.assessment || inv.measurement || '';

            // Create the appropriate invariant type based on the type field
            if (inv.type === 'FLOOR' || inv.type === 'CEILING' || inv.type === 'RANGE') {
                // For numeric types, we need metric and numeric values
                // These should be passed through from the blueprint
                return {
                    id,
                    type: inv.type,
                    metric: (inv as any).metric || '',
                    min: (inv as any).min,
                    max: (inv as any).max,
                    assessment,
                    examples: inv.examples,
                } as Invariant;
            } else {
                // Default to BOOLEAN type
                return {
                    id,
                    type: 'BOOLEAN' as const,
                    condition,
                    assessment,
                    examples: inv.examples,
                };
            }
        });
    }

    /**
     * Parse blueprint string to JSON
     * @throws Error if blueprint is not valid JSON or missing invariants array
     */
    private parseBlueprint(blueprintStr: string, requestId: string): JobBlueprint {
        // Blueprint might already be an object (from internal augmentation)
        let blueprint: unknown;
        if (typeof blueprintStr === 'object') {
            blueprint = blueprintStr;
        } else {
            try {
                blueprint = JSON.parse(blueprintStr);
            } catch (error) {
                throw new Error(
                    `Invalid blueprint for request ${requestId}: Blueprint must be valid JSON. ` +
                    `Got: ${blueprintStr.slice(0, 100)}${blueprintStr.length > 100 ? '...' : ''}`
                );
            }
        }

        // Validate structure
        if (!blueprint || typeof blueprint !== 'object') {
            throw new Error(
                `Invalid blueprint for request ${requestId}: Blueprint must be a JSON object`
            );
        }

        const obj = blueprint as Record<string, unknown>;
        if (!Array.isArray(obj.invariants)) {
            throw new Error(
                `Invalid blueprint for request ${requestId}: Blueprint must have an 'invariants' array. ` +
                `Got keys: ${Object.keys(obj).join(', ')}`
            );
        }

        return blueprint as JobBlueprint;
    }
}

