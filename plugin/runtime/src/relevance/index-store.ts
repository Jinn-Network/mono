// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { openIndexDatabase, type IndexDatabaseIO } from "./database.js";
import { expandIdentifiers } from "./identifiers.js";
import type { EvidencePlane } from "./planes.js";
import { searchIndex, type RankedCandidate, type RelevanceQuery } from "./search.js";
import type { SensitivityClassifier } from "./sensitivity.js";

export type ExcerptLabel = "failure" | "fix" | "command" | "diff" | "note";

/** Per-record index budget — the bound a keyword-stuffer has to fit inside. */
export const MAX_SUMMARY_CHARS = 400;
export const MAX_INDEXED_EXCERPTS = 12;
export const MAX_EXCERPT_CHARS = 2_000;
export const MAX_BODY_CHARS = 8_000;

export interface IndexableExcerpt {
  readonly label: ExcerptLabel;
  /** The digest-bound artifact this text was read from — the attribution anchor. */
  readonly sourceEntityId: string;
  readonly sourceDigest: Sha256Digest;
  readonly text: string;
}

export interface IndexableRecord {
  readonly plane: EvidencePlane;
  readonly reference: EvidenceRecordReference;
  readonly summary: string;
  readonly origin: string;
  readonly capturedAt: string;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly excerpts: readonly IndexableExcerpt[];
}

/** Carries classes only. Never the matched text: a receipt is a thing that gets logged. */
export interface ExcludedExcerpt {
  readonly scope: "summary" | "excerpt";
  readonly label?: ExcerptLabel;
  readonly classes: readonly string[];
}

export interface IndexReceipt {
  readonly status: "indexed" | "excluded-record";
  readonly reference: EvidenceRecordReference;
  readonly indexedExcerpts: number;
  readonly excluded: readonly ExcludedExcerpt[];
}

export interface RelevanceIndexOptions {
  readonly databasePath: string;
  readonly classifier: SensitivityClassifier;
  /** Injected from the composition root (C6-P3); library code does not import `node:fs*`. */
  readonly indexIo: IndexDatabaseIO;
  readonly now?: () => string;
}

/**
 * What the doctor can honestly say about this component. Counts vary by install, which is
 * the whole point: an operator whose pickup keeps returning nothing needs to tell "the
 * index is empty" apart from "your query matched nothing".
 *
 * Both non-count fields are persisted rather than derived, and for the same reason: a
 * health check reads them long after the pass that produced them returned, and each one
 * distinguishes a *fault* from a *correct* empty state. `lastIndexedAt` separates "written
 * before, empty now" from "never written"; `excludedByTrust` separates "emptied by a trust
 * policy" (which a rebuild cannot repair) from "honestly empty".
 */
export interface IndexStats {
  readonly local: number;
  readonly public: number;
  readonly lastIndexedAt?: string;
  /** Records the last public-plane pass excluded by trust. 0 before any pass has run. */
  readonly excludedByTrust: number;
}

export interface RelevanceIndex {
  readonly databasePath: string;
  put(record: IndexableRecord): Promise<IndexReceipt>;
  remove(plane: EvidencePlane, reference: EvidenceRecordReference): void;
  has(plane: EvidencePlane, reference: EvidenceRecordReference): boolean;
  stats(): IndexStats;
  /** Called by the public-plane pass with what trust filtering excluded. */
  recordTrustExclusions(count: number): void;
  search(query: RelevanceQuery): Promise<readonly RankedCandidate[]>;
  close(): void;
}

function clampToLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  return lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
}

function toMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function openRelevanceIndex(
  options: RelevanceIndexOptions,
): Promise<RelevanceIndex> {
  const now = options.now ?? (() => new Date().toISOString());
  const opened = await openIndexDatabase({
    databasePath: options.databasePath,
    io: options.indexIo,
    now,
  });
  const database: Database.Database = opened.database;

  const selectId = database.prepare(
    "SELECT id FROM documents WHERE plane = ? AND family = ? AND digest = ?",
  );
  const deleteTerms = database.prepare("DELETE FROM document_terms WHERE rowid = ?");
  const deleteDocument = database.prepare("DELETE FROM documents WHERE id = ?");
  const insertDocument = database.prepare(
    `INSERT INTO documents(plane, family, digest, summary, origin, captured_at, captured_ms, outcome, excerpts_json, indexed_at)
     VALUES (@plane, @family, @digest, @summary, @origin, @capturedAt, @capturedMs, @outcome, @excerptsJson, @indexedAt)`,
  );
  const insertTerms = database.prepare(
    `INSERT INTO document_terms(rowid, summary, summary_idents, body, body_idents)
     VALUES (?, ?, ?, ?, ?)`,
  );
  /**
   * The high-water mark advances only on a successful write, and nothing ever clears it.
   * `remove` and an excluded record both leave it alone, which is what lets a reader tell
   * "written before, empty now" (a real fault) from "never written" (a fresh install).
   */
  const markIndexed = database.prepare(
    "UPDATE index_metadata SET last_indexed_at = ? WHERE singleton = 1",
  );
  const markTrustExclusions = database.prepare(
    "UPDATE index_metadata SET excluded_by_trust = ? WHERE singleton = 1",
  );

  const removeById = (id: number): void => {
    deleteTerms.run(id);
    deleteDocument.run(id);
  };

  const findId = (
    plane: EvidencePlane,
    reference: EvidenceRecordReference,
  ): number | undefined =>
    (selectId.get(plane, reference.family, reference.digest) as { id: number } | undefined)?.id;

  const write = database.transaction(
    (
      record: IndexableRecord,
      summary: string,
      excerpts: readonly IndexableExcerpt[],
      indexedAt: string,
    ): void => {
      const existing = findId(record.plane, record.reference);
      if (existing !== undefined) removeById(existing);
      const body = excerpts.map((excerpt) => excerpt.text).join("\n");
      const info = insertDocument.run({
        plane: record.plane,
        family: record.reference.family,
        digest: record.reference.digest,
        summary,
        origin: record.origin,
        capturedAt: record.capturedAt,
        capturedMs: toMillis(record.capturedAt),
        outcome: record.outcome,
        excerptsJson: JSON.stringify(excerpts),
        indexedAt,
      });
      insertTerms.run(
        Number(info.lastInsertRowid),
        summary,
        expandIdentifiers(summary),
        body,
        expandIdentifiers(body),
      );
      markIndexed.run(indexedAt);
    },
  );

  const evict = database.transaction(
    (plane: EvidencePlane, reference: EvidenceRecordReference): void => {
      const existing = findId(plane, reference);
      if (existing !== undefined) removeById(existing);
    },
  );

  const index: RelevanceIndex = {
    databasePath: opened.databasePath,

    async put(record: IndexableRecord): Promise<IndexReceipt> {
      const excluded: ExcludedExcerpt[] = [];

      const summary = clampToLineBoundary(record.summary.trim(), MAX_SUMMARY_CHARS);
      const summaryVerdict = await options.classifier.classify({
        text: summary,
        sourceEntityId: `${record.reference.digest}:summary`,
        role: "task",
      });
      if (summaryVerdict.excluded) {
        evict(record.plane, record.reference);
        return {
          status: "excluded-record",
          reference: record.reference,
          indexedExcerpts: 0,
          excluded: [{ scope: "summary", classes: summaryVerdict.classes }],
        };
      }

      const admitted: IndexableExcerpt[] = [];
      let bodyChars = 0;
      for (const excerpt of record.excerpts) {
        if (admitted.length >= MAX_INDEXED_EXCERPTS) break;
        if (bodyChars >= MAX_BODY_CHARS) break;
        const text = clampToLineBoundary(
          excerpt.text.trim(),
          Math.min(MAX_EXCERPT_CHARS, MAX_BODY_CHARS - bodyChars),
        );
        if (text.length === 0) continue;
        const verdict = await options.classifier.classify({
          text,
          sourceEntityId: excerpt.sourceEntityId,
          role: "native-trace",
        });
        if (verdict.excluded) {
          excluded.push({ scope: "excerpt", label: excerpt.label, classes: verdict.classes });
          continue;
        }
        admitted.push({ ...excerpt, text });
        bodyChars += text.length;
      }

      write(record, summary, admitted, now());
      return {
        status: "indexed",
        reference: record.reference,
        indexedExcerpts: admitted.length,
        excluded,
      };
    },

    remove(plane: EvidencePlane, reference: EvidenceRecordReference): void {
      evict(plane, reference);
    },

    has(plane: EvidencePlane, reference: EvidenceRecordReference): boolean {
      return findId(plane, reference) !== undefined;
    },

    stats(): IndexStats {
      const counts = database
        .prepare("SELECT plane, count(*) AS total FROM documents GROUP BY plane")
        .all() as { readonly plane: EvidencePlane; readonly total: number }[];
      const marker = database
        .prepare(
          `SELECT last_indexed_at AS lastIndexedAt, excluded_by_trust AS excludedByTrust
             FROM index_metadata WHERE singleton = 1`,
        )
        .get() as {
        readonly lastIndexedAt: string | null;
        readonly excludedByTrust: number;
      };
      return {
        local: counts.find((row) => row.plane === "local")?.total ?? 0,
        public: counts.find((row) => row.plane === "public")?.total ?? 0,
        excludedByTrust: marker.excludedByTrust,
        ...(marker.lastIndexedAt === null ? {} : { lastIndexedAt: marker.lastIndexedAt }),
      };
    },

    recordTrustExclusions(count: number): void {
      markTrustExclusions.run(Math.max(0, Math.trunc(count)));
    },

    async search(query: RelevanceQuery): Promise<readonly RankedCandidate[]> {
      return searchIndex(database, query);
    },

    close(): void {
      database.close();
    },
  };

  return index;
}
