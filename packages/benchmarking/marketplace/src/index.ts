export {
  marketplaceCloseBoundary,
  CloseBoundaryResolutionError,
} from "./close-boundary.js";
export type { CloseBoundaryPorts, FinalizedAnchorPort } from "./close-boundary.js";

export {
  assertCoherentCloseAnchor,
  cachedCloseBoundaryResolver,
  CloseAuthorityMismatchError,
  resolveCoherentCloseAuthority,
} from "./close-authority.js";
export type { CoherentCloseAuthority } from "./close-authority.js";

export {
  buildAnchoredOrderingTranscript,
  deriveEarliestCellPostAt,
  deriveRunDigestAnchorAt,
  enforceAnchoredOrderingGate,
  AnchoredOrderingViolationError,
} from "./ordering-leg-b.js";
export type { AnchoredOrderingTranscript } from "./ordering-leg-b.js";

export {
  validateMarketplaceBudget,
} from "./budget-validation.js";

export {
  MarketplaceCompositionValidationError,
  runOnMarketplace,
  validateMarketplaceComposition,
} from "./venue.js";
export type {
  MarketplaceProjectorPorts,
  RunOnMarketplaceOptions,
  RunOnMarketplaceResult,
} from "./venue.js";

export {
  projectorInputScope,
  deriveEligibleObservations,
  deriveEligibleProjection,
  isObservationEligible,
  isValidCloseAnchor,
} from "./input-scope.js";
export type {
  CloseAnchorRef,
  EligibleProjection,
  ProjectorCellJoinPort,
  ProjectorScopePorts,
} from "./input-scope.js";

export {
  deriveAuthorityProjection,
  indexAttemptCreations,
  indexAttemptObservations,
  indexAttemptTerminals,
  indexDeliveryPreparations,
  indexDeliveryObservations,
  indexSolutionSettlements,
  indexVerdictSettlements,
  isEventEligible,
  isEventAuthorityEligible,
} from "./authority-projection.js";
export type {
  AttemptCreationAuthority,
  AttemptObservationAuthority,
  AttemptTerminalAuthority,
  AuthorityProjection,
  DeliveryPreparationAuthority,
  DeliveryObservationAuthority,
  SolutionSettlementAuthority,
  VerdictSettlementAuthority,
} from "./authority-projection.js";

export {
  bytesMatchCanonicalSeal,
  decodeUtf8Json,
  isValidBlockHash,
} from "./canonical-bytes.js";

export {
  authorizeCellFromProjection,
  validateAuthorizedInScopeCell,
  selectAccountedAttempt,
  BENCHMARKING_CELL_EXTENSION,
} from "./cell-authority.js";
export type {
  ProjectorCellJoinCandidate,
  ProjectorCellEvidenceRef,
  SealedRecordMaterialPort,
  SealedSubmissionMaterialPort,
} from "./cell-authority.js";

export { deriveSettledFeeForCell } from "./settlement-authority.js";
export type { DerivedSettledFee } from "./settlement-authority.js";

export {
  settledCostSource,
  SettledCostValidationError,
  TODAY_SETTLEMENT_PAYMENT_ASSET,
  REVISED_SETTLEMENT_PAYMENT_ASSET,
} from "./cost.js";
export type { SettledCostPorts } from "./cost.js";

export {
  attestedPinningObservation,
  marketplaceAdmissionEvidence,
} from "./pinning-admission.js";

export { marketplaceAssemblyPorts } from "./assembly-ports.js";
export type {
  CoherentProjectorScopePorts,
  MarketplaceAssemblyPortsInput,
  StandaloneProjectorScopePorts,
} from "./assembly-ports.js";

export {
  CoherentProjectionResolverError,
  deriveAuthorityProjectionResolver,
  deriveAuthorityProjectionResolverFromEvents,
  freezeAuthorityProjection,
  memoizeAuthorityProjectionResolver,
} from "./projection-resolver.js";
export type { AuthorityProjectionResolver } from "./projection-resolver.js";
