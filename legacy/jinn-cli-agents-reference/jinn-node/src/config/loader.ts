/**
 * Config loader pipeline: YAML → env override → Zod validate → freeze.
 *
 * Startup flow:
 * 1. Find/auto-generate jinn.yaml
 * 2. Parse YAML
 * 3. Deep-merge env var overrides (via aliases.ts)
 * 4. Validate with Zod schema
 * 5. Transform snake_case → camelCase
 * 6. Freeze and return
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import YAML from 'yaml';
import { configSchema, type RawNodeConfig, type NodeConfig } from './schema.js';
import { resolveEnvOverrides } from './aliases.js';
import { writeDefaultConfigIfMissing } from './defaults.js';

// ============================================================================
// camelCase transform
// ============================================================================

/**
 * Convert a snake_case string to camelCase.
 */
function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively transform all keys in an object from snake_case to camelCase.
 */
function camelCaseKeys(obj: any): any {
    if (Array.isArray(obj)) return obj.map(camelCaseKeys);
    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[snakeToCamel(key)] = camelCaseKeys(value);
        }
        return result;
    }
    return obj;
}

/**
 * Deep-freeze an object (make it and all nested objects read-only).
 */
function deepFreeze<T extends Record<string, any>>(obj: T): Readonly<T> {
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return obj;
}

export type { NodeConfig } from './schema.js';
export type FrozenNodeConfig = Readonly<NodeConfig>;

// ============================================================================
// Config value source tracking
// ============================================================================

export interface ConfigSource {
    key: string;
    value: string;
    source: 'yaml' | 'env' | 'default';
    envVar?: string;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Find the jinn.yaml config file by walking up from baseDir.
 */
function findConfigFile(baseDir: string): string | null {
    if (process.env.JINN_CONFIG && existsSync(process.env.JINN_CONFIG)) {
        return process.env.JINN_CONFIG;
    }
    let dir = baseDir;
    for (let i = 0; i < 5; i++) {
        const candidate = join(dir, 'jinn.yaml');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Deep merge two objects. Source values overwrite target values.
 * Arrays are replaced, not concatenated.
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)
            && result[key] !== null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Load, validate, and freeze the node configuration.
 *
 * @param baseDir Directory to search for jinn.yaml (default: CWD)
 * @param env Environment variables to read (default: process.env)
 * @returns Frozen, validated config object with camelCase keys
 */
export function loadNodeConfig(
    baseDir?: string,
    env?: Record<string, string | undefined>,
): FrozenNodeConfig {
    const effectiveBaseDir = baseDir ?? process.cwd();
    const effectiveEnv = env ?? (process.env as Record<string, string | undefined>);

    // 1. Find or auto-generate jinn.yaml
    let configPath = findConfigFile(effectiveBaseDir);
    let yamlContent: Record<string, any> = {};

    if (configPath) {
        const raw = readFileSync(configPath, 'utf-8');
        yamlContent = YAML.parse(raw) || {};
    } else {
        // No jinn.yaml found — try to auto-generate, but tolerate read-only filesystems
        try {
            configPath = writeDefaultConfigIfMissing(effectiveBaseDir);
        } catch {
            // Read-only filesystem (e.g. Railway container) — proceed with defaults
        }
    }

    // 2. Build env var overrides
    const envOverrides = resolveEnvOverrides(effectiveEnv);

    // 3. Deep-merge: YAML base, then env overrides on top
    const merged = deepMerge(yamlContent, envOverrides);

    // 4. Validate with Zod (fills in defaults for missing keys)
    const validated = configSchema.parse(merged);

    // 5. Transform to camelCase
    const camelCased = camelCaseKeys(validated) as NodeConfig;

    // 6. Freeze and return
    return deepFreeze(camelCased);
}
