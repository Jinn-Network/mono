// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ClaimSubmissionScopeInput, RecordSubmissionInput, SubmissionScopeOwnerToken,
} from "@jinn-network/marketplace-binding";
import {
  postingCommandDigestOf,
  postingIntentKeyOf,
  type PreparedPostingCommand,
} from "@jinn-network/marketplace-binding";
import { TaskExecutionError, type AttemptUri, type SubmissionUri } from "@jinn-network/task-execution-backend";
import { documentDigest } from "@jinn-network/task-execution-protocol";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createObserveStore } from "./observe-store.js";

const REQUESTER = "0x1111111111111111111111111111111111111111";
const SUBMISSION_URI = "urn:uuid:11111111-1111-4111-8111-111111111111" as SubmissionUri;
const TASK_DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const TX_HASH = `0x${"c".repeat(64)}` as `0x${string}`;
const ATTEMPT = "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptUri;

function bytes(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

function baseInput(overrides: Partial<ClaimSubmissionScopeInput> = {}): ClaimSubmissionScopeInput {
  const submissionBytes = bytes("submission-a");
  const venueNamespace = overrides.venueNamespace ?? "test:venue";
  const commandDigest = overrides.commandDigest ?? `sha256:${"d".repeat(64)}`;
  return {
    requester: REQUESTER,
    idempotencyKey: "idem-1",
    submissionUri: SUBMISSION_URI,
    digest: documentDigest(submissionBytes),
    submissionBytes,
    taskDigest: TASK_DIGEST,
    creatorSafe: REQUESTER,
    postingIntentKey: postingIntentKeyOf({
      creatorSafe: REQUESTER,
      taskCidDigest: TASK_DIGEST,
      submissionDigest: documentDigest(submissionBytes),
      venueNamespace,
      commandDigest,
    }),
    ...overrides,
    venueNamespace,
    commandDigest,
  };
}

function resolveInput(overrides: Partial<RecordSubmissionInput> = {}): RecordSubmissionInput {
  const submissionBytes = bytes("submission-a");
  return {
    taskDigest: TASK_DIGEST,
    submissionDigest: documentDigest(submissionBytes),
    submissionBytes,
    submission: { requester: REQUESTER, idempotencyKey: "idem-1" },
    outcome: { taskId: 7n, txHash: TX_HASH },
    ...overrides,
  };
}

function exactCommand(input: ClaimSubmissionScopeInput): PreparedPostingCommand {
  const unsigned: Omit<PreparedPostingCommand, "commandDigest"> = {
    venueNamespace: input.venueNamespace,
    chainId: 84532,
    generation: "today",
    router: "0x2222222222222222222222222222222222222222",
    creatorSafe: input.creatorSafe,
    taskCidDigest: input.taskDigest,
    submissionDigest: input.digest,
    idempotencyKey: input.idempotencyKey,
    maxClaims: 1,
    solutionMaxDeliveryRateWei: "1",
    verdictMaxDeliveryRateWei: "1",
    responseTimeoutSeconds: "60",
    allowSolverSelfEvaluation: false,
    to: "0x2222222222222222222222222222222222222222",
    valueWei: "2",
    data: "0x1234",
  };
  return { ...unsigned, commandDigest: postingCommandDigestOf(unsigned) };
}

let root: string;
let dbPath: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-observe-store-"));
  dbPath = join(root, "venue.db");
  state = openVenueState(dbPath);
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe("createObserveStore (design §7 ruling on TEP §12.2 idempotent resubmission)", () => {
  test("claimSubmissionScope on an unseen key returns owner", async () => {
    const store = createObserveStore(state);
    const claim = await store.claimSubmissionScope(baseInput());
    expect(claim.kind).toBe("owner");
    if (claim.kind !== "owner") throw new Error("expected owner");
    expect(claim.ownerToken).toMatch(/^submission-scope-owner:/u);
  });

  test("atomically adopts only the exact resolved posting WAL outcome", async () => {
    const store = createObserveStore(state);
    const seed = baseInput();
    const command = exactCommand(seed);
    const input = baseInput({ commandDigest: command.commandDigest });
    const claim = await store.claimSubmissionScope(input);
    expect(claim.kind).toBe("owner");
    state.db.prepare(
      "INSERT INTO posting_intents (creator_safe, task_cid_digest, submission_digest, idempotency_key,"
      + " owner_token, created_at, venue_namespace, command_digest, command_json, resolved_task_id, resolved_tx_hash)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.creatorSafe.toLowerCase(), input.taskDigest, input.digest, input.idempotencyKey,
      "posting-owner:test", "2026-08-03T00:00:00Z", input.venueNamespace,
      input.commandDigest, JSON.stringify(command), "7", TX_HASH,
    );

    await expect(store.resolveRecoveredSubmissionScope(input)).resolves.toBe("resolved");
    await expect(store.resolveRecoveredSubmissionScope(input)).resolves.toBe("already-resolved");
    await expect(store.readSubmissionScope(input.requester, input.idempotencyKey)).resolves.toMatchObject({
      outcome: { taskId: 7n, txHash: TX_HASH },
    });
  });

  test("a second claim with byte-identical bytes while pending returns pending", async () => {
    const store = createObserveStore(state);
    await store.claimSubmissionScope(baseInput());
    const second = await store.claimSubmissionScope(baseInput());
    expect(second).toEqual({ kind: "pending" });
  });

  test("a second claim with different bytes under the same key returns conflict, never pending", async () => {
    const store = createObserveStore(state);
    await store.claimSubmissionScope(baseInput());
    const second = await store.claimSubmissionScope(baseInput({ submissionBytes: bytes("submission-b") }));
    expect(second).toEqual({ kind: "conflict" });
  });

  test("after resolveSubmissionScope, a byte-identical claim returns resolved with matching bytes", async () => {
    const store = createObserveStore(state);
    const claim = await store.claimSubmissionScope(baseInput());
    if (claim.kind !== "owner") throw new Error("expected owner");
    await store.resolveSubmissionScope(resolveInput(), claim.ownerToken);

    const replay = await store.claimSubmissionScope(baseInput());
    expect(replay.kind).toBe("resolved");
    if (replay.kind !== "resolved") throw new Error("expected resolved");
    expect(replay.record.submissionBytes).toEqual(bytes("submission-a"));
    expect(replay.record.submissionUri).toBe(SUBMISSION_URI);
  });

  test("after resolution, a different-bytes claim still returns conflict", async () => {
    const store = createObserveStore(state);
    const claim = await store.claimSubmissionScope(baseInput());
    if (claim.kind !== "owner") throw new Error("expected owner");
    await store.resolveSubmissionScope(resolveInput(), claim.ownerToken);

    const conflicting = await store.claimSubmissionScope(baseInput({ submissionBytes: bytes("submission-b") }));
    expect(conflicting).toEqual({ kind: "conflict" });
  });

  test("resolveSubmissionScope with a foreign owner token throws", async () => {
    const store = createObserveStore(state);
    await store.claimSubmissionScope(baseInput());

    await expect(
      store.resolveSubmissionScope(resolveInput(), "submission-scope-owner:foreign" as SubmissionScopeOwnerToken),
    ).rejects.toThrow(/requester-scope owner/u);
  });

  test("recordDelivery is idempotent by (attempt, digest) -- recording the same bytes twice leaves one row", async () => {
    const store = createObserveStore(state);
    const payload = bytes("delivery-1");
    await store.recordDelivery(ATTEMPT, payload);
    await store.recordDelivery(ATTEMPT, payload);

    const refs = await store.deliveries(ATTEMPT);
    expect(refs).toHaveLength(1);
  });

  test("deliveries returns refs whose digest is the sha256 of the stored bytes and whose attempt matches", async () => {
    const store = createObserveStore(state);
    const payload = bytes("delivery-2");
    await store.recordDelivery(ATTEMPT, payload);

    const refs = await store.deliveries(ATTEMPT);
    expect(refs).toEqual([{ attempt: ATTEMPT, digest: documentDigest(payload) }]);
  });

  test("fetchDelivery returns the exact bytes; an unknown ref throws TaskExecutionError(\"result-unavailable\")", async () => {
    const store = createObserveStore(state);
    const payload = bytes("delivery-3");
    await store.recordDelivery(ATTEMPT, payload);
    const [ref] = await store.deliveries(ATTEMPT);
    if (ref === undefined) throw new Error("expected a delivery ref");

    const fetched = await store.fetchDelivery(ref);
    expect(fetched).toEqual(payload);

    await expect(
      store.fetchDelivery({ attempt: ATTEMPT, digest: documentDigest(bytes("never-recorded")) }),
    ).rejects.toThrow(TaskExecutionError);
    try {
      await store.fetchDelivery({ attempt: ATTEMPT, digest: documentDigest(bytes("never-recorded")) });
      throw new Error("expected fetchDelivery to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskExecutionError);
      expect((error as TaskExecutionError).category).toBe("result-unavailable");
    }
  });

  test("survives a close/reopen of the state file", async () => {
    const first = createObserveStore(state);
    const claim = await first.claimSubmissionScope(baseInput());
    if (claim.kind !== "owner") throw new Error("expected owner");
    await first.resolveSubmissionScope(resolveInput(), claim.ownerToken);
    await first.recordDelivery(ATTEMPT, bytes("delivery-4"));
    state.close();

    // Reassigned so `afterEach` closes the reopened handle -- avoids a double-close on `state`.
    state = openVenueState(dbPath);
    const store = createObserveStore(state);
    const replay = await store.claimSubmissionScope(baseInput());
    expect(replay.kind).toBe("resolved");
    const refs = await store.deliveries(ATTEMPT);
    expect(refs).toHaveLength(1);
  });
});
