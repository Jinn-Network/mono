import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LiveHostJournal, type LiveHostEventInput } from "./journal.js";

const CAMPAIGN = `sha256:${"1".repeat(64)}`;
const PLAN = `sha256:${"2".repeat(64)}`;
const SPLIT = `sha256:${"3".repeat(64)}`;
const DEV = `sha256:${"4".repeat(64)}`;
const PROMOTION = `sha256:${"5".repeat(64)}`;
const CURRENT = `sha256:${"6".repeat(64)}`;
const CHALLENGER = `sha256:${"7".repeat(64)}`;
const MATRIX = `sha256:${"8".repeat(64)}`;
const REPORT = `sha256:${"9".repeat(64)}`;
const BINDING = `sha256:${"a".repeat(64)}`;
const EVIDENCE = `sha256:${"b".repeat(64)}`;
const CELL = `${"c".repeat(64)}/challenger/1`;
const AT = "2026-08-05T12:00:00Z";

function event<T extends LiveHostEventInput["type"]>(
  type: T,
  payload: Extract<LiveHostEventInput, { type: T }>["payload"] | Record<string, unknown>,
): LiveHostEventInput<T> {
  return { recordedAt: AT, type, payload } as LiveHostEventInput<T>;
}

function journal(root: string) {
  return new LiveHostJournal(root, CAMPAIGN, "urn:jinn:journal-author");
}

async function append(root: string, input: LiveHostEventInput) {
  return journal(root).transact(async (transaction) => transaction.append(input));
}

async function development(root: string) {
  await append(root, event("plan-recorded", { planDigest: PLAN, splitManifestDigest: SPLIT }));
  await append(root, event("run-recorded", {
    runDigest: DEV,
    kind: "development",
    arms: [
      { armId: "current", tupleDigest: CURRENT },
      { armId: "challenger", tupleDigest: CHALLENGER },
    ],
  }));
  await append(root, event("matrix-recorded", { runDigest: DEV, matrixDigest: MATRIX, gatesResolved: true }));
  await append(root, event("report-recorded", { runDigest: DEV, matrixDigest: MATRIX, reportDigest: REPORT }));
  await append(root, event("challenger-frozen", {
    challengerTupleDigest: CHALLENGER,
    developmentRunDigest: DEV,
  }));
}

describe("live host relational journal", () => {
  test("restarts at every durable boundary and resumes CANCELLING until all attempts drain", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-live-journal-"));
    await development(root);
    await append(root, event("run-recorded", {
      runDigest: PROMOTION,
      kind: "promotion",
      arms: [
        { armId: "current", tupleDigest: CURRENT },
        { armId: "challenger", tupleDigest: CHALLENGER },
      ],
    }));
    await append(root, event("promotion-revealed", {
      promotionRunDigest: PROMOTION,
      splitManifestDigest: SPLIT,
    }));
    await append(root, event("submission-prepared", {
      runDigest: PROMOTION, cellKey: CELL, armId: "challenger", dispatch: 1,
      role: "solver", bindingDigest: BINDING,
    }));
    await append(root, event("submission-accepted", {
      runDigest: PROMOTION, cellKey: CELL, armId: "challenger", dispatch: 1,
      role: "solver", bindingDigest: BINDING,
      submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
      attempt: "urn:uuid:22222222-2222-5222-8222-222222222222",
    }));
    const cancelling = await append(root, event("cancellation-requested", { reasonCode: "operator-request" }));
    expect(cancelling.phase).toBe("CANCELLING");
    expect(cancelling.activeAttempts.size).toBe(1);
    await expect(append(root, event("submission-prepared", {
      runDigest: PROMOTION, cellKey: CELL, armId: "challenger", dispatch: 2,
      role: "solver", bindingDigest: `sha256:${"d".repeat(64)}`,
    }))).rejects.toThrow(/new dispatch/u);
    await append(root, event("attempt-terminal-recorded", {
      runDigest: PROMOTION, cellKey: CELL, armId: "challenger", dispatch: 1,
      role: "solver", attempt: "urn:uuid:22222222-2222-5222-8222-222222222222",
      state: "cancelled", evidenceDigest: EVIDENCE,
    }));
    const closed = await append(root, event("closed", { reasonCode: "cancelled-and-drained" }));
    expect(closed.phase).toBe("CLOSED");
    const late = await append(root, event("late-terminal-recorded", {
      role: "solver",
      attempt: "urn:uuid:22222222-2222-5222-8222-222222222222",
      evidenceDigest: `sha256:${"e".repeat(64)}`,
      terminalState: "delivered",
    }));
    expect(late.lateEvidence).toHaveLength(1);
    await expect(append(root, event("matrix-recorded", {
      runDigest: PROMOTION, matrixDigest: `sha256:${"f".repeat(64)}`, gatesResolved: true,
    }))).rejects.toThrow(/closed campaign/u);
  });

  test("enforces stable arm identity, a single promotion Run, and consumed promotion", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-live-relations-"));
    await development(root);
    await expect(append(root, event("run-recorded", {
      runDigest: PROMOTION,
      kind: "promotion",
      arms: [{ armId: "challenger", tupleDigest: CURRENT }],
    }))).rejects.toThrow(/armId/u);
    await append(root, event("run-recorded", {
      runDigest: PROMOTION,
      kind: "promotion",
      arms: [{ armId: "challenger", tupleDigest: CHALLENGER }],
    }));
    await expect(append(root, event("run-recorded", {
      runDigest: `sha256:${"d".repeat(64)}`,
      kind: "promotion",
      arms: [{ armId: "challenger", tupleDigest: CHALLENGER }],
    }))).rejects.toThrow(/one promotion Run/u);
    await append(root, event("promotion-revealed", {
      promotionRunDigest: PROMOTION, splitManifestDigest: SPLIT,
    }));
    await expect(append(root, event("promotion-revealed", {
      promotionRunDigest: PROMOTION, splitManifestDigest: SPLIT,
    }))).rejects.toThrow(/consumed/u);
  });

  test("refuses closure with work active and recommendation before all promotion gates resolve", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-live-gates-"));
    await development(root);
    await append(root, event("run-recorded", {
      runDigest: PROMOTION,
      kind: "promotion",
      arms: [{ armId: "challenger", tupleDigest: CHALLENGER }],
    }));
    await append(root, event("matrix-recorded", {
      runDigest: PROMOTION,
      matrixDigest: `sha256:${"d".repeat(64)}`,
      gatesResolved: false,
    }));
    await append(root, event("report-recorded", {
      runDigest: PROMOTION,
      matrixDigest: `sha256:${"d".repeat(64)}`,
      reportDigest: `sha256:${"e".repeat(64)}`,
    }));
    await expect(append(root, event("recommendation-recorded", {
      promotionRunDigest: PROMOTION,
      matrixDigest: `sha256:${"d".repeat(64)}`,
      decisionDigest: `sha256:${"f".repeat(64)}`,
    }))).rejects.toThrow(/resolved promotion gates/u);
  });
});
