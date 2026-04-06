/**
 * Centralized Prompt Building System
 *
 * This module exports the unified blueprint building system that replaces
 * the fragmented GEMINI.md-based prompt construction.
 *
 * Usage:
 *   import { createBlueprintBuilder } from './worker/prompt';
 *   const builder = createBlueprintBuilder();
 *   const prompt = await builder.buildPrompt(requestId, metadata, recognition);
 */

// Core types
export type {
  Invariant,
  BlueprintContext,
  HierarchyContext,
  ProgressContext,
  ArtifactInfo,
  ChildJobInfo,
  UnifiedBlueprint,
  BlueprintMetadata,
  BlueprintBuilderConfig,
  BuildContext,
  ContextProvider,
  InvariantProvider,
  BlueprintBuildResult,
} from './types.js';

// Configuration
export { DEFAULT_BLUEPRINT_CONFIG, createConfigFromEnv } from './config.js';

// Builder
export { BlueprintBuilder, createBlueprintBuilder } from './BlueprintBuilder.js';

// Renderer - for direct prose rendering of blueprints
export {
  renderBlueprintToProse,
  renderInvariantsByLayer,
  renderInvariant,
  renderInvariantCompact,
  renderInvariantAsDirective,
} from './invariant-renderer.js';

// Context providers
export { JobContextProvider } from './providers/context/JobContextProvider.js';
export { ProgressCheckpointProvider } from './providers/context/ProgressCheckpointProvider.js';

// Assertion providers
export {
  SystemInvariantProvider,
  _clearSystemBlueprintCache,
  GoalInvariantProvider,
  LearningInvariantProvider,
  CoordinationInvariantProvider,
  StateInvariantProvider,
  StrategyInvariantProvider,
  RecoveryInvariantProvider,
  ToolingInvariantProvider,
  QualityInvariantProvider,
} from './providers/invariants/index.js';
