// SPDX-License-Identifier: Apache-2.0

export { ScenarioError } from "./errors.js";
export type { ScenarioErrorCategory } from "./errors.js";
export { compareCodeUnitStrings } from "./order.js";
export { canonicalJsonBytes, serializeCanonicalJson } from "./canonical.js";
export type { CanonicalJsonValue } from "./canonical.js";
export {
  assertBareHex,
  assertPrefixedDigest,
  digestsEqual,
  documentDigest,
  sha256Hex,
  toBareHex,
} from "./digest.js";
export type { Sha256Digest } from "./digest.js";
export {
  WELL_KNOWN_DEV_ADDRESSES,
  assertFreshFixtureAddress,
  createFixtureAddressLedger,
  normalizeAddress,
} from "./fixture-accounts.js";
export type {
  FixtureAddressLedger,
  ScenarioAccount,
  ScenarioAccountPort,
  ScenarioAccountRequest,
} from "./fixture-accounts.js";
export {
  CHAIN_REFERENCE_SCRIPT_MEDIA_TYPE,
  CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION,
  CHAIN_SOLUTION_MEDIA_TYPE,
  CHAIN_SOLUTION_SCHEMA_VERSION,
  ChainSolutionScriptSchema,
  ReferenceScriptSchema,
  assertScriptWithinEnvelope,
  referenceScriptDigest,
  sealReferenceScript,
  sealSolutionScript,
} from "./solution-script.js";
export type {
  CapabilityEnvelope,
  ChainSolutionScript,
  ReferenceScript,
  SealedScriptDocument,
} from "./solution-script.js";
export {
  addressForbidden,
  approvalConstraint,
  budget,
  callResult,
  erc20Balance,
  eventEmitted,
  eventForbidden,
  eventSignatureTopic0,
  nativeBalance,
  predicateId,
  reportedValue,
  timeBound,
  txOutcome,
} from "./predicates.js";
export type { ScenarioPredicate } from "./predicates.js";
export {
  assertCandidateHardened,
  assertTemplateHardened,
} from "./hardening.js";
export {
  CHAIN_SCENARIO_ENVELOPE_VIOLATION_CLASS,
  CHAIN_SCENARIO_MISSING_SOLUTION_SCRIPT_CLASS,
  CHAIN_SCENARIO_REPLAY_INFRASTRUCTURE_CLASS,
  CHAIN_WORK_PROFILE_URI,
  buildChainWorkProfile,
  buildScenarioEvaluationSpec,
  buildSealedScenarioPair,
  buildSealedScenarioTask,
} from "./seal-pair.js";
export type {
  SealedEvaluationSpec,
  SealedScenarioPair,
  SealedScenarioTask,
} from "./seal-pair.js";
export {
  computeScenarioCommitment,
  parameterDigest,
  parameterize,
  PROMPT_INJECTION_SENTENCE,
  SCENARIO_COMMITMENT_RULE,
} from "./parameterize.js";
export type { ParameterizeDeps } from "./parameterize.js";
export {
  buildProbeRoleAddresses,
  resolveRoleAddress,
  syntheticProbeAddress,
} from "./template.js";
export type {
  ChainDerivationEnvironment,
  ChainScenarioCandidate,
  EnvironmentCompatibility,
  HardeningChecklist,
  ScenarioEnvelopeTightenings,
  ScenarioLineage,
  ScenarioStatePredicateBlock,
  ScenarioTemplate,
  StatePredicateDraft,
} from "./template.js";
export {
  CHAIN_SCENARIO_STRATEGY_ID,
  chainScenarioStrategy,
  loadChainDerivationEnvironment,
} from "./strategy.js";
export type { ChainScenarioInputs } from "./strategy.js";
export { runChainScenarioDerivation } from "./run.js";
export type {
  ChainAdmissionPort,
  ChainAdmissionRequest,
  ChainDerivationDeps,
  ChainPoolWriteSummary,
  FailedCandidate,
  RefusedCandidate,
  WrittenPair,
} from "./run.js";
