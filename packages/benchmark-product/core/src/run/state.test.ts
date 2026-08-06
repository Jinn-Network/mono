import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentIriSchema } from "@jinn-network/benchmarking-records";
import { runStatePath } from "../workspace/layout.js";
import {
  deriveRunOwner,
  deterministicUuidUri,
  readRunState,
  requireRunState,
  specDigest,
  writeRunState,
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
