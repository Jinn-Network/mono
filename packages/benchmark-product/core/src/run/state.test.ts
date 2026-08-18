import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentIriSchema } from "@jinn-network/benchmarking-records";
import { runStatePath } from "../workspace/layout.js";
import {
  createPublicationState,
  deriveRunOwner,
  deterministicUuidUri,
  readRunState,
  requireRunState,
  specDigest,
  writeRunState,
  type PublicationState,
  type RunState,
} from "./state.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-state-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function minimalState(overrides: Partial<RunState> = {}): RunState {
  return {
    draftId: "draft-1",
    specSha256: "a".repeat(64),
    owner: "urn:uuid:00000000-0000-5000-8000-000000000001",
    ...overrides,
  };
}

describe("readRunState / writeRunState round trip", () => {
  test("returns undefined for a draft with no run state yet", () => {
    expect(readRunState(workspaceDir, "nope")).toBeUndefined();
  });

  test("write then read returns an equal document", () => {
    const state = minimalState({
      quote: { ok: true, expectedCellCount: 4, errors: [] },
      quotedAt: "2026-08-05T00:00:00Z",
    });
    writeRunState(workspaceDir, "draft-1", state);
    expect(readRunState(workspaceDir, "draft-1")).toEqual(state);
  });

  test("a second write overwrites the first (lock advancing the same draft's state)", () => {
    writeRunState(workspaceDir, "draft-1", minimalState());
    const locked = minimalState({ runSha256: "b".repeat(64), closeAt: "2026-08-06T00:00:00Z", lockedAt: "2026-08-05T00:01:00Z" });
    writeRunState(workspaceDir, "draft-1", locked);
    expect(readRunState(workspaceDir, "draft-1")).toEqual(locked);
  });

  test("requireRunState refuses not-found when absent", () => {
    expect(() => requireRunState(workspaceDir, "ghost")).toThrowError(/no run state/);
  });

  test("requireRunState returns the state when present", () => {
    const state = minimalState();
    writeRunState(workspaceDir, "draft-1", state);
    expect(requireRunState(workspaceDir, "draft-1")).toEqual(state);
  });

  test("writeRunState refuses validation on a malformed document", () => {
    expect(() =>
      writeRunState(workspaceDir, "draft-1", { draftId: "draft-1", specSha256: "not-hex", owner: "urn:uuid:x" }),
    ).toThrowError();
  });

  test("readRunState refuses validation on a corrupt on-disk file", () => {
    writeRunState(workspaceDir, "draft-1", minimalState());
    writeFileSync(runStatePath(workspaceDir, "draft-1"), "not json");
    expect(() => readRunState(workspaceDir, "draft-1")).toThrowError();
  });
});

describe("publication state migration", () => {
  test("adds independent Matrix v2 state without changing legacy Matrix state", () => {
    const publication = createPublicationState();
    expect(publication.accounting).toEqual({ state: "not-started" });
    expect(publication.matrixV2).toEqual({ state: "not-started" });
    const state = minimalState({ matrixSha256: "b".repeat(64), publication });
    writeRunState(workspaceDir, "draft-v2", state);
    expect(readRunState(workspaceDir, "draft-v2")?.matrixSha256).toBe("b".repeat(64));
    expect(readRunState(workspaceDir, "draft-v2")?.matrixV2Sha256).toBeUndefined();
  });

  test("reads a legacy report state without rewriting or inventing signed-v2 identities", () => {
    const path = runStatePath(workspaceDir, "draft-legacy");
    const legacy = {
      ...minimalState({ reportSha256: "b".repeat(64), reportEnvelopeSha256: "c".repeat(64) }),
    };
    const exact = JSON.stringify(legacy, null, 2);
    writeRunState(workspaceDir, "draft-legacy", minimalState());
    writeFileSync(path, exact);

    const read = readRunState(workspaceDir, "draft-legacy");
    expect(read?.reportSha256).toBe("b".repeat(64));
    expect(read?.reportEnvelopeSha256).toBe("c".repeat(64));
    expect(read?.reportPayloadSha256).toBeUndefined();
    expect(read?.reportRecordSha256).toBeUndefined();
    expect(read?.publication).toBeUndefined();
    expect(new TextDecoder().decode(readFileSync(path))).toBe(exact);
  });

  test("normalizes historical duplicate aliases while allowing independent signed-v2 identities", () => {
    const path = runStatePath(workspaceDir, "draft-aliases");
    writeRunState(workspaceDir, "draft-aliases", minimalState());
    writeFileSync(path, JSON.stringify({
      ...minimalState(),
      reportSha256: "b".repeat(64), reportEnvelopeSha256: "c".repeat(64),
      reportPayloadSha256: "b".repeat(64), reportRecordSha256: "c".repeat(64),
    }));
    const aliases = readRunState(workspaceDir, "draft-aliases");
    expect(aliases?.reportPayloadSha256).toBeUndefined();
    expect(aliases?.reportRecordSha256).toBeUndefined();
    expect(aliases).not.toHaveProperty("reportPayloadSha256");
    expect(aliases).not.toHaveProperty("reportRecordSha256");

    const publication = createPublicationState();
    publication.report = { state: "complete", receipt: { sourceSequence: "0001", entrySha256: "d".repeat(64) } };
    writeRunState(workspaceDir, "draft-v2", minimalState({ publication,
      reportSha256: "b".repeat(64), reportEnvelopeSha256: "c".repeat(64),
      reportPayloadSha256: "e".repeat(64), reportRecordSha256: "f".repeat(64),
    }));
    const v2 = readRunState(workspaceDir, "draft-v2");
    expect(v2?.reportSha256).toBe("b".repeat(64));
    expect(v2?.reportPayloadSha256).toBe("e".repeat(64));
  });

  test("makes source identity immutable after a receipt while leaving public URL mutable", () => {
    const publication = createPublicationState({ publicBaseUrl: "https://old.example/reports" });
    publication.registration = {
      state: "complete",
      receipt: { sourceSequence: "0001", entrySha256: "d".repeat(64) },
      digests: { run: "e".repeat(64) },
    };
    writeRunState(workspaceDir, "draft-1", minimalState({ publication }));
    const movedUrl = createPublicationState({ publicBaseUrl: "https://new.example/reports" });
    movedUrl.registration = publication.registration;
    writeRunState(workspaceDir, "draft-1", minimalState({ publication: movedUrl }));
    expect(readRunState(workspaceDir, "draft-1")?.publication?.source.publicBaseUrl).toBe("https://new.example/reports");

    const renamed = createPublicationState({ name: "another-source", publicBaseUrl: "https://new.example/reports" });
    renamed.registration = publication.registration;
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({ publication: renamed }))).toThrow(/immutable/);
  });

  test("forbids dropping and recreating publication state after a receipt", () => {
    const publication = createPublicationState();
    publication.registration = {
      state: "complete",
      receipt: { sourceSequence: "0001", entrySha256: "d".repeat(64) },
      digests: { run: "e".repeat(64) },
    };
    writeRunState(workspaceDir, "draft-1", minimalState({ publication }));
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState())).toThrow(/cannot be removed/);

    const recreated = createPublicationState({ name: "replacement-source" });
    recreated.registration = publication.registration;
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({ publication: recreated }))).toThrow(/immutable/);
    expect(readRunState(workspaceDir, "draft-1")?.publication?.source.name).toBe("colophon-benchmarks");
  });

  test("forbids receipt and established digest removal or mutation for every publication stage", () => {
    const publication = createPublicationState();
    const stageNames = ["registration", "accounting", "report"] as const;
    stageNames.forEach((stageName, index) => {
      publication[stageName] = {
        state: "complete",
        receipt: { sourceSequence: `000${index + 1}`, entrySha256: String(index + 1).repeat(64) },
        digests: { record: String(index + 4).repeat(64) },
      };
    });
    const stateWithReportV2 = (nextPublication: PublicationState) => minimalState({
      publication: nextPublication,
      reportPayloadSha256: "a".repeat(64),
      reportRecordSha256: "b".repeat(64),
    });
    writeRunState(workspaceDir, "draft-1", stateWithReportV2(publication));

    for (const stageName of stageNames) {
      const noReceipt = structuredClone(publication);
      delete noReceipt[stageName].receipt;
      expect(() => writeRunState(workspaceDir, "draft-1", stateWithReportV2(noReceipt)), stageName).toThrow(/receipt cannot be removed or changed/);

      const changedReceipt = structuredClone(publication);
      changedReceipt[stageName].receipt!.entrySha256 = "f".repeat(64);
      expect(() => writeRunState(workspaceDir, "draft-1", stateWithReportV2(changedReceipt)), stageName).toThrow(/receipt cannot be removed or changed/);

      const noDigest = structuredClone(publication);
      noDigest[stageName].digests = {};
      expect(() => writeRunState(workspaceDir, "draft-1", stateWithReportV2(noDigest)), stageName).toThrow(/digest cannot be removed or changed/);

      const changedDigest = structuredClone(publication);
      changedDigest[stageName].digests!.record = "f".repeat(64);
      expect(() => writeRunState(workspaceDir, "draft-1", stateWithReportV2(changedDigest)), stageName).toThrow(/digest cannot be removed or changed/);
    }
  });

  test("allows a public URL move and forward-only stage progress", () => {
    const publication = createPublicationState({ publicBaseUrl: "https://old.example" });
    publication.registration = {
      state: "complete",
      receipt: { sourceSequence: "0001", entrySha256: "d".repeat(64) },
      digests: { run: "e".repeat(64) },
    };
    writeRunState(workspaceDir, "draft-1", minimalState({ publication }));
    const advanced = structuredClone(publication);
    advanced.source.publicBaseUrl = "https://new.example";
    advanced.accounting = { state: "in-progress", digests: { observation: "a".repeat(64) } };
    writeRunState(workspaceDir, "draft-1", minimalState({ publication: advanced }));
    expect(readRunState(workspaceDir, "draft-1")?.publication).toMatchObject({
      source: { publicBaseUrl: "https://new.example" },
      accounting: { state: "in-progress" },
    });
  });
});

describe("deterministicUuidUri / deriveRunOwner", () => {
  test("is a pure function of its seed — same seed, same uuid", () => {
    const a = deterministicUuidUri("seed-1");
    const b = deterministicUuidUri("seed-1");
    expect(a).toBe(b);
  });

  test("different seeds yield different uuids", () => {
    expect(deterministicUuidUri("seed-1")).not.toBe(deterministicUuidUri("seed-2"));
  });

  test("produces a value AgentIriSchema (the platform Run record's owner type) accepts", () => {
    const owner = deriveRunOwner("2026-08-05T00:00:00Z", "draft-1");
    expect(owner.startsWith("urn:uuid:")).toBe(true);
    expect(AgentIriSchema.safeParse(owner).success).toBe(true);
  });

  test("deriveRunOwner is deterministic over (workspaceCreatedAt, draftId)", () => {
    const first = deriveRunOwner("2026-08-05T00:00:00Z", "draft-1");
    const second = deriveRunOwner("2026-08-05T00:00:00Z", "draft-1");
    expect(first).toBe(second);
    expect(deriveRunOwner("2026-08-05T00:00:00Z", "draft-2")).not.toBe(first);
  });
});

describe("specDigest", () => {
  test("is stable under key reordering (A2: unchanged content must not invalidate a quote)", () => {
    const a = specDigest({ name: "x", replicates: 1 } as never);
    const b = specDigest({ replicates: 1, name: "x" } as never);
    expect(a).toBe(b);
  });

  test("changes when content changes", () => {
    const a = specDigest({ name: "x", replicates: 1 } as never);
    const b = specDigest({ name: "y", replicates: 1 } as never);
    expect(a).not.toBe(b);
  });
});

describe("anchors — append-only (anchor-evidence design §5 rule 6, §7.1)", () => {
  const first = { subject: "lock" as const, provider: "https://p/1", recordSha256: "1".repeat(64) };
  const second = { subject: "matrix" as const, provider: "https://p/2", recordSha256: "2".repeat(64) };
  const upgraded = {
    subject: "lock" as const,
    provider: "https://p/1",
    recordSha256: "3".repeat(64),
    upgradesRecordSha256: first.recordSha256,
  };

  test("absent by default — a workspace that never anchored carries no field", () => {
    writeRunState(workspaceDir, "draft-1", minimalState());
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toBeUndefined();
  });

  test("entries may be appended", () => {
    writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first] }));
    writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first, second] }));
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toEqual([first, second]);
  });

  test("a recorded anchor cannot be removed", () => {
    writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first, second] }));
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first] })))
      .toThrowError(/cannot be removed/);
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState()))
      .toThrowError(/cannot be removed/);
  });

  test("a recorded anchor cannot be changed or reordered", () => {
    writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first, second] }));
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({
      anchors: [{ ...first, recordSha256: "9".repeat(64) }, second],
    }))).toThrowError(/cannot be changed or reordered/);
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [second, first] })))
      .toThrowError(/cannot be changed or reordered/);
  });

  test("the upgraded form of a pending proof is appended beside the record it upgrades", () => {
    writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first] }));
    writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first, upgraded] }));
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toEqual([first, upgraded]);
  });

  test("an upgrade must name an earlier recorded anchor, and never itself", () => {
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [upgraded] })))
      .toThrowError(/must name an earlier recorded anchor/);
    expect(() => writeRunState(workspaceDir, "draft-2", minimalState({
      anchors: [{ ...first, upgradesRecordSha256: first.recordSha256 }],
    }))).toThrowError(/cannot upgrade itself/);
  });

  test("the same anchor record is never recorded twice", () => {
    expect(() => writeRunState(workspaceDir, "draft-1", minimalState({ anchors: [first, first] })))
      .toThrowError(/recorded twice/);
  });
});
