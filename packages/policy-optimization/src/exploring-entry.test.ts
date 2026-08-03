import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealBenchmark } from "@jinn-network/benchmarking-records";
import { checkExploringEntry } from "./exploring-entry.js";
import { campaignWith, digestOf } from "./testing/campaign-fixtures.js";

const itemDigest = "a".repeat(64);
const otherItemDigest = "b".repeat(64);

function benchmark(reveal: Record<string, unknown>, items = [itemDigest, otherItemDigest]) {
  return sealBenchmark({
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    name: "promotion",
    description: "held-out promotion gate",
    version: "1.0.0",
    items: items.map((sha256) => ({ task: { digest: { sha256 } } })),
    reveal,
  });
}

const AFTER_RUN = { kind: "after-run", trustedRunNotClosed: true } as const;

function campaignFor(sealedDigest: string) {
  return campaignWith({
    target: {
      taskProfile: "https://profiles.jinn.network/repository-work/1.0",
      developmentBenchmark: digestOf("d"),
      promotionBenchmark: sealedDigest,
    },
  });
}

describe("checkExploringEntry (product §5.2, §6.3)", () => {
  it("admits a committed, unrevealed after-run Benchmark that binds to the campaign", () => {
    const sealed = benchmark({ policy: "after-run" });
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: AFTER_RUN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission.promotionBenchmark).toBe(sealed.digest);
      expect(result.admission.coverage).toEqual({ revealed: 0, committed: 2 });
    }
  });

  it("admits a scheduled Benchmark only strictly before its notBefore instant", () => {
    const sealed = benchmark({ policy: "scheduled", notBefore: "2026-09-01T00:00:00Z" });
    expect(checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: { kind: "scheduled", trustedAtTime: "2026-08-03T00:00:00Z" },
    }).ok).toBe(true);
    const opened = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: { kind: "scheduled", trustedAtTime: "2026-09-01T00:00:00Z" },
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe("reveal-window-open");
  });

  it("refuses an immediate-reveal Benchmark — that is a published slate, not a commitment", () => {
    const sealed = benchmark({ policy: "immediate" });
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: AFTER_RUN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-committed");
  });

  it("refuses a reveal context that does not match the record's declared policy", () => {
    const sealed = benchmark({ policy: "after-run" });
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: { kind: "scheduled", trustedAtTime: "2026-08-03T00:00:00Z" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reveal-context-mismatch");
  });

  it("refuses a scheduled Benchmark when the trusted instant is uninterpretable", () => {
    const sealed = benchmark({ policy: "scheduled", notBefore: "2026-09-01T00:00:00Z" });
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: { kind: "scheduled", trustedAtTime: "yesterday" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reveal-context-mismatch");
  });

  it("refuses a scheduled Benchmark with no notBefore — a schedule with no instant is no commitment", () => {
    const sealed = benchmark({ policy: "scheduled" });
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: { kind: "scheduled", trustedAtTime: "2026-08-03T00:00:00Z" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-committed");
  });

  it("refuses bytes that do not digest to the campaign's promotionBenchmark", () => {
    const sealed = benchmark({ policy: "after-run" });
    const result = checkExploringEntry(campaignFor(digestOf("f")), {
      benchmarkBytes: sealed.bytes,
      revealContext: AFTER_RUN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("digest-mismatch");
  });

  it("refuses bytes that are not a Benchmark record at all", () => {
    const result = checkExploringEntry(campaignFor(digestOf("f")), {
      benchmarkBytes: new TextEncoder().encode("{}"),
      revealContext: AFTER_RUN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-benchmark");
  });

  it("refuses an empty Benchmark and one with duplicate items", () => {
    const empty = benchmark({ policy: "after-run" }, []);
    const emptyResult = checkExploringEntry(campaignFor(empty.digest), {
      benchmarkBytes: empty.bytes, revealContext: AFTER_RUN,
    });
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) expect(emptyResult.reason).toBe("invalid-benchmark");

    const duplicated = benchmark({ policy: "after-run" }, [itemDigest, itemDigest]);
    const duplicateResult = checkExploringEntry(campaignFor(duplicated.digest), {
      benchmarkBytes: duplicated.bytes, revealContext: AFTER_RUN,
    });
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.reason).toBe("invalid-benchmark");
  });

  it("refuses a Benchmark any of whose items the caller can already show revealed", () => {
    const sealed = benchmark({ policy: "after-run" });
    const revealedBytes = new TextEncoder().encode("x");
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: AFTER_RUN,
      // The bytes do not hash to the committed digest, so this is the tampering leg of
      // `reveal-consistency` rather than an honest reveal — either way the gate is contaminated.
      revealed: new Map([[itemDigest, revealedBytes]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already-revealed");
  });

  it("refuses when the caller can produce bytes that genuinely match a committed item digest", () => {
    const bytes = new TextEncoder().encode("the revealed task");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sealed = benchmark({ policy: "after-run" }, [digest, otherItemDigest]);
    const result = checkExploringEntry(campaignFor(sealed.digest), {
      benchmarkBytes: sealed.bytes,
      revealContext: AFTER_RUN,
      revealed: new Map([[digest, bytes]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already-revealed");
  });
});
