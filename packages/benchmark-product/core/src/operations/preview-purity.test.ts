/**
 * BP-20 AC3 (compilation-exclusion leg): proves a preview's own log/journal/artifacts are
 * genuinely excluded from official Run compilation — not merely absent from a per-file diff, but
 * absent from the sealed Run record's own BYTES. Two workspaces are driven through the identical
 * init -> create -> sample -> arm -> quote -> lock sequence at IDENTICAL clock instants; workspace
 * A additionally runs `runPreview` twice between arm-add and quote. If the preview log or its
 * artifacts leaked into `compileDraft`'s inputs in any way, the two workspaces' sealed Run bytes
 * would diverge (a different `owner`, a different embedded field, anything). They do not.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type { ProxiedBackend } from "../run/drive.js";
import { readPreviewLog } from "../run/preview-log.js";
import { readRunState } from "../run/state.js";
import { sha256Hex, getSealedBytes } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runLock } from "./run-lock.js";
import { runPreview } from "./preview.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceA: string;
let workspaceB: string;

beforeEach(() => {
  workspaceA = mkdtempSync(join(tmpdir(), "bp20-purity-a-"));
  workspaceB = mkdtempSync(join(tmpdir(), "bp20-purity-b-"));
});

afterEach(() => {
  rmSync(workspaceA, { recursive: true, force: true });
  rmSync(workspaceB, { recursive: true, force: true });
});

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/** Same solve-only fake as `preview.test.ts` — duplicated rather than shared, matching this
 * package's existing per-test-file fake-backend convention (see `report.test.ts`). */
function makeSolveOnlyFakeBackend(): { backend: ProxiedBackend } {
  const byUri = new Map<string, { attempt: string; submission: string; deliveryDigestHex: string }>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used");
    },
    async submit(_taskBytes, submissionBytes) {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as { idempotencyKey: string; submission: string };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) return prior.ack;
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const artifactHex = store(utf8({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
      const deliveryHex = store(utf8({ outputs: [{ name: "prediction", digest: { sha256: artifactHex } }] }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake: no attempt for ${String(ref)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as `urn:uuid:${string}`,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as `urn:uuid:${string}`,
          derived: { state: "delivered", terminal: true, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend };
}

function fakeVenue(backend: ProxiedBackend): LocalVenue {
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-venue-verdict-key",
    evaluators: [{ id: "urn:jinn:benchmark-product:local-venue:evaluator-1", keyId: "fake-venue-verdict-key" }],
    prepareEvaluationCell: () => {
      throw new Error("not used");
    },
    async shutdown() {},
  };
}

describe("preview purity — compilation exclusion (AC3)", () => {
  test(
    "workspace A (previewed twice between arm-add and quote) seals a BYTE-IDENTICAL official Run "
      + "to workspace B (never previewed), driven at identical instants",
    async () => {
      // A single settable clock shared by both workspaces: every step below runs both workspaces
      // at the SAME instant (no `advance()` between a workspace-A call and its workspace-B
      // counterpart), so any divergence in the sealed Run bytes could only come from the preview
      // calls themselves, never from clock skew.
      let instant = Date.parse("2026-08-06T00:00:00.000Z");
      const clock = (): string => new Date(instant).toISOString();
      const advance = (ms: number): void => {
        instant += ms;
      };
      const contextFor = (workspaceDir: string, principal = "sponsor-1"): OperationContext => ({
        workspaceDir,
        principal,
        clock,
      });

      // ── init ─────────────────────────────────────────────────────────────────────────────
      expect(initWorkspace(contextFor(workspaceA)).ok).toBe(true);
      expect(initWorkspace(contextFor(workspaceB)).ok).toBe(true);
      // Publication gives each workspace a durable did:key identity at initialization. This
      // fixture compares compilation purity rather than identity uniqueness, so make B an exact
      // identity clone of A before either workspace authors benchmark material.
      copyFileSync(join(workspaceA, "venue", "report-signing-key.pem"), join(workspaceB, "venue", "report-signing-key.pem"));
      copyFileSync(join(workspaceA, "venue", "report-signing-key.json"), join(workspaceB, "venue", "report-signing-key.json"));
      advance(10);

      // ── create ───────────────────────────────────────────────────────────────────────────
      expect(createDraft(contextFor(workspaceA), { draftId: "draft-1", name: "Purity" }).ok).toBe(true);
      expect(createDraft(contextFor(workspaceB), { draftId: "draft-1", name: "Purity" }).ok).toBe(true);
      advance(10);

      // ── sample ───────────────────────────────────────────────────────────────────────────
      const sampleA = await sampleInit(contextFor(workspaceA), { draftId: "draft-1" });
      const sampleB = await sampleInit(contextFor(workspaceB), { draftId: "draft-1" });
      expect(sampleA.ok, JSON.stringify(sampleA)).toBe(true);
      expect(sampleB.ok, JSON.stringify(sampleB)).toBe(true);
      advance(10);

      // ── arms ─────────────────────────────────────────────────────────────────────────────
      const pinning1 = { harness: { id: "prediction-v1-baseline", version: "1.0.0" } };
      const pinning2 = { harness: { id: "sample-uniform", version: "0.1.0" } };
      expect(armAdd(contextFor(workspaceA), { draftId: "draft-1", armId: "baseline", pinning: pinning1 }).ok).toBe(true);
      expect(armAdd(contextFor(workspaceB), { draftId: "draft-1", armId: "baseline", pinning: pinning1 }).ok).toBe(true);
      advance(10);
      expect(armAdd(contextFor(workspaceA), { draftId: "draft-1", armId: "sample", pinning: pinning2 }).ok).toBe(true);
      expect(armAdd(contextFor(workspaceB), { draftId: "draft-1", armId: "sample", pinning: pinning2 }).ok).toBe(true);
      advance(10);

      // ── A ONLY: two previews between arm-add and quote ──────────────────────────────────────
      const { backend } = makeSolveOnlyFakeBackend();
      const preview1 = await runPreview(contextFor(workspaceA), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
      expect(preview1.ok, JSON.stringify(preview1)).toBe(true);
      advance(10);
      const preview2 = await runPreview(contextFor(workspaceA), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
      expect(preview2.ok, JSON.stringify(preview2)).toBe(true);
      advance(10);

      // ── quote (both workspaces, same instant) ───────────────────────────────────────────────
      const quotedA = await runQuote(contextFor(workspaceA), { draftId: "draft-1" });
      const quotedB = await runQuote(contextFor(workspaceB), { draftId: "draft-1" });
      expect(quotedA.ok, JSON.stringify(quotedA)).toBe(true);
      expect(quotedB.ok, JSON.stringify(quotedB)).toBe(true);
      advance(10);

      // ── lock (both workspaces, same instant) ────────────────────────────────────────────────
      const lockedA = runLock(contextFor(workspaceA), { draftId: "draft-1" });
      const lockedB = runLock(contextFor(workspaceB), { draftId: "draft-1" });
      expect(lockedA.ok, JSON.stringify(lockedA)).toBe(true);
      expect(lockedB.ok, JSON.stringify(lockedB)).toBe(true);
      if (!lockedA.ok || !lockedB.ok) return;

      // ── the sealed official Run bytes are byte-identical ────────────────────────────────────
      expect(lockedA.result.runSha256).toBe(lockedB.result.runSha256);
      const runStateA = readRunState(workspaceA, "draft-1");
      const runStateB = readRunState(workspaceB, "draft-1");
      expect(runStateA?.runSha256).toBeDefined();
      expect(runStateB?.runSha256).toBeDefined();
      if (runStateA?.runSha256 === undefined || runStateB?.runSha256 === undefined) return;

      const runBytesA = getSealedBytes(workspaceA, runStateA.runSha256);
      const runBytesB = getSealedBytes(workspaceB, runStateB.runSha256);
      expect(Buffer.from(runBytesA).equals(Buffer.from(runBytesB))).toBe(true);

      // ── the preview log is exclusive to workspace A ─────────────────────────────────────────
      expect(readPreviewLog(workspaceA, "draft-1")?.count).toBe(2);
      expect(readPreviewLog(workspaceB, "draft-1")).toBeUndefined();
    },
    30_000,
  );
});
