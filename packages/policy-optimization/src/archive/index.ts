// SPDX-License-Identifier: MIT

/**
 * The archive (product design §8.3) and adoption (§9) — sub-unit C7d.
 *
 * A derived local projection over candidate manifests, Reports, and projection rows: a
 * typed-parent lineage graph, a per-policy evaluated history, and the quality/cost/latency
 * non-dominated **set**. Re-derivable, never authoritative, never published as a ranking.
 *
 * Adoption rides alongside as locally recorded operator decisions — the one part that is *not*
 * re-derivable, labeled as such in the type, in the file, and in the directory layout.
 */

export * from "./tokens.js";
export type {
  AdoptionLog,
  AdoptionRecord,
  AdoptionScope,
  ArchiveProjection,
  EvaluatedHistory,
  FrontierDimension,
  FrontierDirection,
  FrontierEntry,
  LineageGraph,
  LineageNode,
  LineagePosition,
  PayloadClass,
} from "./types.js";
export { PAYLOAD_CLASSES, PRODUCT_FRONTIER_DIMENSIONS } from "./types.js";

export {
  lineageFromEntries,
  lineageGraph,
  lineagePosition,
  type LineageEntry,
} from "./lineage.js";
export { evaluatedHistory } from "./history.js";
export { frontier, frontierMembers } from "./frontier.js";
export {
  adopt,
  adoptionConfigFragment,
  currentAdoption,
  declaredPayloadClasses,
  emptyAdoptionLog,
  formatPayloadClasses,
  isPayloadClass,
  rollback,
  scopeKey,
  sortPayloadClasses,
  type AdoptInput,
} from "./adoption.js";
export {
  appendAdoptionRecord,
  archiveLayout,
  defaultArchiveRoot,
  deriveArchive,
  readAdoptionLog,
  readArchiveProjection,
  writeArchiveProjection,
  type ArchiveLayout,
  type DeriveArchiveInput,
} from "./store.js";
