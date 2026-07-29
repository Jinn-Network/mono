// @jinn-network/task-execution-testing/backend-local — the local execution backend's
// conformance kit slice (design §16, backend plan Task A3). The kit precedes the
// implementation: this subpath ships the deterministic fake launcher, the full §16 fixture
// families, and the four contract describe-functions BEFORE the supervisor/workspace/launchers/
// assembly internals exist. Production dependency on the four backend-local component packages
// (program §7.5/Finding (a)); each component consumes this package back only as a
// devDependency — no production cycle.

// --- the deterministic fake launcher (SimpleRunner reborn as a contract fixture) ---
export { makeFakeLauncher } from "./fake-launcher.js";
export type { FakeLaunchOutcome, FakeLaunchScript } from "./fake-launcher.js";

// --- the four contract describe-functions ---
export {
  assertPlanDeterministic,
  assertPlanHermetic,
  assertPlanStateless,
  assertSecretEnvAreReferences,
  describeLauncherContract,
  makeSampleLauncherInputs,
} from "./launcher-contract.js";
export { describeAttemptSupervisorContract } from "./supervisor-contract.js";
export type { AttemptSupervisorUnderTest } from "./supervisor-contract.js";
export { describeWorkspaceContract } from "./workspace-contract.js";
export type {
  WorkspaceContractSubject,
  WorkspaceScenarioOptions,
} from "./workspace-contract.js";
export { describeLocalBackendContract } from "./backend-contract.js";
export type {
  LocalBackendConformanceSubject,
  LocalBackendContractFactory,
} from "./backend-contract.js";

// --- fixture loaders + types ---
export {
  GOLDEN_JOURNAL_NAMES,
  loadAllGoldenJournals,
  loadGoldenJournal,
  loadRebuildIdentityJournal,
  loadSubmissionSegmentSurvival,
} from "./journal-fixtures.js";
export type {
  GoldenJournalFixture,
  GoldenJournalName,
  JournalEventFixture,
  RebuildIdentityFixture,
  SubmissionSegmentFixture,
} from "./journal-fixtures.js";

export {
  loadCancellationFixture,
  loadEvidenceJoinFixture,
  loadExpectedDigests,
  loadReconciliationTable,
  loadResultInterpretationFixture,
  loadShimContractFixture,
  loadWorkspaceFixture,
} from "./fixtures.js";
export type {
  CancellationFixture,
  CancellationScenario,
  EvidenceJoinFixture,
  EvidenceJoinScenario,
  ExpectedDigestEntry,
  ExpectedDigestsFixture,
  ReconciliationRowFixture,
  ReconciliationTableFixture,
  ResultInterpretationFixture,
  ResultInterpretationScenario,
  ShimContractFixture,
  ShimContractScenario,
  WorkspaceFixture,
  WorkspaceScenario,
} from "./fixtures.js";

// --- test-infra canonicalization for pinning fixture digests (not a tree sealing implementation) ---
export { compareCodeUnitStrings, serializeCanonicalFixture } from "./canonical.js";
