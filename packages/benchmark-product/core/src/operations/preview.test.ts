import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type { ProxiedBackend } from "../run/drive.js";
import { PREVIEW_MARKER, readPreviewLog } from "../run/preview-log.js";
import { previewArtifactPath } from "../workspace/layout.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { readAuditEntries } from "../audit/journal.js";
import { runLock } from "./run-lock.js";
import { runPreview } from "./preview.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp20-preview-op-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-06T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/** Fake backend covering only the solve leg (submit -> terminal "delivered" observe ->
 * deliveries/fetchDelivery/fetchArtifact for outputs) — a preview never dispatches an evaluation
 * leg, so nothing evaluation-shaped needs to be faked. Adapted from
 * `../operations/report.test.ts`'s `makeStatefulFakeBackend`. */
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

async function setUpDraftWithTwoArms(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Preview Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
}

/** Snapshots a recursive `{relativePath -> sha256}` map of a directory. Absent dir -> `{}`. */
function snapshotDir(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else {
        snapshot[relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  }
  walk(root);
  return snapshot;
}

function officialStateSnapshot(): Record<string, string> {
  return {
    ...snapshotDir(join(workspaceDir, "drafts")),
    ...snapshotDir(join(workspaceDir, "records")),
    ...snapshotDir(join(workspaceDir, "runs")),
  };
}

describe("runPreview — repeatability and non-advancement", () => {
  test("two consecutive previews succeed in draft state, previewIds increment, state stays draft, draft bytes unchanged", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);
    const draftPath = join(workspaceDir, "drafts", "draft-1.json");
    const bytesBefore = readFileSync(draftPath);

    const { backend } = makeSolveOnlyFakeBackend();
    const first = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.result.preview.previewId).toBe("preview-001");
    expect(first.result.draft.state).toBe("draft");

    const second = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.result.preview.previewId).toBe("preview-002");
    expect(second.result.previewCount).toBe(2);

    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("draft");
    const log = readPreviewLog(workspaceDir, "draft-1");
    expect(log?.count).toBe(2);

    const bytesAfter = readFileSync(draftPath);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });

  test("legal in quoted state, and lock still succeeds after a preview (quote is not invalidated)", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("quoted");

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) return;
    expect(preview.result.draft.state).toBe("quoted");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("quoted");

    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    if (!locked.ok) return;
    expect(locked.result.draft.state).toBe("locked");
  });

  test("refuses illegal-transition once the draft is locked", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error.code).toBe("illegal-transition");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
  });

  test("an orphaned preview directory (crash remnant the log never counted) is skipped, never reused", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);

    // Simulate a crash between an earlier preview's directory claim and its log append: the
    // directory exists, the log does not count it. The next preview must claim a FRESH id
    // rather than reuse the orphan's — reuse would concatenate the new rehearsal's journal
    // onto the stale one and overwrite its artifact.
    mkdirSync(join(workspaceDir, "previews", "draft-1", "preview-001"), { recursive: true });

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) return;
    expect(preview.result.preview.previewId).toBe("preview-002");
    expect(existsSync(previewArtifactPath(workspaceDir, "draft-1", "preview-002"))).toBe(true);
    expect(existsSync(previewArtifactPath(workspaceDir, "draft-1", "preview-001"))).toBe(false);
  });
});

describe("runPreview — contamination proof (never writes official state)", () => {
  test("drafts/, records/, and runs/ are byte-identical before and after a preview", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);

    const before = officialStateSnapshot();
    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const after = officialStateSnapshot();

    expect(after).toEqual(before);

    // The audit journal IS expected to have grown (spec §4.4) — deliberately excluded from the
    // snapshot above, checked separately here.
    const audit = readAuditEntries(workspaceDir);
    expect(audit.some((entry) => entry.action === "preview" && entry.outcome === "ok")).toBe(true);
  });
});

describe("runPreview — artifact honesty", () => {
  test("preview.json exists with the rehearsal marker, solve-cells-only scope, and correct per-arm cell counts", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) return;

    const artifactPath = previewArtifactPath(workspaceDir, "draft-1", "preview-001");
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as typeof preview.result.preview;

    expect(artifact.marker).toBe(PREVIEW_MARKER);
    expect(artifact.scope).toBe("solve-cells-only");
    expect(artifact.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(artifact.itemCount).toBe(3);
    expect(artifact.cellCount).toBe(6); // 3 items x 2 arms x 1 replicate
    expect(artifact.arms).toHaveLength(2);
    for (const arm of artifact.arms) {
      expect(arm.cells).toBe(3);
      expect(arm.outcomes.delivered).toBe(3);
      expect(arm.outcomes.failed + arm.outcomes.expired + arm.outcomes.cancelled + arm.outcomes.other).toBe(0);
    }
    expect(artifact).toEqual(preview.result.preview);
  });
});

describe("runPreview — items bounds the rehearsal", () => {
  test("items: 1 bounds itemCount to 1 and cellCount to 1 x arms x replicates", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1", items: 1 }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) return;

    expect(preview.result.preview.itemCount).toBe(1);
    expect(preview.result.preview.cellCount).toBe(2); // 1 item x 2 arms x 1 replicate
  });

  test("items: 0 refuses validation", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1", items: 0 }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error.code).toBe("validation");
  });

  test("a non-integer items value refuses validation", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock), { draftId: "draft-1", items: 1.5 }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error.code).toBe("validation");
  });
});

describe("runPreview — authority (ungated)", () => {
  test("a member with no operation grants can still preview, and the last audit entry records it", async () => {
    const clock = makeClock();
    await setUpDraftWithTwoArms(clock);
    const granted = authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
    expect(granted.ok).toBe(true);

    const { backend } = makeSolveOnlyFakeBackend();
    const preview = await runPreview(contextFor(clock, "agent-1"), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "preview", actor: "agent-1", outcome: "ok" });
  });
});
