// SPDX-License-Identifier: MIT

import { canonicalJsonBytes, prefixedDigest, type JsonValue } from "@jinn-network/policy-identity";
import { Rfc3339 } from "@jinn-network/task-execution-protocol";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HostStateError, secureAtomicWrite, secureRead, withHostAdvisoryLock } from "./state.js";

export const LIVE_HOST_JOURNAL_FORMAT_TOKEN =
  "network.jinn.policy-optimization.live-host-journal-entry/1.0" as const;

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const NonEmpty = z.string().min(1);
const Role = z.enum(["solver", "evaluator"]);
const Coordinate = z.strictObject({
  runDigest: Digest,
  cellKey: NonEmpty,
  armId: NonEmpty,
  dispatch: z.number().int().positive(),
});
const RunPayload = z.strictObject({
  runDigest: Digest,
  kind: z.enum(["training", "development", "promotion"]),
  arms: z.array(z.strictObject({ armId: NonEmpty, tupleDigest: Digest })).min(1),
});
const PayloadSchemas = {
  "plan-recorded": z.strictObject({ planDigest: Digest, splitManifestDigest: Digest }),
  "run-recorded": RunPayload,
  "challenger-frozen": z.strictObject({ challengerTupleDigest: Digest, developmentRunDigest: Digest }),
  "promotion-revealed": z.strictObject({ promotionRunDigest: Digest, splitManifestDigest: Digest }),
  "submission-prepared": Coordinate.extend({ role: Role, bindingDigest: Digest }),
  "submission-accepted": Coordinate.extend({
    role: Role,
    bindingDigest: Digest,
    submission: NonEmpty,
    attempt: NonEmpty,
  }),
  "solver-delivery-recorded": Coordinate.extend({ attempt: NonEmpty, deliveryDigest: Digest }),
  "evaluation-prepared": Coordinate.extend({
    solverDeliveryDigest: Digest,
    evaluationTaskDigest: Digest,
    evaluationSubmissionDigest: Digest,
    bindingDigest: Digest,
  }),
  "evaluation-result-recorded": Coordinate.extend({
    attempt: NonEmpty,
    resultDigest: Digest,
    verdict: z.enum(["pass", "fail", "unscorable"]),
  }),
  "attempt-terminal-recorded": Coordinate.extend({
    role: Role,
    attempt: NonEmpty,
    state: z.enum(["delivered", "failed", "cancelled", "expired", "lost", "rejected"]),
    evidenceDigest: Digest,
  }),
  "matrix-recorded": z.strictObject({ runDigest: Digest, matrixDigest: Digest, gatesResolved: z.boolean() }),
  "report-recorded": z.strictObject({ runDigest: Digest, matrixDigest: Digest, reportDigest: Digest }),
  "recommendation-recorded": z.strictObject({
    promotionRunDigest: Digest,
    matrixDigest: Digest,
    decisionDigest: Digest,
  }),
  "cancellation-requested": z.strictObject({ reasonCode: NonEmpty }),
  "closed": z.strictObject({ reasonCode: NonEmpty }),
  "late-terminal-recorded": z.strictObject({
    role: Role,
    attempt: NonEmpty,
    evidenceDigest: Digest,
    terminalState: NonEmpty,
  }),
} as const;

export type LiveHostEventType = keyof typeof PayloadSchemas;
export type LiveHostPayload<T extends LiveHostEventType> = z.infer<(typeof PayloadSchemas)[T]>;

export interface LiveHostJournalEntry<T extends LiveHostEventType = LiveHostEventType> {
  readonly formatToken: typeof LIVE_HOST_JOURNAL_FORMAT_TOKEN;
  readonly campaign: string;
  readonly author: string;
  readonly seq: number;
  readonly previous: string | null;
  readonly recordedAt: string;
  readonly type: T;
  readonly payload: LiveHostPayload<T>;
}

export interface LiveHostEventInput<T extends LiveHostEventType = LiveHostEventType> {
  readonly recordedAt: string;
  readonly type: T;
  readonly payload: LiveHostPayload<T>;
}

const EntryEnvelope = z.strictObject({
  formatToken: z.literal(LIVE_HOST_JOURNAL_FORMAT_TOKEN),
  campaign: Digest,
  author: NonEmpty,
  seq: z.number().int().positive(),
  previous: Digest.nullable(),
  recordedAt: Rfc3339,
  type: z.string(),
  payload: z.unknown(),
});

export interface LiveHostJournalState {
  readonly phase: "EMPTY" | "ACTIVE" | "CANCELLING" | "CLOSED";
  readonly entries: number;
  readonly head: string | null;
  readonly planDigest?: string;
  readonly splitManifestDigest?: string;
  readonly runs: ReadonlyMap<string, { kind: "training" | "development" | "promotion"; arms: readonly string[] }>;
  readonly armTuples: ReadonlyMap<string, string>;
  readonly matrices: ReadonlyMap<string, { digest: string; gatesResolved: boolean }>;
  readonly reports: ReadonlyMap<string, ReadonlySet<string>>;
  readonly activeAttempts: ReadonlyMap<string, {
    role: "solver" | "evaluator";
    runDigest: string;
    cellKey: string;
    armId: string;
    dispatch: number;
  }>;
  readonly preparedBindings: ReadonlySet<string>;
  readonly acceptedBindings: ReadonlyMap<string, {
    readonly attempt: string;
    readonly submission: string;
    readonly role: "solver" | "evaluator";
  }>;
  readonly evaluationPreparedBindings: ReadonlySet<string>;
  readonly promotionRunDigest?: string;
  readonly challengerTupleDigest?: string;
  readonly promotionConsumed: boolean;
  readonly recommendationDigest?: string;
  readonly lateEvidence: readonly string[];
}

function emptyState(): LiveHostJournalState {
  return {
    phase: "EMPTY",
    entries: 0,
    head: null,
    runs: new Map(),
    armTuples: new Map(),
    matrices: new Map(),
    reports: new Map(),
    activeAttempts: new Map(),
    preparedBindings: new Set(),
    acceptedBindings: new Map(),
    evaluationPreparedBindings: new Set(),
    promotionConsumed: false,
    lateEvidence: [],
  };
}

function fail(detail: string): never {
  throw new HostStateError("state-io", `live host journal refusal: ${detail}`);
}

function parseEntry(line: string): LiveHostJournalEntry {
  let value: unknown;
  try { value = JSON.parse(line); } catch { fail("entry is not JSON"); }
  const envelope = EntryEnvelope.safeParse(value);
  if (!envelope.success) fail("entry envelope is invalid");
  const schema = PayloadSchemas[envelope.data.type as LiveHostEventType];
  if (schema === undefined) fail("event type is unknown");
  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success) fail(`${envelope.data.type} payload is invalid`);
  const parsed = { ...envelope.data, type: envelope.data.type as LiveHostEventType, payload: payload.data };
  const canonical = new TextDecoder().decode(canonicalJsonBytes(parsed as JsonValue));
  if (canonical !== line) fail("entry is not exact canonical JSON");
  return parsed as LiveHostJournalEntry;
}

function eventDigest(entry: LiveHostJournalEntry): string {
  return prefixedDigest(canonicalJsonBytes(entry as unknown as JsonValue));
}

function mutable(state: LiveHostJournalState) {
  return {
    ...state,
    runs: new Map(state.runs),
    armTuples: new Map(state.armTuples),
    matrices: new Map(state.matrices),
    reports: new Map([...state.reports].map(([run, reports]) => [run, new Set(reports)])),
    activeAttempts: new Map(state.activeAttempts),
    preparedBindings: new Set(state.preparedBindings),
    acceptedBindings: new Map(state.acceptedBindings),
    evaluationPreparedBindings: new Set(state.evaluationPreparedBindings),
    lateEvidence: [...state.lateEvidence],
  };
}

function assertCoordinate(state: LiveHostJournalState, payload: z.infer<typeof Coordinate>): void {
  const run = state.runs.get(payload.runDigest);
  if (run === undefined) fail("dispatch names an unknown Run");
  if (!run.arms.includes(payload.armId)) fail("dispatch arm identity is not frozen in the Run");
  if (!payload.cellKey.includes(`/${payload.armId}/`)) fail("cellKey contradicts its arm identity");
}

/** Relational reducer: legality comes from the whole durable history, never one record alone. */
export function reduceLiveHostEntry(
  current: LiveHostJournalState,
  entry: LiveHostJournalEntry,
): LiveHostJournalState {
  if (entry.seq !== current.entries + 1 || entry.previous !== current.head) {
    fail("sequence or previous digest does not extend the journal head");
  }
  if (current.phase === "CLOSED" && entry.type !== "late-terminal-recorded") {
    fail("a closed campaign admits only late terminal evidence");
  }
  const state = mutable(current);
  const payload = entry.payload as Record<string, unknown>;
  switch (entry.type) {
    case "plan-recorded": {
      if (state.phase !== "EMPTY") fail("the plan must be the first relational record");
      state.phase = "ACTIVE";
      state.planDigest = payload["planDigest"] as string;
      state.splitManifestDigest = payload["splitManifestDigest"] as string;
      break;
    }
    case "run-recorded": {
      if (state.phase !== "ACTIVE" || state.planDigest === undefined) fail("Run requires an active plan");
      const run = entry.payload as LiveHostPayload<"run-recorded">;
      if (state.runs.has(run.runDigest)) fail("a sealed Run is recorded once");
      if (run.kind === "promotion") {
        if (state.promotionRunDigest !== undefined) fail("exactly one promotion Run is permitted");
        if (state.challengerTupleDigest === undefined) fail("promotion Run requires a frozen challenger");
        state.promotionRunDigest = run.runDigest;
      }
      for (const arm of run.arms) {
        const prior = state.armTuples.get(arm.armId);
        if (prior !== undefined && prior !== arm.tupleDigest) fail("an armId cannot move to another tuple");
        state.armTuples.set(arm.armId, arm.tupleDigest);
      }
      state.runs.set(run.runDigest, { kind: run.kind, arms: run.arms.map((arm) => arm.armId) });
      break;
    }
    case "challenger-frozen": {
      const frozen = entry.payload as LiveHostPayload<"challenger-frozen">;
      const development = state.runs.get(frozen.developmentRunDigest);
      if (development?.kind !== "development" || !state.matrices.has(frozen.developmentRunDigest)
        || (state.reports.get(frozen.developmentRunDigest)?.size ?? 0) === 0) {
        fail("challenger selection requires a completed development Matrix and Report");
      }
      if (state.challengerTupleDigest !== undefined || state.promotionConsumed) fail("challenger is already frozen");
      if (![...state.armTuples.values()].includes(frozen.challengerTupleDigest)) fail("challenger tuple is not a development arm");
      state.challengerTupleDigest = frozen.challengerTupleDigest;
      break;
    }
    case "promotion-revealed": {
      const revealed = entry.payload as LiveHostPayload<"promotion-revealed">;
      if (state.promotionRunDigest !== revealed.promotionRunDigest
        || state.splitManifestDigest !== revealed.splitManifestDigest
        || state.challengerTupleDigest === undefined) fail("promotion reveal does not bind the frozen campaign");
      if (state.promotionConsumed) fail("promotion groups are consumed on first reveal or dispatch");
      state.promotionConsumed = true;
      break;
    }
    case "submission-prepared": {
      if (state.phase !== "ACTIVE") fail("new dispatch is forbidden while cancelling or closed");
      const prepared = entry.payload as LiveHostPayload<"submission-prepared">;
      assertCoordinate(state, prepared);
      if (state.runs.get(prepared.runDigest)?.kind === "promotion" && !state.promotionConsumed) {
        // First promotion dispatch is itself a reveal and therefore permanently consumes the gate.
        state.promotionConsumed = true;
      }
      if (state.preparedBindings.has(prepared.bindingDigest)) fail("prepared binding is already recorded");
      state.preparedBindings.add(prepared.bindingDigest);
      break;
    }
    case "submission-accepted": {
      const accepted = entry.payload as LiveHostPayload<"submission-accepted">;
      assertCoordinate(state, accepted);
      if (!state.preparedBindings.has(accepted.bindingDigest)) fail("acceptance requires a durable prepared Submission");
      const priorAcceptance = state.acceptedBindings.get(accepted.bindingDigest);
      if (priorAcceptance !== undefined) {
        if (priorAcceptance.attempt !== accepted.attempt
          || priorAcceptance.submission !== accepted.submission
          || priorAcceptance.role !== accepted.role) {
          fail("one prepared binding cannot be accepted under another attempt or role");
        }
        fail("acceptance is recorded once");
      }
      if (state.activeAttempts.has(accepted.attempt)) fail("attempt identity is already active");
      state.acceptedBindings.set(accepted.bindingDigest, {
        attempt: accepted.attempt,
        submission: accepted.submission,
        role: accepted.role,
      });
      state.activeAttempts.set(accepted.attempt, {
        role: accepted.role,
        runDigest: accepted.runDigest,
        cellKey: accepted.cellKey,
        armId: accepted.armId,
        dispatch: accepted.dispatch,
      });
      break;
    }
    case "solver-delivery-recorded": {
      assertCoordinate(state, entry.payload as LiveHostPayload<"solver-delivery-recorded">);
      break;
    }
    case "evaluation-prepared": {
      const prepared = entry.payload as LiveHostPayload<"evaluation-prepared">;
      assertCoordinate(state, prepared);
      if (!state.preparedBindings.has(prepared.bindingDigest)) fail("evaluation requires a durable prepared Submission");
      if (state.evaluationPreparedBindings.has(prepared.bindingDigest)) fail("evaluation preparation is recorded once");
      state.evaluationPreparedBindings.add(prepared.bindingDigest);
      break;
    }
    case "evaluation-result-recorded": {
      assertCoordinate(state, entry.payload as LiveHostPayload<"evaluation-result-recorded">);
      break;
    }
    case "attempt-terminal-recorded": {
      const terminal = entry.payload as LiveHostPayload<"attempt-terminal-recorded">;
      assertCoordinate(state, terminal);
      const active = state.activeAttempts.get(terminal.attempt);
      if (active === undefined || active.role !== terminal.role
        || active.runDigest !== terminal.runDigest || active.cellKey !== terminal.cellKey) {
        fail("terminal does not match an active role-scoped attempt");
      }
      state.activeAttempts.delete(terminal.attempt);
      break;
    }
    case "matrix-recorded": {
      const matrix = entry.payload as LiveHostPayload<"matrix-recorded">;
      if (!state.runs.has(matrix.runDigest)) fail("Matrix requires its Run");
      if ([...state.activeAttempts.values()].some((attempt) => attempt.runDigest === matrix.runDigest)) {
        fail("Matrix cannot close over active work");
      }
      if (state.matrices.has(matrix.runDigest)) fail("one closed Matrix per Run");
      state.matrices.set(matrix.runDigest, { digest: matrix.matrixDigest, gatesResolved: matrix.gatesResolved });
      break;
    }
    case "report-recorded": {
      const report = entry.payload as LiveHostPayload<"report-recorded">;
      const matrix = state.matrices.get(report.runDigest);
      if (matrix?.digest !== report.matrixDigest) fail("Report requires the exact preceding Run Matrix");
      const reports = new Set(state.reports.get(report.runDigest));
      reports.add(report.reportDigest);
      state.reports.set(report.runDigest, reports);
      break;
    }
    case "recommendation-recorded": {
      const recommendation = entry.payload as LiveHostPayload<"recommendation-recorded">;
      const matrix = state.matrices.get(recommendation.promotionRunDigest);
      if (state.promotionRunDigest !== recommendation.promotionRunDigest
        || matrix?.digest !== recommendation.matrixDigest
        || !matrix.gatesResolved
        || (state.reports.get(recommendation.promotionRunDigest)?.size ?? 0) === 0
        || state.activeAttempts.size > 0) {
        fail("recommendation requires resolved promotion gates, Matrix, Reports, and no active work");
      }
      if (state.recommendationDigest !== undefined) fail("recommendation is immutable once projected");
      state.recommendationDigest = recommendation.decisionDigest;
      break;
    }
    case "cancellation-requested": {
      if (state.phase !== "ACTIVE") fail("cancellation may be requested once while active");
      state.phase = "CANCELLING";
      break;
    }
    case "closed": {
      if (state.phase === "EMPTY" || state.activeAttempts.size > 0) fail("closure requires a plan and no active work");
      state.phase = "CLOSED";
      break;
    }
    case "late-terminal-recorded": {
      const late = entry.payload as LiveHostPayload<"late-terminal-recorded">;
      if (state.phase !== "CLOSED") fail("late terminal evidence is reserved for a closed campaign");
      state.lateEvidence.push(late.evidenceDigest);
      break;
    }
  }
  return {
    ...state,
    entries: entry.seq,
    head: eventDigest(entry),
  };
}

export function replayLiveHostJournal(input: {
  readonly bytes: Uint8Array;
  readonly campaign: string;
  readonly author: string;
}): LiveHostJournalState {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  if (text === "") return emptyState();
  if (!text.endsWith("\n")) fail("journal must end at a complete canonical line");
  let state = emptyState();
  for (const line of text.slice(0, -1).split("\n")) {
    const entry = parseEntry(line);
    if (entry.campaign !== input.campaign || entry.author !== input.author) {
      fail("campaign or journal-author identity changed");
    }
    state = reduceLiveHostEntry(state, entry);
  }
  return state;
}

export interface LiveHostJournalTransaction {
  readonly state: LiveHostJournalState;
  append<T extends LiveHostEventType>(event: LiveHostEventInput<T>): LiveHostJournalState;
}

/** Holds the OS lock across replay, caller side effects, and every atomic append. */
export class LiveHostJournal {
  private readonly path: string;
  constructor(
    private readonly stateRoot: string,
    private readonly campaign: string,
    private readonly author: string,
  ) {
    this.path = join(stateRoot, "campaigns", campaign.slice("sha256:".length), "live-host.journal");
  }

  async transact<T>(operation: (transaction: LiveHostJournalTransaction) => Promise<T>): Promise<T> {
    return withHostAdvisoryLock(this.stateRoot, async () => {
      let bytes = existsSync(this.path) ? secureRead(this.path) : new Uint8Array();
      let state = replayLiveHostJournal({ bytes, campaign: this.campaign, author: this.author });
      const transaction: LiveHostJournalTransaction = {
        get state() { return state; },
        append: <E extends LiveHostEventType>(event: LiveHostEventInput<E>) => {
          const entry = {
            formatToken: LIVE_HOST_JOURNAL_FORMAT_TOKEN,
            campaign: this.campaign,
            author: this.author,
            seq: state.entries + 1,
            previous: state.head,
            recordedAt: event.recordedAt,
            type: event.type,
            payload: event.payload,
          } as LiveHostJournalEntry<E>;
          const line = canonicalJsonBytes(entry as unknown as JsonValue);
          const parsed = parseEntry(new TextDecoder().decode(line));
          const next = reduceLiveHostEntry(state, parsed);
          const combined = new Uint8Array(bytes.length + line.length + 1);
          combined.set(bytes, 0);
          combined.set(line, bytes.length);
          combined[combined.length - 1] = 0x0a;
          secureAtomicWrite(this.path, combined);
          bytes = combined;
          state = next;
          return state;
        },
      };
      return operation(transaction);
    });
  }
}
