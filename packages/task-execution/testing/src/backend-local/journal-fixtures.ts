// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

/**
 * One journal event as a fixture carries (design §6.2's event shape, `{attemptId, seq, type,
 * time, displayMessage?, details{}, failsAttempt?}`) — this fixture type is a superset shape
 * (adds the fixture-only `torn`/`rawPartialBytes`/`reason` fields a torn-tail scenario uses to
 * describe an intentionally unparseable trailing record; a real journal never has these fields).
 * `type` is an open string here — the closed backend-internal event-type vocabulary
 * (`spawn-intended`, `spawned`, the TEP-projected types, …) is Task A5's decision (the journal
 * module, `supervisor/src/journal-types.ts`); this kit's fixtures document the vocabulary it
 * expects, not enforce it.
 */
export interface JournalEventFixture {
  readonly attemptId?: string;
  readonly seq?: number;
  readonly type?: string;
  readonly time?: string;
  readonly displayMessage?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly failsAttempt?: boolean;
  readonly rejectedAtAppend?: boolean;
  /** Fixture-only: marks a record as an intentionally torn/partial tail entry — never a real journal field. */
  readonly torn?: boolean;
  readonly rawPartialBytes?: string;
  readonly reason?: string;
}

export interface GoldenJournalFixture {
  readonly name: string;
  readonly description: string;
  readonly events: readonly JournalEventFixture[];
  readonly expected: Readonly<Record<string, unknown>>;
}

/** The submission-scoped log segment fixture shape (design §6.2). */
export interface SubmissionSegmentFixture {
  readonly name: string;
  readonly description: string;
  readonly submissionEvents: readonly {
    readonly submission: string;
    readonly seq: number;
    readonly type: "submission-accepted" | "submission-rejected" | "submission-closed";
    readonly time: string;
    readonly details: Readonly<Record<string, unknown>>;
  }[];
  readonly expected: Readonly<Record<string, unknown>>;
}

/** The rebuild-identity fixture shape — pins the deterministic (source,id) projection rule (TEP §10.1). */
export interface RebuildIdentityFixture extends GoldenJournalFixture {
  readonly expectedObservationIdentity: readonly {
    readonly sourceEventSeq: number;
    readonly expectedId: string;
  }[];
}

const GOLDEN_JOURNAL_NAMES = [
  "valid",
  "torn-tail",
  "contradictory-terminals",
  "duplicate-nonces",
  "dangling-intents",
  "seq-resumption",
] as const;
export type GoldenJournalName = (typeof GOLDEN_JOURNAL_NAMES)[number];
export { GOLDEN_JOURNAL_NAMES };

function fixtureUrl(relativePath: string): URL {
  return new URL(`../../fixtures/backend-local/${relativePath}`, import.meta.url);
}

async function readFixtureJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(fixtureUrl(relativePath), "utf8")) as T;
}

export async function loadGoldenJournal(name: GoldenJournalName): Promise<GoldenJournalFixture> {
  return readFixtureJson<GoldenJournalFixture>(`journals/${name}.json`);
}

export async function loadRebuildIdentityJournal(): Promise<RebuildIdentityFixture> {
  return readFixtureJson<RebuildIdentityFixture>("journals/rebuild-identity.json");
}

export async function loadSubmissionSegmentSurvival(): Promise<SubmissionSegmentFixture> {
  return readFixtureJson<SubmissionSegmentFixture>("journals/submission-segment-survival.json");
}

export async function loadAllGoldenJournals(): Promise<readonly GoldenJournalFixture[]> {
  return Promise.all(GOLDEN_JOURNAL_NAMES.map((name) => loadGoldenJournal(name)));
}
