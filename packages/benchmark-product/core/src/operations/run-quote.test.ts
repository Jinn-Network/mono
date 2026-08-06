import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import { readRunState } from "../run/state.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-quote-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpTwoArmDraft(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  const draftResult = createDraft(contextFor(clock), { draftId, name: "Quote Test" });
  expect(draftResult.ok).toBe(true);
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
}

function forceDraftState(draftId: string, state: string): void {
  const document = readDraftDocument(workspaceDir, draftId);
  atomicWriteFileSync(draftPath(workspaceDir, draftId), JSON.stringify({ ...document, state }, null, 2));
}

describe("runQuote — lifecycle transition (real venue)", () => {
  test("draft -> quoted; persists RunState with owner/specSha256/quote/quotedAt; audited under 'quote'", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("quoted");
    expect(outcome.result.quote.expectedCellCount).toBeGreaterThan(0);
    expect(outcome.result.quote.ok).toBe(true);

    const state = readRunState(workspaceDir, "draft-1");
    expect(state).toBeDefined();
    expect(state?.owner.startsWith("urn:uuid:")).toBe(true);
    expect(state?.specSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(state?.quote?.expectedCellCount).toBe(outcome.result.quote.expectedCellCount);
    expect(state?.quotedAt).toBeDefined();
    // Nothing signs, posts, or spends — no runSha256/lockedAt yet.
    expect(state?.runSha256).toBeUndefined();

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "quote", subject: "draft-1", outcome: "ok" });
  }, 30_000);

  test("re-quoting an already-quoted draft is idempotent on state (stays 'quoted') and refreshes RunState", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    const first = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(first.ok).toBe(true);

    const second = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.draft.state).toBe("quoted");

    const entries = readAuditEntries(workspaceDir);
    expect(entries.filter((entry) => entry.action === "quote")).toHaveLength(2);
  }, 30_000);

  test("refuses illegal-transition from a state other than draft/quoted", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    forceDraftState("draft-1", "locked");

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  }, 30_000);

  test("a quote with ok:false (hard-cap breach) still persists and returns as a successful operation", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    const document = readDraftDocument(workspaceDir, "draft-1");
    atomicWriteFileSync(
      draftPath(workspaceDir, "draft-1"),
      JSON.stringify(
        { ...document, spec: { ...document.spec, budget: { perCell: { solve: "1", evaluate: "1" }, hardCap: "0.01", unit: "USD" } } },
        null,
        2,
      ),
    );

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.quote.ok).toBe(false);
    expect(outcome.result.quote.errors.some((error) => error.code === "hard-cap-breach")).toBe(true);

    const state = readRunState(workspaceDir, "draft-1");
    expect(state?.quote?.ok).toBe(false);

    const entries = readAuditEntries(workspaceDir);
    // A quote's own ok:false is not an operation failure — the audit outcome is "ok".
    expect(entries[entries.length - 1]).toMatchObject({ action: "quote", outcome: "ok" });
  }, 30_000);

  test("compile validation failures (fewer than 2 arms) surface as a typed operation error, not a silent quote", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    const draftResult = createDraft(contextFor(clock), { draftId: "draft-1", name: "One Arm" });
    expect(draftResult.ok).toBe(true);
    await sampleInit(contextFor(clock), { draftId: "draft-1" });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "solo", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");

    // The draft state is unchanged — a failed operation never partially advances the lifecycle.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("draft");
  }, 30_000);

  test("gating: quote is ungated — a bare workspace member with no grants can quote", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });

    const outcome = await runQuote(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
  }, 30_000);
});

describe("runQuote — dependency-injected venue (test seam)", () => {
  test("uses the injected createVenue instead of the real local venue", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    let created = 0;
    const stub: LocalVenue = {
      backend: {
        async capabilities() {
          return {
            taskProfiles: [],
            inputMediaTypes: [],
            outputMediaTypes: [],
            cancel: false,
            watch: false,
            preflight: false,
            fetchArtifact: false,
            confidentialInputs: false,
            signedObservations: false,
            signedDeliveries: false,
            evidenceCapture: "none",
            deadlineEnforcement: false,
            isolation: ["unrestricted"],
            attempts: {},
            runPinning: {
              keys: [
                { key: "harness", inventory: ["prediction-v1-baseline", "sample-uniform"], posture: "enforced" },
                { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
              ],
            },
          };
        },
        submit: async () => {
          throw new Error("not used by runQuote");
        },
        observe: async () => {
          throw new Error("not used by runQuote");
        },
        recover: async () => {
          throw new Error("not used by runQuote");
        },
        deliveries: async () => [],
        fetchDelivery: async () => {
          throw new Error("not used by runQuote");
        },
      } as unknown as LocalVenue["backend"],
      verdictKeyId: "stub-key",
      prepareEvaluationCell: () => {
        throw new Error("not used by runQuote");
      },
      async shutdown() {},
    };

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: (options) => {
        created += 1;
        expect(options.workspaceDir).toBe(workspaceDir);
        return stub;
      },
    });
    expect(created).toBe(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.quote.ok).toBe(true);
  });

  test("venue construction failure surfaces as venue-unavailable, not execution", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => {
        throw new Error("boom: no launchers available in this sandbox");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unavailable");
  });
});
