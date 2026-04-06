/**
 * SystemInvariantProvider - Provides static system invariants
 *
 * This provider loads the system-blueprint.json file which contains
 * the core protocol invariants that define agent identity and behavior.
 * 
 * Domain: system - Agent identity and core behavior rules
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
} from '../../types.js';

// Load system blueprint once at module initialization
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SystemBlueprintJson {
    invariants: Invariant[];
}

let cachedSystemBlueprint: SystemBlueprintJson | null = null;

/**
 * Find the system blueprint JSON file
 * Tries multiple paths to be resilient to build output changes
 */
function findSystemBlueprintPath(): string {
    const possiblePaths = [
        // Relative to this file (compiled output)
        join(__dirname, '../../system-blueprint.json'),
        // Relative to worker/prompt directory
        join(__dirname, '../../../worker/prompt/system-blueprint.json'),
        // From process.cwd()
        join(process.cwd(), 'worker/prompt/system-blueprint.json'),
    ];

    for (const path of possiblePaths) {
        if (existsSync(path)) {
            return path;
        }
    }

    throw new Error(
        `Could not find system-blueprint.json. Tried paths: ${possiblePaths.join(', ')}`
    );
}

/**
 * Load the system blueprint JSON file
 */
function loadSystemBlueprint(): SystemBlueprintJson {
    if (cachedSystemBlueprint) {
        return cachedSystemBlueprint;
    }

    const blueprintPath = findSystemBlueprintPath();
    const content = readFileSync(blueprintPath, 'utf8');
    cachedSystemBlueprint = JSON.parse(content);
    return cachedSystemBlueprint!;
}

/**
 * SystemInvariantProvider loads static system invariants from system-blueprint.json
 */
export class SystemInvariantProvider implements InvariantProvider {
    name = 'system';

    enabled(config: BlueprintBuilderConfig): boolean {
        return config.enableSystemBlueprint;
    }

    async provide(
        ctx: BuildContext,
        _builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const blueprint = loadSystemBlueprint();

        let invariants = blueprint.invariants;

        // If this is an artifact-only job (no code metadata), exclude coding-specific system invariants
        // that mandate git workflows (branches, commits, process_branch)
        if (!ctx.metadata.codeMetadata) {
            const CODING_INVARIANTS = ['SYS-010']; // SYS-010 is the git workflow invariant
            invariants = invariants.filter((i) => !CODING_INVARIANTS.includes(i.id));
        }

        return invariants;
    }
}

/**
 * Clear the cached system blueprint (for testing)
 * @internal
 */
export function _clearSystemBlueprintCache(): void {
    cachedSystemBlueprint = null;
}
