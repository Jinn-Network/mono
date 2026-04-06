/**
 * Default configuration values and YAML auto-generation.
 */
import { configSchema, type RawNodeConfig } from './schema.js';
import YAML from 'yaml';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Generate a default config object by parsing an empty input through the Zod schema.
 */
export function generateDefaultConfig(): RawNodeConfig {
    return configSchema.parse({});
}

/**
 * Generate a commented YAML string with all default values.
 */
export function getDefaultYaml(): string {
    const defaults = generateDefaultConfig();
    const header = `# jinn.yaml — Node operator configuration
# Auto-generated with defaults. Edit what you need.
# Secrets (RPC_URL, API keys, passwords) stay in .env (never committed).
# Env vars override YAML values (see docs for mapping).
`;
    return header + YAML.stringify(defaults, { lineWidth: 120 });
}

/**
 * Write a default jinn.yaml to the given directory if one doesn't already exist.
 * Returns the path to the file.
 */
export function writeDefaultConfigIfMissing(dir: string): string {
    const filePath = join(dir, 'jinn.yaml');
    if (!existsSync(filePath)) {
        writeFileSync(filePath, getDefaultYaml(), 'utf-8');
    }
    return filePath;
}
