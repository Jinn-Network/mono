import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealBenchmark } from "@jinn-network/benchmarking-records";
import { sealCampaign } from "./campaign.js";
import { PolicyOptimizationError } from "./errors.js";
import { journalEntryText } from "./journal-entry.js";
import {
  appendCampaignEvent,
  createCampaign,
  openCampaign,
} from "./journal-store.js";
import { CAMPAIGN_DOCUMENT_FILENAME, CAMPAIGN_JOURNAL_FILENAME } from "./tokens.js";
import type { CampaignDocument, SeedResolution } from "./types.js";
import { campaignWith, digestOf, SEED_TUPLE, SEED_TUPLE_DIGEST } from "./testing/campaign-fixtures.js";

const seeds: SeedResolution[] = [{ kind: "tuple", digest: SEED_TUPLE_DIGEST, tuple: SEED_TUPLE }];

const promotionBenchmark = sealBenchmark({
  protocol: "https://jinn.network/protocols/benchmarking/1.0",
  name: "promotion",
  description: "held-out promotion gate",
  version: "1.0.0",
  items: [{ task: { digest: { sha256: "a".repeat(64) } } }],
  reveal: { policy: "after-run" },
});

function campaign(): CampaignDocument {
  return campaignWith({
    target: {
      taskProfile: "https://profiles.jinn.network/repository-work/1.0",
      developmentBenchmark: digestOf("d"),
      promotionBenchmark: promotionBenchmark.digest,
    },
  });
}

const exploringEntry = {
  benchmarkBytes: promotionBenchmark.bytes,
  revealContext: { kind: "after-run", trustedRunNotClosed: true },
} as const;

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jinn-campaign-journal-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function created() {
  return createCampaign({
    directory,
    campaign: campaign(),
    seedResolutions: seeds,
    createdAt: "2026-08-03T00:00:00Z",
  });
}

describe("createCampaign", () => {
  it("writes the sealed document and opens the journal with `created` at seq 1", () => {
    const handle = created();
    expect(handle.digest).toBe(sealCampaign(campaign(), seeds).digest);
    expect(handle.state).toMatchObject({ phase: "DRAFT", entries: 1, nextSeq: 2 });
    expect(handle.entries[0]?.type).toBe("created");
    expect(handle.entries[0]?.previous).toBeNull();
    expect(new Uint8Array(readFileSync(join(directory, CAMPAIGN_DOCUMENT_FILENAME))))
      .toEqual(sealCampaign(campaign(), seeds).bytes);
    expect(readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8").split("\n").filter(Boolean))
      .toHaveLength(1);
  });

  it("is idempotent for the same campaign and refuses a different one", () => {
    const first = created();
    const again = created();
    expect(again.entries).toEqual(first.entries);
    expect(again.state).toEqual(first.state);
    expect(() => createCampaign({
      directory,
      campaign: campaignWith({
        target: {
          taskProfile: "https://profiles.jinn.network/repository-work/1.0",
          developmentBenchmark: digestOf("7"),
          promotionBenchmark: promotionBenchmark.digest,
        },
      }),
      seedResolutions: seeds,
      createdAt: "2026-08-03T00:00:00Z",
    })).toThrowError(/different campaign/);
  });

  it("finishes a directory whose document was written before the process died", () => {
    // The one non-atomic window in this package: document written, first journal line not yet
    // appended. Re-running `createCampaign` resumes it rather than stranding the directory.
    const sealed = sealCampaign(campaign(), seeds);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, CAMPAIGN_DOCUMENT_FILENAME), sealed.bytes);
    expect(openCampaign(directory).entries).toHaveLength(0);
    expect(created().state).toMatchObject({ phase: "DRAFT", entries: 1, nextSeq: 2 });
  });

  it("refuses a campaign whose seeds disagree with its frozen axes", () => {
    expect(() => createCampaign({
      directory,
      campaign: campaign(),
      seedResolutions: [],
      createdAt: "2026-08-03T00:00:00Z",
    })).toThrowError(/seeds\.0/);
  });
});

describe("openCampaign — restart recovery (product §5.2)", () => {
  it("resumes exactly where a mid-lifecycle campaign left off", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z",
      payload: { tupleDigest: SEED_TUPLE_DIGEST },
    });
    handle = appendCampaignEvent(handle, {
      seq: 3, type: "wave-planned", recordedAt: "2026-08-03T02:00:00Z", payload: { wave: 1 },
    }, { exploringEntry });
    handle = appendCampaignEvent(handle, {
      seq: 4, type: "allocation-decided", recordedAt: "2026-08-03T03:00:00Z",
      payload: { consumedReports: [] },
    });

    const reopened = openCampaign(directory);
    expect(reopened.state).toEqual(handle.state);
    expect(reopened.state.phase).toBe("EXPLORING");
    expect(reopened.digest).toBe(handle.digest);
    expect(reopened.entries).toEqual(handle.entries);
    // The resumed handle takes the next append without any replay of what came before.
    expect(appendCampaignEvent(reopened, {
      seq: reopened.state.nextSeq, type: "run-sealed", recordedAt: "2026-08-03T04:00:00Z",
    }).state.entries).toBe(5);
  });

  it("refuses a journal whose chain was rewritten between restarts", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
    });
    handle = appendCampaignEvent(handle, {
      seq: 3, type: "candidate-rejected", recordedAt: "2026-08-03T02:00:00Z", payload: { a: 1 },
    });
    const lines = readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8").split("\n").filter(Boolean);
    // The middle entry is rewritten to record a different decision. Its successor still carries the
    // old entry's digest as `previous`, so the chain no longer joins.
    const tampered = journalEntryText({ ...handle.entries[1]!, payload: { a: 2 } });
    writeFileSync(
      join(directory, CAMPAIGN_JOURNAL_FILENAME),
      `${lines[0]}\n${tampered}\n${lines[2]}\n`,
    );
    expect(() => openCampaign(directory)).toThrowError(/previous|chain/i);
  });

  it("does not claim to detect a rewritten tail — the chain protects entries that have successors", () => {
    // Stated as a test rather than left implicit: the last entry has nothing chained to it, so a
    // host that rewrites only the tail produces a journal that opens cleanly. Detecting that needs
    // an external commitment (an anchor, a signature), which v0 has by design nowhere (product §11).
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
    });
    const lines = readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8").split("\n").filter(Boolean);
    const rewritten = journalEntryText({ ...handle.entries[1]!, payload: { a: 2 } });
    writeFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), `${lines[0]}\n${rewritten}\n`);
    expect(openCampaign(directory).entries[1]?.payload).toEqual({ a: 2 });
  });

  it("refuses a journal with a sequence gap", () => {
    const handle = created();
    const line = journalEntryText({
      ...handle.entries[0]!,
      seq: 3,
      previous: digestOf("1"),
      type: "candidate-admitted",
    });
    writeFileSync(
      join(directory, CAMPAIGN_JOURNAL_FILENAME),
      `${journalEntryText(handle.entries[0]!)}\n${line}\n`,
    );
    expect(() => openCampaign(directory)).toThrowError(/seq/);
  });

  it("refuses a journal whose entries name a different campaign", () => {
    const handle = created();
    writeFileSync(
      join(directory, CAMPAIGN_JOURNAL_FILENAME),
      `${journalEntryText({ ...handle.entries[0]!, campaign: digestOf("9") })}\n`,
    );
    expect(() => openCampaign(directory)).toThrowError(/campaign/);
  });

  it("refuses a directory with no sealed campaign document", () => {
    expect(() => openCampaign(directory)).toThrowError(/campaign\.json/);
  });
});

describe("appendCampaignEvent — idempotent replay and conflicting replay (product §5.2)", () => {
  it("treats a byte-identical replay as a no-op", () => {
    let handle = created();
    const input = {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
    } as const;
    handle = appendCampaignEvent(handle, input);
    const before = readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8");
    const replayed = appendCampaignEvent(handle, input);
    expect(replayed.state).toEqual(handle.state);
    expect(readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8")).toBe(before);
  });

  it("replays from a stale handle without duplicating the decision", () => {
    // The crash case: the entry landed on disk, the caller never saw the returned handle.
    const stale = created();
    const input = {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
    } as const;
    appendCampaignEvent(stale, input);
    const replayed = appendCampaignEvent(openCampaign(directory), input);
    expect(replayed.state.entries).toBe(2);
  });

  it("refuses a replay that disagrees with the entry already recorded at that sequence", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
    });
    try {
      appendCampaignEvent(handle, {
        seq: 2, type: "candidate-rejected", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyOptimizationError);
      expect((error as PolicyOptimizationError).category).toBe("journal-conflict");
    }
  });

  it("refuses a stale handle whose journal another writer has moved on (MAJOR-1)", () => {
    const a = created();
    const b = openCampaign(directory);
    appendCampaignEvent(a, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z", payload: { a: 1 },
    });
    const afterA = readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8");

    try {
      appendCampaignEvent(b, {
        seq: 2, type: "candidate-rejected", recordedAt: "2026-08-03T01:30:00Z", payload: { b: 1 },
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyOptimizationError);
      expect((error as PolicyOptimizationError).category).toBe("journal-conflict");
    }

    // The file is untouched and still opens: the stale write would otherwise have landed a line
    // whose `previous` and `seq` both disagree with what precedes it, wedging every future open.
    expect(readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8")).toBe(afterA);
    const reopened = openCampaign(directory);
    expect(reopened.state.entries).toBe(2);
    expect(reopened.entries[1]?.type).toBe("candidate-admitted");
  });

  it("refuses a stale handle even when it would append a legal next sequence", () => {
    const a = created();
    const b = openCampaign(directory);
    appendCampaignEvent(a, { seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z" });
    // B still believes it holds one entry, so its `seq` 2 looks like the next one to B alone.
    expect(() => appendCampaignEvent(b, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T02:00:00Z",
    })).toThrowError(/journal on disk holds 2/);
    expect(openCampaign(directory).state.entries).toBe(2);
  });

  it("refuses a sequence gap", () => {
    const handle = created();
    expect(() => appendCampaignEvent(handle, {
      seq: 4, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z",
    })).toThrowError(/seq/);
  });

  it("refuses an entry recorded before its predecessor", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T05:00:00Z",
    });
    expect(() => appendCampaignEvent(handle, {
      seq: 3, type: "candidate-rejected", recordedAt: "2026-08-03T04:00:00Z",
    })).toThrowError(/recordedAt/);
  });
});

describe("appendCampaignEvent — lifecycle guards (product §5.2, §6.3)", () => {
  it("refuses DRAFT → EXPLORING without an admission for the promotion Benchmark", () => {
    const handle = created();
    try {
      appendCampaignEvent(handle, { seq: 2, type: "wave-planned", recordedAt: "2026-08-03T01:00:00Z" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as PolicyOptimizationError).category).toBe("promotion-benchmark");
    }
  });

  it("refuses DRAFT → EXPLORING when the promotion Benchmark is already revealed", () => {
    const handle = created();
    expect(() => appendCampaignEvent(handle, {
      seq: 2, type: "wave-planned", recordedAt: "2026-08-03T01:00:00Z",
    }, {
      exploringEntry: {
        ...exploringEntry,
        revealed: new Map([["a".repeat(64), new TextEncoder().encode("a".repeat(64))]]),
      },
    })).toThrowError(/revealed/);
  });

  it("does not demand an admission for events that stay inside DRAFT", () => {
    const handle = created();
    expect(appendCampaignEvent(handle, {
      seq: 2, type: "candidate-admitted", recordedAt: "2026-08-03T01:00:00Z",
    }).state.phase).toBe("DRAFT");
  });

  it("refuses an EXPLORING-only event while still in DRAFT", () => {
    const handle = created();
    expect(() => appendCampaignEvent(handle, {
      seq: 2, type: "report-recorded", recordedAt: "2026-08-03T01:00:00Z",
    })).toThrowError(/DRAFT/);
  });

  it("admits exactly one promotion-run-sealed", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "wave-planned", recordedAt: "2026-08-03T01:00:00Z",
    }, { exploringEntry });
    handle = appendCampaignEvent(handle, {
      seq: 3, type: "promotion-run-sealed", recordedAt: "2026-08-03T02:00:00Z",
    });
    expect(handle.state.phase).toBe("CONFIRMING");
    expect(() => appendCampaignEvent(handle, {
      seq: 4, type: "promotion-run-sealed", recordedAt: "2026-08-03T03:00:00Z",
    })).toThrowError(/CONFIRMING/);
  });

  it("admits no new candidates, allocations, or dev Runs in CONFIRMING", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "wave-planned", recordedAt: "2026-08-03T01:00:00Z",
    }, { exploringEntry });
    handle = appendCampaignEvent(handle, {
      seq: 3, type: "promotion-run-sealed", recordedAt: "2026-08-03T02:00:00Z",
    });
    for (const type of ["candidate-admitted", "allocation-decided", "run-sealed", "wave-planned"] as const) {
      expect(() => appendCampaignEvent(handle, {
        seq: 4, type, recordedAt: "2026-08-03T03:00:00Z",
      })).toThrowError(/CONFIRMING/);
    }
    expect(appendCampaignEvent(handle, {
      seq: 4, type: "report-recorded", recordedAt: "2026-08-03T03:00:00Z",
    }).state.phase).toBe("CONFIRMING");
  });

  it("refuses every append after `closed`, including a second `closed`", () => {
    let handle = created();
    handle = appendCampaignEvent(handle, {
      seq: 2, type: "closed", recordedAt: "2026-08-03T01:00:00Z", payload: { reason: "stopping rule" },
    });
    expect(handle.state.phase).toBe("CLOSED");
    for (const type of ["closed", "report-recorded", "candidate-admitted"] as const) {
      expect(() => appendCampaignEvent(handle, {
        seq: 3, type, recordedAt: "2026-08-03T02:00:00Z",
      })).toThrowError(/CLOSED/);
    }
    // Replay of an entry already recorded stays a no-op even after closing.
    expect(appendCampaignEvent(handle, {
      seq: 2, type: "closed", recordedAt: "2026-08-03T01:00:00Z", payload: { reason: "stopping rule" },
    }).state.entries).toBe(2);
  });

  it("refuses `created` anywhere but seq 1", () => {
    const handle = created();
    expect(() => appendCampaignEvent(handle, {
      seq: 2, type: "created", recordedAt: "2026-08-03T01:00:00Z",
    })).toThrowError(/created/);
  });

  it("leaves the journal untouched when an append refuses", () => {
    const handle = created();
    const before = readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8");
    expect(() => appendCampaignEvent(handle, {
      seq: 2, type: "report-recorded", recordedAt: "2026-08-03T01:00:00Z",
    })).toThrow();
    expect(readFileSync(join(directory, CAMPAIGN_JOURNAL_FILENAME), "utf8")).toBe(before);
  });
});
