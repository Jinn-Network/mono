/**
 * Centralized Prompt Building Types
 *
 * This module defines the core types for the homomorphic blueprint system
 * that replaces the fragmented GEMINI.md-based prompt building.
 */

import type { IpfsMetadata } from '../types.js';
import type { RecognitionPhaseResult } from '../recognition_helpers.js';

// Re-export AdditionalContext types for provider access
export type {
  HierarchyJob,
  HierarchySummary,
  WorkProtocolMessage,
  CompletedChildRun,
  AdditionalContext,
} from '../types.js';

// =============================================================================
// Invariant Types (Four-Type Schema)
// =============================================================================

/**
 * Examples of correct and incorrect application
 */
export interface InvariantExamples {
  do: string[];
  dont: string[];
}

/**
 * FLOOR invariant - metric must be at least min value
 *
 * Use for: minimum thresholds, quality floors, required counts
 * Example: "content_quality must be at least 70"
 */
export interface FloorInvariant {
  id: string;
  type: 'FLOOR';
  /** What is being measured */
  metric: string;
  /** Minimum acceptable value */
  min: number;
  /** HOW to get the data to check this invariant */
  assessment: string;
  /** Optional examples of correct/incorrect application */
  examples?: InvariantExamples;
}

/**
 * CEILING invariant - metric must be at most max value
 *
 * Use for: cost limits, error thresholds, resource caps
 * Example: "compute_cost_usd must be at most 20"
 */
export interface CeilingInvariant {
  id: string;
  type: 'CEILING';
  /** What is being measured */
  metric: string;
  /** Maximum acceptable value */
  max: number;
  /** HOW to get the data to check this invariant */
  assessment: string;
  /** Optional examples of correct/incorrect application */
  examples?: InvariantExamples;
}

/**
 * RANGE invariant - metric must be between min and max
 *
 * Use for: bounded values, goldilocks zones, frequency targets
 * Example: "posts_per_week must be between 3 and 7"
 */
export interface RangeInvariant {
  id: string;
  type: 'RANGE';
  /** What is being measured */
  metric: string;
  /** Minimum acceptable value */
  min: number;
  /** Maximum acceptable value */
  max: number;
  /** HOW to get the data to check this invariant */
  assessment: string;
  /** Optional examples of correct/incorrect application */
  examples?: InvariantExamples;
}

/**
 * BOOLEAN invariant - condition must be true
 *
 * Use for: process checks, existence validation, state verification
 * Example: "Build passes without errors"
 */
export interface BooleanInvariant {
  id: string;
  type: 'BOOLEAN';
  /** The condition that must be true */
  condition: string;
  /** HOW to check whether this condition is satisfied */
  assessment: string;
  /** Optional examples of correct/incorrect application */
  examples?: InvariantExamples;
}

/**
 * Discriminated union of all invariant types
 *
 * The type field determines which fields are required:
 * - FLOOR: metric, min, assessment
 * - CEILING: metric, max, assessment
 * - RANGE: metric, min, max, assessment
 * - BOOLEAN: condition, assessment
 */
export type Invariant = FloorInvariant | CeilingInvariant | RangeInvariant | BooleanInvariant;

/**
 * Venture invariant — homeostatic, continuous monitoring.
 * Only FLOOR/CEILING/RANGE types (not BOOLEAN, which is task-completion oriented).
 * Used for venture-level goals that persist across workstreams.
 */
export type VentureInvariant = FloorInvariant | CeilingInvariant | RangeInvariant;

/**
 * Workstream invariant — task completion, finite scope.
 * All invariant types are valid for workstream goals.
 */
export type WorkstreamInvariant = Invariant;

/**
 * Type guard for FloorInvariant
 */
export function isFloorInvariant(inv: Invariant): inv is FloorInvariant {
  return inv.type === 'FLOOR';
}

/**
 * Type guard for CeilingInvariant
 */
export function isCeilingInvariant(inv: Invariant): inv is CeilingInvariant {
  return inv.type === 'CEILING';
}

/**
 * Type guard for RangeInvariant
 */
export function isRangeInvariant(inv: Invariant): inv is RangeInvariant {
  return inv.type === 'RANGE';
}

/**
 * Type guard for BooleanInvariant
 */
export function isBooleanInvariant(inv: Invariant): inv is BooleanInvariant {
  return inv.type === 'BOOLEAN';
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Child job information in the hierarchy
 */
export interface ChildJobInfo {
  requestId: string;
  jobName?: string;
  status: 'COMPLETED' | 'ACTIVE' | 'FAILED';
  summary?: string;
  /** Branch name where this child job worked (for parent review) */
  branchName?: string;
  /** Base branch the child branched from */
  baseBranch?: string;
  /** Whether the child's work is already integrated into parent (commits merged or rejected) */
  isIntegrated?: boolean;
}

/**
 * Job hierarchy context
 */
export interface HierarchyContext {
  totalJobs: number;
  completedJobs: number;
  activeJobs: number;
  children: ChildJobInfo[];
}

/**
 * Progress context from prior runs
 */
export interface ProgressContext {
  /** AI-generated summary of prior work */
  summary: string;
  /** Phases that have been completed */
  completedPhases?: string[];
}

/**
 * Artifact information
 */
export interface ArtifactInfo {
  name: string;
  cid: string;
  type?: string;
}

/**
 * Measurement information for an invariant
 *
 * This is the latest measurement for a specific invariant,
 * used to show agents the current state when evaluating invariants.
 */
export interface MeasurementInfo {
  /** The invariant ID this measurement applies to */
  invariantId: string;
  /** Type of measurement */
  type: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';
  /** Measured value (numeric for FLOOR/CEILING/RANGE, boolean for BOOLEAN) */
  value?: number | boolean;
  /** Whether the measurement passed */
  passed?: boolean;
  /** Context/explanation from the measurement */
  context?: string;
  /** ISO timestamp of when measurement was taken */
  timestamp?: string;
  /** Human-readable age (e.g., "2 hours ago") */
  age?: string;
}

/**
 * Structured context - factual state information (not instructions)
 *
 * This data is available for reference; context-aware assertions
 * embed specific values from this structure into actionable instructions.
 */
export interface BlueprintContext {
  /** Job hierarchy information */
  hierarchy?: HierarchyContext;

  /** Progress from prior runs in this workstream */
  progress?: ProgressContext;

  /** Available artifacts with CIDs */
  artifacts?: ArtifactInfo[];

  /** Latest measurements for invariants (used for prose rendering) */
  measurements?: MeasurementInfo[];

  /** Venture-level invariants (homeostatic goals from parent venture) */
  ventureInvariants?: VentureInvariant[];
}

// =============================================================================
// Unified Blueprint
// =============================================================================

/**
 * Metadata about how the blueprint was built
 */
export interface BlueprintMetadata {
  /** When the blueprint was generated */
  generatedAt: string;

  /** The request ID this blueprint is for */
  requestId: string;

  /** Which providers contributed to this blueprint */
  providers: string[];
}

/**
 * The unified blueprint sent to the agent
 *
 * This is the final output of the BlueprintBuilder - a single JSON structure
 * containing all invariants and reference data (context).
 */
export interface UnifiedBlueprint {
  /** Invariants - properties that should hold (homomorphic format) */
  invariants: Invariant[];

  /**
   * Human-readable prose rendering of invariants with measurement status.
   * Agents should prefer reading this over parsing the invariants array.
   */
  invariantsProse?: string;

  /** Factual state information (structured data) */
  context: BlueprintContext;

  /** Build metadata */
  metadata: BlueprintMetadata;
}

// =============================================================================
// Provider Types
// =============================================================================

/**
 * Configuration for the BlueprintBuilder
 */
export interface BlueprintBuilderConfig {
  // Assertion provider toggles
  /** Enable static system assertions from system-blueprint.json */
  enableSystemBlueprint: boolean;

  /** Enable dynamic context-aware assertions */
  enableContextAssertions: boolean;

  /** Enable prescriptive learnings from similar jobs */
  enableRecognitionLearnings: boolean;

  // Context provider toggles
  /** Enable job hierarchy context */
  enableJobContext: boolean;

  /** Enable progress checkpoint context */
  enableProgressCheckpoint: boolean;

  /** Enable beads issue tracking assertions for coding jobs */
  enableBeadsAssertions: boolean;

  /** Master switch for Recognition, Reflection, Progress phases */
  enableContextPhases: boolean;

  // Debugging
  /** Enable debug mode */
  debug: boolean;

  /** Log providers to console */
  logProviders: boolean;
}

/**
 * Context passed to providers during build
 */
export interface BuildContext {
  /** The request ID */
  requestId: string;

  /** IPFS metadata for this job */
  metadata: IpfsMetadata;

  /** Recognition phase result (if available) */
  recognition?: RecognitionPhaseResult | null;

  /** Builder configuration */
  config: BlueprintBuilderConfig;
}

/**
 * Context provider interface (Phase 1)
 *
 * Context providers run first and populate the BlueprintContext
 * with structured factual data.
 */
export interface ContextProvider {
  /** Provider name for logging/debugging */
  name: string;

  /** Check if this provider is enabled */
  enabled: (config: BlueprintBuilderConfig) => boolean;

  /** Provide context data */
  provide: (ctx: BuildContext) => Promise<Partial<BlueprintContext>>;
}

/**
 * Invariant provider interface (Phase 2)
 *
 * Invariant providers run second and have access to the built context.
 * They generate invariants - properties that should hold.
 * Layer ordering is derived from ID prefix in BlueprintBuilder.
 */
export interface InvariantProvider {
  /** Provider name for logging/debugging */
  name: string;

  /** Check if this provider is enabled */
  enabled: (config: BlueprintBuilderConfig) => boolean;

  /** Provide invariants (with access to built context) */
  provide: (
    ctx: BuildContext,
    builtContext: BlueprintContext
  ) => Promise<Invariant[]>;
}

// =============================================================================
// Build Result
// =============================================================================

/**
 * Result of building a blueprint
 */
export interface BlueprintBuildResult {
  /** The unified blueprint */
  blueprint: UnifiedBlueprint;

  /** Time taken to build (ms) */
  buildTime: number;
}
