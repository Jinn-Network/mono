import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { documentDigest } from "../hashing.js";
import { BenchmarkRecordSchema, sealBenchmark } from "./schema.js";
import {
  checkBenchmarkPredecessor,
  checkBenchmarkTransition,
  checkComparability,
  checkItemDistinctness,
  checkJudgeability,
  classifyVersionBump,
  resolveBenchmarkTaskProvenance,
} from "./checks.js";

function loadRecord(name: string) {
  const url = new URL(`../../fixtures/benchmark/${name}`, import.meta.url);
  return BenchmarkRecordSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}

const DIGEST_A = "7afaa346b4bf92bf9dc21e9ae809887412a86beb766842e99df7fee6573a4781";
const DIGEST_B = "78686d2704d4d6900bb73f4941aa661a26a09f4346ab5e83281c0a18830ad1dd";
const DIGEST_C = "1724980aa084bbaa16a8a69b664b783799bc75f8abe13ffc65b76843564fbbff";

function benchmarkWith(items: readonly string[], overrides: Record<string, unknown> = {}) {
  return BenchmarkRecordSchema.parse({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
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
  test("fails closed with every unavailable digest when immediate Task bytes have no resolver", () => {
    const rec = benchmarkWith([DIGEST_A, DIGEST_B]);
    expect(checkJudgeability(rec)).toEqual({ ok: false, invalid: [], unresolved: [DIGEST_A, DIGEST_B] });
  });

  test("reports committed-not-revealed only strictly before a valid scheduled notBefore", () => {
    const rec = benchmarkWith([DIGEST_A], { reveal: { policy: "scheduled" } });
    const scheduled = benchmarkWith([DIGEST_A], { reveal: { policy: "scheduled", notBefore: "2026-07-29T00:00:00Z" } });
    expect(checkJudgeability(scheduled, () => undefined, { kind: "scheduled", trustedAtTime: "2026-07-28T23:59:59.999999999Z" }))
      .toEqual({ status: "unevaluated", reason: "committed-not-revealed", unresolved: [DIGEST_A], invalid: [] });
    expect(checkJudgeability(scheduled, () => undefined, { kind: "scheduled", trustedAtTime: "2026-07-29T00:00:00Z" }))
      .toEqual({ ok: false, invalid: [], unresolved: [DIGEST_A] });
    expect(checkJudgeability(rec, () => undefined)).toEqual({ ok: false, invalid: [], unresolved: [DIGEST_A] });
  });

  test("allows after-run committed-not-revealed only with an explicit trusted not-closed context", () => {
    const rec = benchmarkWith([DIGEST_A], { reveal: { policy: "after-run" } });
    expect(checkJudgeability(rec, () => undefined, { kind: "after-run", trustedRunNotClosed: true }))
      .toEqual({ status: "unevaluated", reason: "committed-not-revealed", unresolved: [DIGEST_A], invalid: [] });
    expect(checkJudgeability(rec, () => undefined)).toEqual({ ok: false, invalid: [], unresolved: [DIGEST_A] });
  });

  function validTaskBytes(
    instructions = "do it",
    timestamp = "2026-07-29T00:00:00Z",
  ): Uint8Array {
    return sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: {
        uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
        digest: { sha256: "829c28d91e324098739bcd6dfd3e32f7c6902efd737333c8f5659dc354a0475a" },
      },
      instructions,
      payload: {
        language: "TypeScript",
        provenance: { kind: "mined", source: "fixture-source", timestamp },
      },
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
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
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

  test("requires timestamp and exactly one plaintext source or lowercase sha256 source commitment", () => {
    const missingTimestamp = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1", profile: { digest: { sha256: DIGEST_B } },
      instructions: "do it", outputs: [], evaluation: { digest: { sha256: DIGEST_C } },
      payload: { provenance: { source: "fixture" } },
    });
    const digest = bareDigest(missingTimestamp);
    expect(checkJudgeability(benchmarkWith([digest]), () => missingTimestamp)).toEqual({
      ok: false, invalid: [{ taskDigest: digest, reason: "invalid-provenance" }], unresolved: [],
    });
  });

  // Packet P5 (issue #2837) acceptance assertion, spec §7.2: `paired-majority-delta@1` clusters
  // on `task-provenance-source`, which resolves through this exact gate. Every existing positive
  // test above (`validTaskBytes`) uses the PLAINTEXT `source` variant; this is the first positive
  // test of the `sourceCommitment` variant — the reshape §7.2's ratified option (A) put in place
  // (`sourceCommitment: "sha256:<64 hex>"` plus a calendar-strict `timestamp`) — the exact shape
  // the regenerated binary-judgment bank now carries. Asserted directly against the gate rather
  // than trusted by inspection: this is the payload shape a real judge item bank ships.
  test("accepts the regenerated bank's sourceCommitment+timestamp provenance shape (spec §7.2 option A), never a task-provenance-source-missing-shaped refusal", () => {
    const commitment = `sha256:${DIGEST_A}` as const;
    const bytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1", profile: { digest: { sha256: DIGEST_B } },
      instructions: "do it", outputs: [], evaluation: { digest: { sha256: DIGEST_C } },
      payload: { provenance: { sourceCommitment: commitment, timestamp: "2026-07-29T00:00:00Z" } },
    });
    const digest = bareDigest(bytes);
    expect(resolveBenchmarkTaskProvenance(digest, () => bytes)).toEqual({
      ok: true,
      provenance: { timestamp: "2026-07-29T00:00:00Z", cluster: { tag: "sourceCommitment", value: commitment } },
    });
    expect(checkJudgeability(benchmarkWith([digest]), () => bytes)).toEqual({ ok: true });
  });

  test("refuses a valid source accompanied by a malformed present sourceCommitment", () => {
    const bytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1", profile: { digest: { sha256: DIGEST_B } },
      instructions: "do it", outputs: [], evaluation: { digest: { sha256: DIGEST_C } },
      payload: { provenance: { source: "fixture", sourceCommitment: "not-a-digest", timestamp: "2026-07-29T00:00:00Z" } },
    });
    const digest = bareDigest(bytes);
    expect(resolveBenchmarkTaskProvenance(digest, () => bytes)).toEqual({ ok: false, reason: "invalid-provenance" });
  });

  test("refuses canonical bytes that are not a Task document", () => {
    const bytes = new TextEncoder().encode('{"payload":{"provenance":{"source":"x","timestamp":"2026-07-29T00:00:00Z"}}}');
    const digest = bareDigest(bytes);
    expect(resolveBenchmarkTaskProvenance(digest, () => bytes)).toEqual({ ok: false, reason: "invalid-task" });
  });

  test("rejects exact real-profile sealed Task bytes carrying an impossible civil provenance date", () => {
    const taskBytes = validTaskBytes("calendar-invalid", "2026-02-30T00:00:00Z");
    const digest = bareDigest(taskBytes);
    expect(checkJudgeability(benchmarkWith([digest]), () => taskBytes)).toEqual({
      ok: false,
      invalid: [{ taskDigest: digest, reason: "invalid-provenance" }],
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

describe("checkBenchmarkPredecessor", () => {
  test("binds supersedes to the exact canonical predecessor Benchmark bytes", () => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "1.0.0" }));
    const next = benchmarkWith([DIGEST_A, DIGEST_B], {
      version: "1.1.0",
      supersedes: { digest: { sha256: predecessor.digest.slice("sha256:".length) } },
    });
    expect(checkBenchmarkPredecessor(next, predecessor.bytes)).toEqual({ ok: true });
  });

  test("fails when supersedes names a different predecessor digest", () => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "1.0.0" }));
    const next = benchmarkWith([DIGEST_A, DIGEST_B], {
      version: "1.1.0",
      supersedes: { digest: { sha256: DIGEST_C } },
    });
    expect(checkBenchmarkPredecessor(next, predecessor.bytes)).toEqual({
      ok: false,
      reason: "digest-mismatch",
      expected: `sha256:${DIGEST_C}`,
      actual: predecessor.digest,
    });
  });

  test("fails closed when a successor omits its predecessor identity", () => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "1.0.0" }));
    const next = benchmarkWith([DIGEST_A, DIGEST_B], { version: "1.1.0" });
    expect(checkBenchmarkPredecessor(next, predecessor.bytes)).toEqual({
      ok: false,
      reason: "missing-supersedes",
    });
  });
});

describe("checkBenchmarkTransition", () => {
  function successor(predecessor: ReturnType<typeof sealBenchmark>, items: readonly string[], version: string) {
    return benchmarkWith(items, {
      version,
      supersedes: { digest: { sha256: predecessor.digest.slice("sha256:".length) } },
    });
  }

  test("binds exact predecessor bytes and accepts only a matching increasing bump", () => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "1.0.0" }));
    expect(checkBenchmarkTransition(
      successor(predecessor, [DIGEST_A, DIGEST_B], "1.1.0"), predecessor.bytes,
    )).toEqual({ ok: true, bump: "minor" });
  });

  test.each([
    ["downgrade", [DIGEST_A], "0.9.0", "version-not-increasing"],
    ["unchanged", [DIGEST_A], "1.0.0", "version-not-increasing"],
    ["build-only", [DIGEST_A], "1.0.0+build.2", "version-not-increasing"],
    ["wrong patch", [DIGEST_A, DIGEST_B], "1.0.1", "wrong-bump"],
    ["wrong minor", [DIGEST_A], "1.1.0", "wrong-bump"],
    ["wrong major", [DIGEST_B], "1.1.0", "wrong-bump"],
  ] as const)("rejects %s transition", (_name, items, version, reason) => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "1.0.0" }));
    expect(checkBenchmarkTransition(successor(predecessor, items, version), predecessor.bytes))
      .toMatchObject({ ok: false, reason });
  });

  test("accepts SemVer prerelease-to-release precedence within the classified patch class", () => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "1.0.0-rc.1" }));
    expect(checkBenchmarkTransition(successor(predecessor, [DIGEST_A], "1.0.0"), predecessor.bytes))
      .toEqual({ ok: true, bump: "patch" });
  });

  test("compares unbounded SemVer numeric core and prerelease identifiers without Number precision loss", () => {
    const predecessor = sealBenchmark(benchmarkWith([DIGEST_A], { version: "900719925474099312345.0.0-999999999999999999999999" }));
    expect(checkBenchmarkTransition(
      successor(predecessor, [DIGEST_A], "900719925474099312345.0.0-1000000000000000000000000"), predecessor.bytes,
    )).toEqual({ ok: true, bump: "patch" });
    expect(checkBenchmarkTransition(
      successor(predecessor, [DIGEST_A], "900719925474099312344.999999999999999999999999.999999999999999999999999"), predecessor.bytes,
    )).toMatchObject({ ok: false, reason: "version-not-increasing" });
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
