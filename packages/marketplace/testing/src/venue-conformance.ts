// SPDX-License-Identifier: MIT

// The venue conformance kit (operator-daemon composition design §6.6). Subject-parameterized:
// this module imports nothing from `@jinn-network/marketplace-venue-base`, so the kit compiles
// and its fixtures are authoritative before the implementation exists.
export {
  VENUE_REVERT_FIXTURES,
  describeVenueRevertClassification,
} from "./venue-fixtures.js";
export type {
  VenueRevertClassification,
  VenueRevertClassifier,
  VenueRevertFixture,
} from "./venue-fixtures.js";
export { describeBroadcastProfileConformance } from "./venue-broadcast-conformance.js";
export type {
  BroadcastConformanceSubject,
  BroadcastLedgerEntry,
  BroadcastScenarioChain,
} from "./venue-broadcast-conformance.js";
export { describeLogSourceConformance } from "./venue-log-source-conformance.js";
export type {
  LogSourceConformanceSubject,
  LogSourceCursor,
  LogSourceScenarioChain,
} from "./venue-log-source-conformance.js";
export { anvilAvailable, describeForkVenueConformance, withForkVenue } from "./venue-fork.js";
export type { ForkVenueDeployment, ForkVenueSubject } from "./venue-fork.js";
export {
  CHUNK_PLAN_FIXTURES,
  LEGACY_BOUNDED_SCAN_RULES,
  LEGACY_CHUNK_CONSTANTS,
  LEGACY_UNCHUNKED_LOOKBACK_FLOOR_BLOCKS,
  PUBLIC_BASE_GETLOGS_RANGE_CAP_BLOCKS,
  describeChunkPlanConformance,
} from "./legacy-chunking-fixtures.js";
export type {
  ChunkPlanFixture,
  ChunkPlanSubject,
  ChunkRange,
  ChunkWidthConvention,
  LegacyBoundedScanRule,
  LegacyChunkConstant,
} from "./legacy-chunking-fixtures.js";
