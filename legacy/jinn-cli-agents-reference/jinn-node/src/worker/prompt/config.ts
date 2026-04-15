/**
 * BlueprintBuilder Configuration
 *
 * This module provides blueprint-specific configuration by importing
 * from the canonical config module (config/index.ts). It exists solely
 * to provide a typed interface for BlueprintBuilderConfig.
 *
 * All environment variable access goes through config/index.ts getters.
 * This module never reads process.env directly.
 *
 * See: docs/code-spec/spec.md "Centralize configuration access"
 */

import type { BlueprintBuilderConfig } from './types.js';
import { config } from '../../config/index.js';

/**
 * Default configuration for the BlueprintBuilder
 * All values come from centralized config
 */
export const DEFAULT_BLUEPRINT_CONFIG: BlueprintBuilderConfig = {
  enableSystemBlueprint: config.blueprint.enableSystem,
  enableContextAssertions: config.blueprint.enableContextAssertions,
  // Master switch overrides individual recognition/progress settings
  enableRecognitionLearnings: config.blueprint.enableContextPhases && config.blueprint.enableRecognition,
  enableJobContext: config.blueprint.enableJobContext,
  enableProgressCheckpoint: config.blueprint.enableContextPhases && config.blueprint.enableProgress,
  enableBeadsAssertions: config.blueprint.enableBeads,
  enableContextPhases: config.blueprint.enableContextPhases,
  debug: config.blueprint.debug,
  logProviders: config.blueprint.logProviders,
};

/**
 * Create a config with explicit overrides
 * No longer reads from environment directly
 */
export function createConfigFromEnv(
  overrides?: Partial<BlueprintBuilderConfig>
): BlueprintBuilderConfig {
  return {
    ...DEFAULT_BLUEPRINT_CONFIG,
    ...overrides,
  };
}
