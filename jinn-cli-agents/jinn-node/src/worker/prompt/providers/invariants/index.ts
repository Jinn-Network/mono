/**
 * Invariant Providers Index
 * 
 * Exports all invariant providers organized by domain.
 */

// Domain: system - Agent identity and behavior
export { SystemInvariantProvider, _clearSystemBlueprintCache } from './SystemInvariantProvider.js';

// Layer: job - What to achieve (finite objectives)
export { GoalInvariantProvider } from './JobInvariantProvider.js';

// Domain: learning - Historical patterns from similar jobs
export { LearningInvariantProvider } from './LearningInvariantProvider.js';

// Domain: coordination - Parent-child workflow, git operations
export { CoordinationInvariantProvider } from './CoordinationInvariantProvider.js';

// Domain: state - Context, prior work, progress
export { StateInvariantProvider } from './StateInvariantProvider.js';

// Domain: strategy - How to approach work (delegation)
export { StrategyInvariantProvider } from './StrategyInvariantProvider.js';

// Domain: recovery - Error handling, loop recovery
export { RecoveryInvariantProvider } from './RecoveryInvariantProvider.js';

// Domain: tooling - Tool-specific workflows (beads)
export { ToolingInvariantProvider } from './ToolingInvariantProvider.js';

// Domain: quality - Standards, verification, practices
export { QualityInvariantProvider } from './QualityInvariantProvider.js';

// Domain: system - Output schema requirements (from outputSpec)
export { OutputInvariantProvider } from './OutputInvariantProvider.js';

// Domain: cycle - Continuous/ongoing operation
export { CycleInvariantProvider } from './CycleInvariantProvider.js';
