// packages/marketplace/pipeline/src/facts-mapper.test.ts
import { describe, expect, it } from "vitest";
import { mapAnnouncedSubmissionToFacts, type AnnouncedSubmissionCard } from "./facts-mapper.js";

const CHAIN = {
  taskId: 42n,
  submission: "urn:uuid:11111111-2222-3333-4444-555555555555" as const,
  nonce: "0x01",
  intendedSpendWei: 1_000_000_000_000n,
};

const CHAIN_CARD: AnnouncedSubmissionCard = {
  record: { kind: "https://jinn.network/records/task-execution/submission/1.0", digest: `sha256:${"a".repeat(64)}` },
  facts: {
    taskDigest: `sha256:${"b".repeat(64)}`,
    taskProfileUri: "https://jinn.network/profiles/task-execution/repository-work/1.0",
    workKind: "repository-work",
    runPinning: { harness: "claude-code", model: "claude-haiku-4-5-20251001" },
    requirements: { isolation: "process" },
  },
  chain: CHAIN,
  derivationKind: "chain",
};

const options = { estimateAiUnits: () => 3, acceptLegacyCards: true };

describe("facts → SubmissionFacts mapper", () => {
  it("maps a chain-derived submission card", () => {
    const result = mapAnnouncedSubmissionToFacts(CHAIN_CARD, options);
    expect(result).toEqual({
      ok: true,
      facts: {
        taskId: 42n,
        taskDigest: `sha256:${"b".repeat(64)}`,
        submission: CHAIN.submission,
        nonce: "0x01",
        profileUri: "https://jinn.network/profiles/task-execution/repository-work/1.0",
        requirements: { isolation: "process" },
        runnable: true,
        intendedSpendWei: 1_000_000_000_000n,
        intendedAiUnits: 3,
        workKind: "repository-work",
        runPinning: { harness: "claude-code", model: "claude-haiku-4-5-20251001" },
      },
    });
  });

  it("carries the bridge annotation and keys workKind off the manifest digest on a legacy card", () => {
    const result = mapAnnouncedSubmissionToFacts(
      { ...CHAIN_CARD, derivationKind: "legacy", legacyManifestDigest: "QmSolver" },
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.workKind).toBe("QmSolver");
    expect(result.facts.legacyManifestDigest).toBe("QmSolver");
  });

  it("refuses a legacy card with no manifest digest", () => {
    expect(
      mapAnnouncedSubmissionToFacts({ ...CHAIN_CARD, derivationKind: "legacy" }, options),
    ).toEqual({ ok: false, reason: "legacy-card-without-manifest-digest" });
  });

  it("refuses legacy cards once the bridge is retired", () => {
    expect(
      mapAnnouncedSubmissionToFacts(
        { ...CHAIN_CARD, derivationKind: "legacy", legacyManifestDigest: "QmSolver" },
        { ...options, acceptLegacyCards: false },
      ),
    ).toEqual({ ok: false, reason: "legacy-card-without-manifest-digest" });
  });

  it("refuses a delivery record announced as a submission", () => {
    expect(
      mapAnnouncedSubmissionToFacts(
        { ...CHAIN_CARD, record: { ...CHAIN_CARD.record, kind: "https://jinn.network/records/delivery/1.0" } },
        options,
      ),
    ).toEqual({ ok: false, reason: "wrong-record-kind" });
  });

  it("refuses a card whose facts omit the task digest", () => {
    const { taskDigest: _drop, ...rest } = CHAIN_CARD.facts as Record<string, unknown>;
    expect(mapAnnouncedSubmissionToFacts({ ...CHAIN_CARD, facts: rest }, options)).toEqual({
      ok: false,
      reason: "missing-task-digest",
    });
  });

  it("honours an operator runnable predicate", () => {
    const result = mapAnnouncedSubmissionToFacts(CHAIN_CARD, { ...options, runnable: () => false });
    expect(result.ok && result.facts.runnable).toBe(false);
  });
});
