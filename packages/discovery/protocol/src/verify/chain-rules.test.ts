import { describe, it, expect } from "vitest";
import type { AnnouncementEntry } from "../entry.js";
import { RECORD_DISCOVERY_VERSION, GENESIS_SEQUENCE } from "../identifiers.js";
import { checkGlobalChainRules, digestEntries, walkLinkage } from "./chain-rules.js";

// Direct, protocol-local unit coverage of the pure structural chain rules
// (design §5.3) ahead of `source-chain.ts`'s full I/O-adjacent orchestration
// (which is exercised exhaustively by `discovery/testing`'s §18 golden-
// vector corpus via `runSourceChainConformance`, plan Task 12). Kept local
// -- rather than devDependency-importing the testing kit into protocol --
// because protocol and testing have a genuine mutual dependency
// (testing -> protocol as a production dependency, per the M3 plan) and
// this repo's standalone-per-package-project + `portal:` mechanics (no
// repo-root workspace, Global Constraints) cannot link a devDependency
// portal running the other direction: `yarn install` inside `protocol`
// after adding `record-discovery-testing` as a devDependency fails with
// `Error: Assertion failed: Writing attempt prevented to
// .../testing/node_modules/@jinn-network/record-discovery-protocol which
// is outside project root: .../protocol` -- yarn's node-modules linker
// will not resolve a portal cycle between two independent (non-workspace)
// projects. This mirrors the evidence tree's own precedent (`evidence-
// protocol` carries zero Jinn dependencies; its conformance-driving tests
// live entirely in `evidence-testing`) and matches Task 12's own
// "Verification gate (M4 complete)" wording, which already names testing's
// `protocol-conformance.test.ts` -- not a new protocol-side file -- as the
// green target. Recorded as a finding, not a silent deviation.

const AGENT = "did:key:zAgentSourceOne";

function entry(overrides: Partial<AnnouncementEntry> & { sequence: string; previous: `sha256:${string}` | null }): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: "feed" },
    timestamp: "2026-07-28T12:00:00Z",
    announcements: [
      {
        announcementId: `ann-${overrides.sequence}`,
        action: "available",
        record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
      },
    ],
    ...overrides,
  };
}

describe("checkGlobalChainRules", () => {
  it("accepts a clean linear chain", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const [genesisDigested] = digestEntries([genesis]);
    const child = entry({ sequence: "0000000000000002", previous: genesisDigested!.digest });
    expect(checkGlobalChainRules(digestEntries([genesis, child]))).toBeUndefined();
  });

  it("rejects two distinct entries both claiming previous === null", () => {
    const genesisA = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const genesisB = entry({
      sequence: GENESIS_SEQUENCE,
      previous: null,
      announcements: [
        { announcementId: "ann-genesis-b", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"b".repeat(64)}` } },
      ],
    });
    expect(checkGlobalChainRules(digestEntries([genesisA, genesisB]))).toEqual({ kind: "duplicate-genesis" });
  });

  it("rejects two distinct signed children of the same entry (fork, §5.3 rule 2)", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const [genesisDigested] = digestEntries([genesis]);
    const childA = entry({
      sequence: "0000000000000002",
      previous: genesisDigested!.digest,
      announcements: [{ announcementId: "ann-2a", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` } }],
    });
    const childB = entry({
      sequence: "0000000000000002",
      previous: genesisDigested!.digest,
      announcements: [{ announcementId: "ann-2b", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"b".repeat(64)}` } }],
    });
    const failure = checkGlobalChainRules(digestEntries([genesis, childA, childB]));
    expect(failure?.kind).toBe("forked");
  });

  it("rejects a source-wide duplicate announcementId across entries", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null, announcements: [{ announcementId: "ann-shared", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` } }] });
    const [genesisDigested] = digestEntries([genesis]);
    const child = entry({ sequence: "0000000000000002", previous: genesisDigested!.digest, announcements: [{ announcementId: "ann-shared", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"b".repeat(64)}` } }] });
    expect(checkGlobalChainRules(digestEntries([genesis, child]))).toEqual({ kind: "duplicate-announcement-id", announcementId: "ann-shared" });
  });

  it("rejects a withdrawal retracting an announcementId this source never announced available", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const [genesisDigested] = digestEntries([genesis]);
    const withdrawal = entry({
      sequence: "0000000000000002",
      previous: genesisDigested!.digest,
      announcements: [{ announcementId: "ann-2", action: "withdrawn", retracts: "ann-never-announced", reason: "delisted" }],
    });
    expect(checkGlobalChainRules(digestEntries([genesis, withdrawal]))).toEqual({
      kind: "foreign-retraction",
      announcementId: "ann-2",
    });
  });

  it("rejects a withdrawal-of-a-withdrawal", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null, announcements: [{ announcementId: "ann-1", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` } }] });
    const [genesisDigested] = digestEntries([genesis]);
    const first = entry({ sequence: "0000000000000002", previous: genesisDigested!.digest, announcements: [{ announcementId: "ann-2", action: "withdrawn", retracts: "ann-1", reason: "delisted" }] });
    const [, firstDigested] = digestEntries([genesis, first]);
    const second = entry({ sequence: "0000000000000003", previous: firstDigested!.digest, announcements: [{ announcementId: "ann-3", action: "withdrawn", retracts: "ann-2", reason: "delisted" }] });
    expect(checkGlobalChainRules(digestEntries([genesis, first, second]))).toEqual({
      kind: "withdrawal-of-withdrawal",
      announcementId: "ann-3",
    });
  });
});

describe("walkLinkage", () => {
  it("walks a linear chain to genesis on first adoption", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const [genesisDigested] = digestEntries([genesis]);
    const child = entry({ sequence: "0000000000000002", previous: genesisDigested!.digest });
    const digested = digestEntries([genesis, child]);
    const byDigest = new Map(digested.map((d) => [d.digest, d] as const));
    const result = walkLinkage({ byDigest, headEntryDigest: digested[1]!.digest, stopAtDigest: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.walked.map((d) => d.entry.sequence)).toEqual(["0000000000000002", GENESIS_SEQUENCE]);
  });

  it("fails with linkage when the head's entry is not resolvable", () => {
    const byDigest = new Map<string, ReturnType<typeof digestEntries>[number]>();
    const result = walkLinkage({ byDigest, headEntryDigest: `sha256:${"c".repeat(64)}`, stopAtDigest: undefined });
    expect(result).toEqual({ ok: false, failure: { kind: "linkage" } });
  });

  it("fails with sequence-contiguity when previous links but the sequence does not increment by one", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const [genesisDigested] = digestEntries([genesis]);
    const child = entry({ sequence: "0000000000000003", previous: genesisDigested!.digest }); // gap: 1 -> 3
    const digested = digestEntries([genesis, child]);
    const byDigest = new Map(digested.map((d) => [d.digest, d] as const));
    const result = walkLinkage({ byDigest, headEntryDigest: digested[1]!.digest, stopAtDigest: undefined });
    expect(result).toEqual({ ok: false, failure: { kind: "sequence-contiguity" } });
  });

  it("stops at the high-water mark for a returning consumer without walking to genesis", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const [genesisDigested] = digestEntries([genesis]);
    const middle = entry({ sequence: "0000000000000002", previous: genesisDigested!.digest });
    const [, middleDigested] = digestEntries([genesis, middle]);
    const head = entry({ sequence: "0000000000000003", previous: middleDigested!.digest });
    const digested = digestEntries([genesis, middle, head]);
    const byDigest = new Map(digested.map((d) => [d.digest, d] as const));
    const result = walkLinkage({ byDigest, headEntryDigest: digested[2]!.digest, stopAtDigest: middleDigested!.digest });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.walked.map((d) => d.entry.sequence)).toEqual(["0000000000000003", "0000000000000002"]);
  });

  it("fails with linkage for a returning consumer whose high-water mark is never reached (rollback)", () => {
    const genesis = entry({ sequence: GENESIS_SEQUENCE, previous: null });
    const digested = digestEntries([genesis]);
    const byDigest = new Map(digested.map((d) => [d.digest, d] as const));
    const result = walkLinkage({ byDigest, headEntryDigest: digested[0]!.digest, stopAtDigest: `sha256:${"f".repeat(64)}` });
    expect(result).toEqual({ ok: false, failure: { kind: "linkage" } });
  });

  it("fails with entry-ceiling when an announcement's facts card seals to more than CEILINGS.factsCardBytes (§5.1, MINOR fix)", () => {
    const genesis = entry({
      sequence: GENESIS_SEQUENCE,
      previous: null,
      announcements: [
        {
          announcementId: "ann-oversized-facts",
          action: "available",
          record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
          facts: { blob: "x".repeat(4200) }, // seals to > 4 KiB
        },
      ],
    });
    const digested = digestEntries([genesis]);
    const byDigest = new Map(digested.map((d) => [d.digest, d] as const));
    const result = walkLinkage({ byDigest, headEntryDigest: digested[0]!.digest, stopAtDigest: undefined });
    expect(result).toEqual({ ok: false, failure: { kind: "entry-ceiling" } });
  });

  it("accepts an announcement whose facts card seals within CEILINGS.factsCardBytes", () => {
    const genesis = entry({
      sequence: GENESIS_SEQUENCE,
      previous: null,
      announcements: [
        {
          announcementId: "ann-small-facts",
          action: "available",
          record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
          facts: { blob: "x".repeat(10) },
        },
      ],
    });
    const digested = digestEntries([genesis]);
    const byDigest = new Map(digested.map((d) => [d.digest, d] as const));
    const result = walkLinkage({ byDigest, headEntryDigest: digested[0]!.digest, stopAtDigest: undefined });
    expect(result.ok).toBe(true);
  });
});
