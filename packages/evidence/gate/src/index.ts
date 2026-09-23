// SPDX-License-Identifier: Apache-2.0

// Pinned identifiers — the one record kind a gate may produce.
export {
  DELIVERY_STATEMENT_RECORD_KIND,
  DELIVERY_STATEMENT_RECORD_MEDIA_TYPE,
  DELIVERY_STATEMENT_RECORD_SCHEMA_ID,
  DELIVERY_STATEMENT_TRUST_SCOPE,
} from "./identifiers.js";

// Refusals and configuration failures
export { GATE_REFUSAL_CODES, GateConfigurationError } from "./errors.js";
export type { GateRefusalCode, GateWarning } from "./errors.js";

// The rail adapter interface
export { assertConformingRailAdapter, RAIL_SETTLEMENTS, RAIL_TRUST_MODELS } from "./rail.js";
export type {
  ClaimOutcome,
  ClaimPaymentInput,
  GateChallenge,
  ObservePaymentInput,
  ObservedPayment,
  PayerControlInput,
  PayerControlOutcome,
  PaymentObservation,
  RailAdapter,
  RailDeliveryInput,
  RailDeliveryOutcome,
  RailOperationOptions,
  RailSelfDescription,
  RailSettlement,
  RailTrustModel,
} from "./rail.js";

// Ports, and the in-memory bindings a single-process holder can run as they are
export {
  createInMemoryChallengeStore,
  createInMemoryOfferSource,
  createInMemorySubjectSource,
  createRepositorySubjectSource,
  systemClock,
} from "./ports.js";
export type {
  ChallengeStore,
  Clock,
  GateOperationOptions,
  InMemoryChallengeStoreOptions,
  InMemoryOfferSource,
  InMemorySubjectSource,
  IssueChallengeInput,
  OfferSource,
  SubjectSource,
} from "./ports.js";

// The delivery statement
export {
  DeliveryStatementPaymentSchema,
  DeliveryStatementSchema,
  InvalidDeliveryStatementError,
  parseDeliveryStatementEnvelope,
  parseExactDeliveryStatementPayload,
  sealDeliveryStatement,
  sealDeliveryStatementPayload,
} from "./statement.js";
export type {
  DeliveryStatement,
  DeliveryStatementPayment,
  ParsedDeliveryStatement,
  SealDeliveryStatementInput,
  SealedDeliveryStatement,
  ValidationIssue,
} from "./statement.js";

// The gate
export { createRetrievalGate, DEFAULT_GATE_HARD_LIMITS } from "./gate.js";
export type {
  CreateRetrievalGateOptions,
  DeliveryStatementOptions,
  GateChallengeIssued,
  GateDelivery,
  GateHardLimits,
  GateOutcome,
  GatePayerProof,
  GateRefusal,
  GateRequest,
  GateRequestPayment,
  RetrievalGate,
} from "./gate.js";
