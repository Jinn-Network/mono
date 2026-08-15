// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

function fixtureUrl(relativePath: string): URL {
  return new URL(`../../fixtures/backend-local/${relativePath}`, import.meta.url);
}

async function readFixtureJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(fixtureUrl(relativePath), "utf8")) as T;
}

// --- the §6.4 reconciliation table as fixtures ---

export interface ReconciliationRowFixture {
  readonly name: string;
  readonly journalPhase: string;
  readonly reality: Readonly<Record<string, unknown>>;
  readonly classification: string;
  readonly action: string;
  readonly blame: "task" | "infrastructure" | null;
  readonly notes: string;
}

export interface ReconciliationTableFixture {
  readonly description: string;
  readonly rows: readonly ReconciliationRowFixture[];
}

export async function loadReconciliationTable(): Promise<ReconciliationTableFixture> {
  return readFixtureJson<ReconciliationTableFixture>("reconciliation-table.json");
}

// --- shim contract fixtures ---

export interface ShimContractScenario {
  readonly name: string;
  readonly description: string;
  readonly given: Readonly<Record<string, unknown>>;
  readonly expect: Readonly<Record<string, unknown>>;
}

export interface ShimContractFixture {
  readonly description: string;
  readonly scenarios: readonly ShimContractScenario[];
}

export async function loadShimContractFixture(): Promise<ShimContractFixture> {
  return readFixtureJson<ShimContractFixture>("shim-contract.json");
}

// --- launcher result-interpretation fixtures (design §8.2; data-only until Milestone B Task B3) ---

export interface ResultInterpretationScenario {
  readonly name: string;
  readonly validExitCodes: readonly number[];
  readonly exitCode: number | null;
  readonly termSignal: string | null;
  readonly envelope: Readonly<Record<string, unknown>> | null;
  readonly structuredOutput?: Readonly<Record<string, unknown>>;
  readonly outDirEntries?: readonly string[];
  readonly expected: Readonly<Record<string, unknown>>;
}

export interface ResultInterpretationFixture {
  readonly description: string;
  readonly scenarios: readonly ResultInterpretationScenario[];
}

export async function loadResultInterpretationFixture(): Promise<ResultInterpretationFixture> {
  return readFixtureJson<ResultInterpretationFixture>("result-interpretation.json");
}

// --- workspace fixtures ---

export interface WorkspaceScenario {
  readonly name: string;
  readonly description: string;
  readonly given?: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}

export interface WorkspaceFixture {
  readonly description: string;
  readonly scenarios: readonly WorkspaceScenario[];
}

export async function loadWorkspaceFixture(): Promise<WorkspaceFixture> {
  return readFixtureJson<WorkspaceFixture>("workspace.json");
}

// --- cancellation-race fixtures ---

export interface CancellationScenario {
  readonly name: string;
  readonly description: string;
  readonly given: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}

export interface CancellationFixture {
  readonly description: string;
  readonly scenarios: readonly CancellationScenario[];
}

export async function loadCancellationFixture(): Promise<CancellationFixture> {
  return readFixtureJson<CancellationFixture>("cancellation-races.json");
}

// --- evidence-join fixtures ---

export interface EvidenceJoinScenario {
  readonly name: string;
  readonly description: string;
  readonly given: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}

export interface EvidenceJoinFixture {
  readonly description: string;
  readonly scenarios: readonly EvidenceJoinScenario[];
}

export async function loadEvidenceJoinFixture(): Promise<EvidenceJoinFixture> {
  return readFixtureJson<EvidenceJoinFixture>("evidence-join.json");
}

// --- pinned-digest golden fixtures (Global Constraints, program §7.14) ---

export interface ExpectedDigestEntry {
  readonly name: string;
  readonly recordKind: string;
  readonly canonicalizationNote: string;
  readonly expectedDigest: `sha256:${string}`;
  readonly sourceRecord?: Readonly<Record<string, unknown>>;
  readonly source?: string;
}

export interface ExpectedDigestsFixture {
  readonly description: string;
  readonly entries: readonly ExpectedDigestEntry[];
}

export async function loadExpectedDigests(): Promise<ExpectedDigestsFixture> {
  return readFixtureJson<ExpectedDigestsFixture>("expected-digests.json");
}
