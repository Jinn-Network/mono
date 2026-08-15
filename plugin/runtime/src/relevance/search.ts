// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { ftsColumnQuery, isSearchableTerm } from "./identifiers.js";
import type { ExcerptLabel } from "./index-store.js";
import { compareCodeUnitStrings } from "./order.js";
import { comparePlanes, PLANES, type EvidencePlane } from "./planes.js";

/** Two distinct discriminating terms. Below it, "nothing relevant found" is the answer. */
export const RELEVANCE_FLOOR = 2;
export const DEFAULT_SEARCH_LIMIT = 20;
/** The summary is the record's own declared task statement, capped at index time. */
export const SUMMARY_TERM_WEIGHT = 3;
export const BODY_TERM_WEIGHT = 1;

const SUMMARY_COLUMNS = ["summary", "summary_idents"] as const;
const BODY_COLUMNS = ["body", "body_idents"] as const;

export interface RelevanceQuery {
  /** Already discriminating: the caller drops the repository-name term before scoring. */
  readonly terms: readonly string[];
  readonly planes?: readonly EvidencePlane[];
  readonly limit?: number;
  readonly floor?: number;
}

export interface ProjectableExcerpt {
  readonly label: ExcerptLabel;
  readonly sourceEntityId: string;
  readonly sourceDigest: Sha256Digest;
  readonly text: string;
}

export interface RankedCandidate {
  readonly plane: EvidencePlane;
  readonly reference: EvidenceRecordReference;
  /** Ordering key: 3 × summary matches + 1 × body-only matches. */
  readonly score: number;
  /** Floor key: distinct discriminating terms matched anywhere. */
  readonly coverage: number;
  readonly matchedTerms: readonly string[];
  readonly summary: string;
  readonly origin: string;
  readonly capturedAt: string;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly excerpts: readonly ProjectableExcerpt[];
}

interface DocumentRow {
  readonly id: number;
  readonly plane: EvidencePlane;
  readonly family: EvidenceRecordReference["family"];
  readonly digest: Sha256Digest;
  readonly summary: string;
  readonly origin: string;
  readonly captured_at: string;
  readonly captured_ms: number;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly excerpts_json: string;
}

interface Accumulator {
  readonly summaryTerms: Set<string>;
  readonly bodyTerms: Set<string>;
}

/**
 * Recall from FTS5, scoring in TypeScript. One column-scoped MATCH per term per scope, so
 * a term contributes at most once no matter how often it occurs — the property `bm25()`
 * does not give and the one an adversary cannot buy with repetition.
 */
export async function searchIndex(
  database: Database.Database,
  query: RelevanceQuery,
): Promise<readonly RankedCandidate[]> {
  const terms = [...new Set(query.terms)].filter(isSearchableTerm);
  if (terms.length === 0) return [];

  const planes = query.planes && query.planes.length > 0 ? [...query.planes] : [...PLANES];
  const floor = query.floor ?? RELEVANCE_FLOOR;
  const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
  const planePlaceholders = planes.map(() => "?").join(", ");

  const matchStatement = database.prepare(
    `SELECT documents.id AS id
       FROM documents
       JOIN document_terms ON document_terms.rowid = documents.id
      WHERE document_terms MATCH ?
        AND documents.plane IN (${planePlaceholders})`,
  );

  const accumulators = new Map<number, Accumulator>();
  const accumulate = (id: number, term: string, scope: "summary" | "body"): void => {
    let accumulator = accumulators.get(id);
    if (accumulator === undefined) {
      accumulator = { summaryTerms: new Set(), bodyTerms: new Set() };
      accumulators.set(id, accumulator);
    }
    (scope === "summary" ? accumulator.summaryTerms : accumulator.bodyTerms).add(term);
  };

  for (const term of terms) {
    for (const [scope, columns] of [
      ["summary", SUMMARY_COLUMNS],
      ["body", BODY_COLUMNS],
    ] as const) {
      const rows = matchStatement.all(ftsColumnQuery([...columns], term), ...planes) as {
        readonly id: number;
      }[];
      for (const row of rows) accumulate(row.id, term, scope);
    }
  }

  if (accumulators.size === 0) return [];

  const documentStatement = database.prepare("SELECT * FROM documents WHERE id = ?");
  const candidates: RankedCandidate[] = [];

  for (const [id, accumulator] of accumulators) {
    const matched = new Set<string>([...accumulator.summaryTerms, ...accumulator.bodyTerms]);
    if (matched.size < floor) continue;
    const row = documentStatement.get(id) as DocumentRow | undefined;
    if (row === undefined) continue;
    const bodyOnly = [...accumulator.bodyTerms].filter(
      (term) => !accumulator.summaryTerms.has(term),
    ).length;
    candidates.push({
      plane: row.plane,
      reference: { family: row.family, digest: row.digest },
      score: accumulator.summaryTerms.size * SUMMARY_TERM_WEIGHT + bodyOnly * BODY_TERM_WEIGHT,
      coverage: matched.size,
      matchedTerms: terms.filter((term) => matched.has(term)),
      summary: row.summary,
      origin: row.origin,
      capturedAt: row.captured_at,
      outcome: row.outcome,
      excerpts: JSON.parse(row.excerpts_json) as ProjectableExcerpt[],
    });
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const plane = comparePlanes(left.plane, right.plane);
    if (plane !== 0) return plane;
    const leftMs = Date.parse(left.capturedAt);
    const rightMs = Date.parse(right.capturedAt);
    if (rightMs !== leftMs) return rightMs - leftMs;
    return compareCodeUnitStrings(left.reference.digest, right.reference.digest);
  });

  return candidates.slice(0, limit);
}
