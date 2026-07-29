import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { documentDigest } from "../hashing.js";
import { BenchmarkRecordSchema } from "./schema.js";
import {
  checkComparability,
  checkItemDistinctness,
  checkJudgeability,
  classifyVersionBump,
} from "./checks.js";

function loadRecord(name: string) {
  const url = new URL(`../../fixtures/benchmark/${name}`, import.meta.url);
  return BenchmarkRecordSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}

const DIGEST_A = "7afaa346b4bf92bf9dc21e9ae809887412a86beb766842e99df7fee6573a4781";
const DIGEST_B = "78686d2704d4d6900bb73f4941aa661a26a09f4346ab5e83281c0a18830ad1dd";
const DIGEST_C = "1724980aa084bbaa16a8a69b664b783799bc75f8abe13ffc65b76843564fbbff";

function benchmarkWith(items: string[], overrides: Record<string, unknown> = {}) {
  return BenchmarkRecordSchema.parse({
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    name: "n",
    description: "d",
    version: "1.0.0",
    items: items.map((digest) => ({ task: { digest: { sha256: digest } } })),
    reveal: { policy: "immediate" },
    ...overrides,
  });
}

describe("checkItemDistinctness", () => {
  test("passes over the valid fixture (distinct items)", () => {
    expect(checkItemDistinctness(loadRecord("valid.json"))).toEqual({ ok: true });
  });

  test("fails over the duplicate-item fixture, naming the duplicate digest", () => {
    expect(checkItemDistinctness(loadRecord("invalid-duplicate-item.json"))).toEqual({
      ok: false,
      duplicate: DIGEST_A,
    });
  });
});

describe("checkJudgeability", () => {
  test("reports unevaluated (committed-not-revealed) when no taskBytesResolver is given", () => {
    const rec = benchmarkWith([DIGEST_A], { reveal: { policy: "scheduled" } });
    expect(checkJudgeability(rec)).toEqual({ status: "unevaluated", reason: "committed-not-revealed" });
  });

  function validTaskBytes(instructions = "do it"): Uint8Array {
    return sealTask({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: { digest: { sha256: DIGEST_B } },
      instructions,
      outputs: [],
      evaluation: { digest: { sha256: DIGEST_C } },
    });
  }

  function bareDigest(bytes: Uint8Array): string {
    return documentDigest(bytes).slice("sha256:".length);
  }

  test("reports known invalidity together with unresolved coverage", () => {
    const validBytes = validTaskBytes();
    const invalidBytes = new TextEncoder().encode("{not-json");
    const badDigest = DIGEST_A;
    const invalidDigest = bareDigest(invalidBytes);
    const rec = benchmarkWith([badDigest, invalidDigest, DIGEST_C], { reveal: { policy: "scheduled" } });
    const result = checkJudgeability(rec, (digest) => (
      digest === badDigest ? validBytes
        : digest === invalidDigest ? invalidBytes
          : undefined
    ));
    expect(result).toEqual({
      ok: false,
      invalid: [
        { taskDigest: badDigest, reason: "digest-mismatch" },
        { taskDigest: invalidDigest, reason: "invalid-task" },
      ],
      unresolved: [DIGEST_C],
    });
  });

  test("passes only when exact committed Task bytes are valid and carry a digest-bearing evaluation descriptor", () => {
    const first = validTaskBytes("first");
    const second = validTaskBytes("second");
    const rec = benchmarkWith([bareDigest(first), bareDigest(second)]);
    expect(checkJudgeability(rec, (digest) => digest === bareDigest(first) ? first : second)).toEqual({ ok: true });
  });

  test("rejects a valid sealed Task whose evaluation descriptor has no canonical sha256 digest", () => {
    const taskBytes = sealTask({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: { digest: { sha256: DIGEST_B } },
      instructions: "do it",
      outputs: [],
      evaluation: { uri: "https://example.test/evaluation" },
    });
    const digest = bareDigest(taskBytes);
    expect(checkJudgeability(benchmarkWith([digest]), () => taskBytes)).toEqual({
      ok: false,
      invalid: [{ taskDigest: digest, reason: "missing-evaluation-digest" }],
      unresolved: [],
    });
  });

  test("rejects schema-valid Task JSON that was not sealed as exact canonical bytes", () => {
    const sealed = validTaskBytes();
    const prettyBytes = new TextEncoder().encode(
      `${JSON.stringify(JSON.parse(new TextDecoder().decode(sealed)), null, 2)}\n`,
    );
    const digest = bareDigest(prettyBytes);
    expect(checkJudgeability(benchmarkWith([digest]), () => prettyBytes)).toEqual({
      ok: false,
      invalid: [{ taskDigest: digest, reason: "invalid-task" }],
      unresolved: [],
    });
  });
});

describe("classifyVersionBump", () => {
  test("patch: identical item digest set, metadata differs", () => {
    const prev = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.0.0", description: "old" });
    const next = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.0.1", description: "new" });
    expect(classifyVersionBump(prev, next)).toBe("patch");
  });

  test("minor: an item added, nothing removed", () => {
    const prev = benchmarkWith([DIGEST_A], { version: "1.0.0" });
    const next = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.1.0" });
    expect(classifyVersionBump(prev, next)).toBe("minor");
  });

  test("major: an item removed", () => {
    const prev = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.1.0" });
    const next = benchmarkWith([DIGEST_A], { version: "2.0.0" });
    expect(classifyVersionBump(prev, next)).toBe("major");
  });

  test("major: an item changed (old digest gone, new digest present)", () => {
    const prev = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.1.0" });
    const next = benchmarkWith([DIGEST_A, DIGEST_C], { version: "2.0.0" });
    expect(classifyVersionBump(prev, next)).toBe("major");
  });

  test("major: reordering existing items changes ordered identity", () => {
    const prev = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.0.0" });
    const next = benchmarkWith([DIGEST_B, DIGEST_A], { version: "2.0.0" });
    expect(classifyVersionBump(prev, next)).toBe("major");
  });

  test("major: inserting an item into the existing ordered sequence is not append-only", () => {
    const prev = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.0.0" });
    const next = benchmarkWith([DIGEST_A, DIGEST_C, DIGEST_B], { version: "2.0.0" });
    expect(classifyVersionBump(prev, next)).toBe("major");
  });

  test("major: changing an item descriptor hint changes the ordered item bytes even when its digest is unchanged", () => {
    const prev = benchmarkWith([DIGEST_A], { version: "1.0.0" });
    const next = BenchmarkRecordSchema.parse({
      ...prev,
      version: "2.0.0",
      items: [{
        task: {
          digest: { sha256: DIGEST_A },
          uri: "https://example.test/revealed/task-a.json",
        },
      }],
    });
    expect(classifyVersionBump(prev, next)).toBe("major");
  });
});

describe("checkComparability", () => {
  test("one shared digest: comparable", () => {
    expect(checkComparability([{ benchmarkDigest: "sha256:aa" }, { benchmarkDigest: "sha256:aa" }])).toEqual({
      ok: true,
    });
  });

  test("two distinct digests, not version-robust: not comparable", () => {
    expect(
      checkComparability([{ benchmarkDigest: "sha256:bb" }, { benchmarkDigest: "sha256:aa" }]),
    ).toEqual({ ok: false, digests: ["sha256:aa", "sha256:bb"] });
  });

  test("two distinct digests, version-robust method: comparable", () => {
    expect(
      checkComparability(
        [{ benchmarkDigest: "sha256:bb" }, { benchmarkDigest: "sha256:aa" }],
        { versionRobust: true },
      ),
    ).toEqual({ ok: true });
  });
});
