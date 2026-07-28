import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
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

  test("reports unevaluated when the resolver has bytes for some items but not others", () => {
    const rec = benchmarkWith([DIGEST_A, DIGEST_B], { reveal: { policy: "scheduled" } });
    const taskBytes = new TextEncoder().encode(JSON.stringify({ evaluation: { digest: { sha256: DIGEST_C } } }));
    const result = checkJudgeability(rec, (digest) => (digest === DIGEST_A ? taskBytes : undefined));
    expect(result).toEqual({ status: "unevaluated", reason: "committed-not-revealed" });
  });

  test("passes when every resolved Task carries an evaluation descriptor", () => {
    const rec = benchmarkWith([DIGEST_A, DIGEST_B]);
    const taskBytes = new TextEncoder().encode(JSON.stringify({ evaluation: { digest: { sha256: DIGEST_C } } }));
    expect(checkJudgeability(rec, () => taskBytes)).toEqual({ ok: true });
  });

  test("fails, naming unevaluated digests, when a resolved Task lacks an evaluation descriptor", () => {
    const rec = benchmarkWith([DIGEST_A, DIGEST_B]);
    const withEvaluation = new TextEncoder().encode(JSON.stringify({ evaluation: { digest: { sha256: DIGEST_C } } }));
    const withoutEvaluation = new TextEncoder().encode(JSON.stringify({ instructions: "do it" }));
    const result = checkJudgeability(rec, (digest) => (digest === DIGEST_A ? withoutEvaluation : withEvaluation));
    expect(result).toEqual({ ok: false, unevaluated: [DIGEST_A] });
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
