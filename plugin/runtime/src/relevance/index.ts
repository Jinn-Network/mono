// SPDX-License-Identifier: Apache-2.0
// Directory barrel. In-package consumers (the MCP tool modules) import from here by
// relative path; the package's own `src/index.ts` re-exports the public subset.

export { PLANES, comparePlanes } from "./planes.js";
export type { EvidencePlane } from "./planes.js";
export { compareCodeUnitStrings } from "./order.js";
export {
  STOPWORDS,
  deriveRepositorySearchTerms,
  deriveSearchTerms,
  discriminatingTerms,
} from "./terms.js";
export { expandIdentifiers, ftsColumnQuery, ftsPhrase, isSearchableTerm } from "./identifiers.js";
export {
  MAX_BODY_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_INDEXED_EXCERPTS,
  MAX_SUMMARY_CHARS,
  openRelevanceIndex,
} from "./index-store.js";
export type {
  ExcerptLabel,
  ExcludedExcerpt,
  IndexReceipt,
  IndexStats,
  IndexableExcerpt,
  IndexableRecord,
  RelevanceIndex,
  RelevanceIndexOptions,
} from "./index-store.js";
export {
  BODY_TERM_WEIGHT,
  DEFAULT_SEARCH_LIMIT,
  RELEVANCE_FLOOR,
  SUMMARY_TERM_WEIGHT,
} from "./search.js";
export type { ProjectableExcerpt, RankedCandidate, RelevanceQuery } from "./search.js";
export {
  DETECTOR_FAILURE_CLASS,
  EXCLUDING_BANDS,
  SENSITIVE_CLASSES,
  createSensitivityClassifier,
} from "./sensitivity.js";
export type {
  ClassifyInput,
  SensitivityClassifier,
  SensitivityClassifierOptions,
  SensitivityVerdict,
} from "./sensitivity.js";
export { createTraceSpanSource } from "./trace-decode-adapter.js";
export type { TraceSpanRequest, TraceSpanSource } from "./trace-decode-adapter.js";
export {
  indexLocalPlane,
  indexLocalRecord,
  indexPublicPlane,
  rebuildIndex,
} from "./indexing.js";
export type { IndexingDeps, IndexingReport } from "./indexing.js";
