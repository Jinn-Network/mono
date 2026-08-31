export { verifyPublicBundle, verifyPublicBundleSnapshot } from "./verify.js";
export type {
  PublicBundleVerificationCheck,
  PublicBundleVerificationResult,
  VerifiedPublicBundleSnapshot,
  VerifyPublicBundleDeps,
} from "./verify.js";
// Signer roles in reader terms. The verifier's human surface prints these; the identifiers they
// were derived from stay on the `--json` surface (issue #3024). The extractors themselves stay
// internal: each has an authenticated-bytes precondition its signature cannot express.
export type { PublicBundleSigner, PublicBundleSignerRole } from "./signers.js";
export { derivePublicComparison } from "./comparison.js";
export type {
  DerivePublicComparisonInput,
  PublicComparisonCell,
  PublicComparisonOutput,
  PublicComparisonTask,
  PublicComparisonVerdict,
  PublicComparisonView,
  PublicDescriptiveComparison,
} from "./comparison.js";
export { buildPublicAssets } from "./assets.js";
export type { PublicAssetInput } from "./assets.js";
// The three node:crypto ports the RFC 3161 anchor rule engine injects
// (anchor-evidence design §6.1 "Placement"). They live here, in the standalone
// verifier, and are reused by the product core -- which already depends on this
// package, so the split matches the real dependency direction.
export {
  anchorCertificateReader,
  anchorChainVerifier,
  anchorSignatureVerifier,
  nodeCryptoAnchorPorts,
} from "./anchor/ports.js";
// The `integrity-anchors` check (anchor-evidence design §8), shared by `bundle verify` and the
// workspace-side `run.verify` so the two cannot become two implementations.
export { evaluateIntegrityAnchors } from "./anchor/check.js";
export type {
  AnchorProofStatus,
  AnchorSubjectOutcome,
  AnchorSubjectReport,
  AnchorVerificationEntry,
  EvaluateIntegrityAnchorsInput,
  IntegrityAnchorsReport,
  PublicBundleAnchorTrustMaterial,
} from "./anchor/check.js";
export type {
  InspectRuntimeMethodDisclosure,
  InspectScoringProjectionDisclosure,
} from "./profile/inspect-disclosure.js";
// The anchored-closure projection (anchor-evidence design §7.4, §9.2). Single-sourced here rather
// than mirrored into the product core, so the producer's claim section and the verifier's rebuild
// of it cannot drift -- the byte-compare depends on them being one function.
export {
  ANCHORED_PRE_REGISTRATION,
  ANCHORED_TRUST_ROOT,
  ClaimAnchorProjectionError,
  ClaimAnchorSchema,
  SELF_RUN_TRUST_ROOT,
  STRUCTURAL_PRE_REGISTRATION,
  additionalLockAnchorLine,
  anchoredPreRegistration,
  anchoredPreRegistrationSentence,
  anchoredTrustRoot,
  anchoredVenueLimits,
  carriedMatrixAnchors,
  deriveClaimAnchors,
  governingLockAnchors,
  matrixAnchorLine,
} from "./profile/anchor-claims.js";
export type {
  CarriedAnchorRecord,
  ClaimAnchor,
  ClaimAnchorFacts,
  ClaimAnchorSubject,
  DeriveClaimAnchorsInput,
  OpenTimestampsClaimAnchorFacts,
  Rfc3161ClaimAnchorFacts,
} from "./profile/anchor-claims.js";
export {
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V5_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
  BUNDLE_V8_FORMAT,
  SUPPORTED_BUNDLE_FORMATS,
} from "./manifest.js";
// The disclosed-closure projection and check (disclosure-specification-record design §6.4/§6.6/§7,
// issue #2839). Single-sourced here for exactly the reason the anchored projection above is: the
// product core imports this package, so the producer's claim section and the verifier's rebuild of
// it are one function, and the byte-compare is a comparison of outputs rather than of guesses.
export {
  ClaimDisclosureSectionSchema,
  DISCLOSURE_ROLE_BINDING,
  DISCLOSURE_SPECIFICATION_BUNDLE_ROLE,
  DisclosureProjectionError,
  assertDisclosureSpecification,
  deriveDisclosureSpecification,
} from "./profile/disclosure.js";
export type {
  AssertDisclosureSpecificationInput,
  ClaimDisclosureSection,
  DisclosureSpecificationReport,
} from "./profile/disclosure.js";
export type { BundleManifest, VerifiedBundleSnapshot } from "./manifest.js";
export * from "./admission/index.js";
export * from "./schema.js";
export * from "./profile/binary-judge-manifest.js";
export * from "./profile/binary-qualification.js";
export { ClaimPackageSchema, DISCLOSED_CLAIM_PACKAGE_SCHEMA_ID } from "./profile/claim.js";
export type { ClaimPackage } from "./profile/claim.js";
export { firstDifference } from "./profile/claim-consistency.js";
export { NOT_FETCHED_CHECK, summarizeVerificationOutcome } from "./outcome.js";
export type {
  VerificationCheckOutcome,
  VerificationCheckState,
  VerificationOutcome,
} from "./outcome.js";
export { VERIFIER_VERSION, renderVerifiedBundle, runVerifierCli } from "./cli.js";
export type { VerifierCliDeps, VerifierCliResult } from "./cli.js";
export {
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V8_CHECKS,
  PUBLIC_BUNDLE_V8_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V8_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS,
  PUBLIC_BUNDLE_VERIFIER_MAJOR,
  PUBLIC_BUNDLE_V4_VERIFIER_MAJOR,
} from "./reader-instructions.js";
// `beacon-binding/1` (issue #2976): the post-seal public-randomness binding, and the report face
// that states which binding a run carries. Single-sourced here for the same reason the anchored
// projection is -- the product core imports this package, so producer and reader run one function.
export {
  BEACON_BINDING_PROCEDURE,
  BEACON_SOURCES,
  BEACON_SOURCE_IDS,
  MAX_BEACON_ROUND,
  BeaconReferenceSchema,
  RunBindingError,
  RunBindingSchema,
  beaconRoundInstant,
  computeBeaconOrder,
  verifyRunBinding,
} from "./binding/beacon-binding.js";
export type {
  BeaconOrderParams,
  BeaconOrderResult,
  BeaconPostSealBasis,
  BeaconReference,
  BeaconSourceDefinition,
  BeaconSourceId,
  BeaconSourceTimeBasis,
  RunBinding,
  VerifiedRunBinding,
} from "./binding/beacon-binding.js";
export { runBindingClass, runBindingSentence, runBoundVenueLimits } from "./binding/report-face.js";
export type { RunBindingClass } from "./binding/report-face.js";
