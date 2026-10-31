// SPDX-License-Identifier: Apache-2.0

export { recordDigest } from "@jinn-network/trust-core";
export {
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
} from "./did-key.js";
export {
  createDidKeyDsseVerifier,
  verifyDsseSignatures,
  verifyEd25519Signature,
} from "./dsse.js";
export type { DsseVerificationKey, VerifyDsseSignaturesOptions } from "./dsse.js";
export {
  anchorCertificateReader,
  anchorChainVerifier,
  anchorSignatureVerifier,
  nodeCryptoAnchorPorts,
} from "./anchor/ports.js";
export { evaluateAnchors } from "./anchor/evaluate.js";
export type {
  AnchorProofContext,
  AnchorProofStatus,
  AnchorRefusal,
  AnchorSubject,
  AnchorSubjectReport,
  AnchorTrustMaterial,
  AnchorVerificationEntry,
  AnchorsReport,
  CarriedAnchorRecord,
  EvaluateAnchorsInput,
} from "./anchor/evaluate.js";
export { checkRecord } from "./check-record.js";
export type { CheckRecordOptions, RecordTrustOptions } from "./check-record.js";
export { checkRecordSet } from "./check-record-set.js";
export type {
  AnchorsResult,
  AttemptLifecycle,
  CheckRecordSetInput,
  LifecycleResult,
  RecordSetInputRecord,
  RecordSetReport,
  RecordSetSummary,
  RecordSetTrustOptions,
  ReferencesResult,
} from "./check-record-set.js";
export { KeysFileError, parseKeysFile } from "./keys-file.js";
export { loadPublishedDocuments } from "./published-documents.js";
export { OBSERVATION_KIND, defaultRecordKinds } from "./kinds/index.js";
export type { RecordAttribution, RecordKind, RecordKinds, RecordReference } from "./kinds/index.js";
export type { RecordView } from "./record-view.js";
export { UNKNOWN_KIND } from "./results.js";
export type {
  CheckId,
  CheckResult,
  CheckStatus,
  Finding,
  RecordCheckId,
  RecordOutcome,
  RecordReport,
  SetCheckId,
  SignatureCounts,
} from "./results.js";
