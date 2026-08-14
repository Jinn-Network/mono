// Types
export { type Task, type RequestId, type TaskRequest, type TaskResult, type DeliveredResult } from './types/index.js';
export { TransientError, PermanentError } from './types/index.js';

// Adapters
export { type ExecutionAdapter } from './adapters/adapter.js';
export { LocalAdapter } from './adapters/local/adapter.js';
export { MechAdapter } from './adapters/mech/adapter.js';

// Runner
export { type Runner, type RunnerContext } from './runner/runner.js';
export { SimpleRunner } from './runner/simple.js';
export { ClaudeRunner } from './runner/claude.js';

// Daemon
export { Daemon, type DaemonConfig } from './daemon/daemon.js';

// Autopilot marketplace read-side verification
export {
  createAutopilotMarketplaceDeliveryObserver,
  type AutopilotExpectedCorrelationExtension,
  type AutopilotMarketplaceDeliveryContradictionReason,
  type AutopilotMarketplaceDeliveryExpectation,
  type AutopilotMarketplaceDeliveryObservation,
  type AutopilotMarketplaceDeliveryObserver,
  type AutopilotMarketplaceDeliveryObserverDeps,
  type AutopilotMarketplaceDeliveryPendingReason,
  type VerifiedAutopilotMarketplaceDelivery,
} from './autopilot/marketplace-delivery-observer.js';
export {
  createAutopilotGitHubAdoptionReceiptObserver,
  observeExactAutopilotAdoptionReceipt,
  type AutopilotGitHubReadPort,
  type GitHubIssueComment,
  type GitHubIssueCommentPage,
  type GitHubNativeReview,
  type GitHubNativeReviewPage,
  type GitHubNativeReviewState,
  type GitHubPullRequestFacts,
  type ObserveExactAutopilotAdoptionReceiptInput,
} from './autopilot/github-adoption-receipt-observer.js';
export {
  createJinnMonoGitHubAdoptionReadPort,
  type JinnMonoGitHubAdoptionReadOptions,
} from './autopilot/github-rest-adoption-read.js';
export {
  createAutopilotEvaluationContextResolver,
  type AutopilotEvaluationContextObservation,
  type AutopilotEvaluationContextResolver,
  type AutopilotEvaluationContextResolverInput,
  type AutopilotEvaluationContextValue,
} from './autopilot/autopilot-evaluation-context-resolver.js';
export {
  createPublisherSafeResolver,
  type PublisherSafeResolverOptions,
  type RegistryReadClient,
} from './erc8004/publisher-safe-resolver.js';

// Store
export { Store } from './store/store.js';

// Config
export { loadConfig, getConfigPathFromArgs, JinnConfigSchema, type JinnConfig } from './config.js';

// Operator-facing errors
export {
  formatBootstrapOperatorMessage,
  isJinnDebug,
} from './operator-errors.js';

// Earning
export { FleetBootstrapper, type FleetBootstrapperOptions } from './earning/bootstrap.js';
