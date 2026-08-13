/**
 * Validates the committed P5 micro-slate fixture (`fixtures/p5-micro-slate/rows.json`).
 *
 * This is the final post-P3b material-contract mint. Nothing here hardcodes a row digest: every
 * digest-shaped assertion is a pattern, a re-canonicalization, or a cross-check against the
 * fixture's sidecar, so a legitimate re-mint moves the fixture and this suite follows it.
 *
 * These tests need no network and no Docker — they run in ordinary CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBenchmarkTaskProvenance } from "@jinn-network/benchmarking-records";
import { SWE_REBENCH_PARSER } from "@jinn-network/task-execution-evaluator-adapters";
import {
  canonicalJsonBytes,
  graderProgramDigest,
  sha256Hex,
} from "@jinn-network/task-execution-oci-grader";
import { describe, expect, test } from "vitest";
import { convertSweBenchRows } from "./swebench.js";

const FIXTURE_DIR = new URL("../../fixtures/p5-micro-slate/", import.meta.url);

interface MicroSlateRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  language: string;
  image: { name?: string; uri?: string; digest?: Record<string, string> };
  testMaterial: {
    name?: string;
    mediaType?: string;
    content?: string;
    digest?: Record<string, string>;
  }[];
  parser: { id: string; version: string; digest: string };
  transitions: { failToPass: string[]; passToPass: string[] };
  timeout: number;
}

interface MicroSlateProvenance {
  dataset: string;
  split: string;
  mintedAt: string;
  status: string;
  parser: { id: string; version: string; digest: string };
  graderProgramDigest: string;
  timeoutSeconds: number;
  exclusionRules: { maxFailToPass: number; maxPassToPass: number; minDistinctRepos: number };
  rows: {
    instance_id: string;
    repo: string;
    base_commit: string;
    sourceUrl: string;
    imageName: string;
    imageUri: string;
    imageDigest: string;
  }[];
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR)), "utf8")) as T;
}

const CONVERT_OPTS = {
  name: "P5 micro-slate",
  description: "Three-task SWE-bench-shaped gate slate spanning three source repos.",
  version: "0.1.0",
  provenanceTimestamp: "2026-08-11T00:00:00Z",
};

const rows = (): MicroSlateRow[] => readJson<MicroSlateRow[]>("rows.json");
const provenance = (): MicroSlateProvenance => readJson<MicroSlateProvenance>("provenance.json");

describe("P5 micro-slate fixture", () => {
  test("has exactly three tasks spanning three distinct source repos", () => {
    const slate = rows();
    expect(slate).toHaveLength(3);
    // Binding constraint, not an accident. The clustered bootstrap groups by provenance source;
    // a single-repo slate is the lazy choice (one image, faster) and collapses clusterCount to 1,
    // silently skipping the clustering path the gate exists to exercise.
    expect(new Set(slate.map((row) => row.repo)).size).toBe(3);
    expect(new Set(slate.map((row) => row.instance_id)).size).toBe(3);
  });

  test("pins every image by matching docker URI and descriptor digests", () => {
    for (const row of rows()) {
      const digest = row.image.digest?.["sha256"];
      expect(digest, row.instance_id).toMatch(/^[a-f0-9]{64}$/u);
      expect(row.image.name, row.instance_id).toBe("swe-rebench-grader-image");
      expect(row.image.uri, row.instance_id).toMatch(/^docker:\/\//u);
      const reference = (row.image.uri ?? "").slice("docker://".length);
      const at = reference.indexOf("@");
      expect(at, row.instance_id).toBeGreaterThan(0);
      // The reference must pin the same image its digest claims, never a mutable tag.
      expect(reference.slice(at + 1), row.instance_id).toBe(`sha256:${digest}`);
      expect(reference.slice(0, at), row.instance_id).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u);
    }
  });

  test("seals the exact P3b canonical evaluation-row material on every task", () => {
    for (const row of rows()) {
      expect(row.testMaterial, row.instance_id).toHaveLength(1);
      const [descriptor] = row.testMaterial;
      expect(descriptor, row.instance_id).toMatchObject({
        name: "swe-rebench-evaluation-row",
        mediaType: "application/json",
      });
      expect(descriptor?.content, row.instance_id).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
      const bytes = new Uint8Array(Buffer.from(descriptor!.content!, "base64"));
      expect(sha256Hex(bytes), row.instance_id).toBe(descriptor?.digest?.["sha256"]);
      const material = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      expect(canonicalJsonBytes(material), row.instance_id).toEqual(bytes);
      expect(Object.keys(material).sort(), row.instance_id).toEqual([
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "base_commit",
        "install_config",
        "instance_id",
        "test_patch",
      ]);
      expect(material, row.instance_id).toMatchObject({
        instance_id: row.instance_id,
        base_commit: row.base_commit,
        FAIL_TO_PASS: row.transitions.failToPass,
        PASS_TO_PASS: row.transitions.passToPass,
        install_config: {
          install: expect.any(Array),
          test_cmd: expect.any(Array),
          log_parser: "parse_log_pytest",
        },
        test_patch: expect.any(String),
      });
      expect(Object.keys(material["install_config"] as Record<string, unknown>).sort(), row.instance_id)
        .toEqual(["install", "log_parser", "test_cmd"]);
    }
  });

  test("respects the exclusion rules declared before selection", () => {
    const { exclusionRules } = provenance();
    for (const row of rows()) {
      // Rule 3 — transition-size caps. The upstream tails are pathological; a whole-suite run
      // is not a task.
      expect(row.transitions.failToPass.length, row.instance_id).toBeGreaterThan(0);
      expect(row.transitions.failToPass.length, row.instance_id)
        .toBeLessThanOrEqual(exclusionRules.maxFailToPass);
      expect(row.transitions.passToPass.length, row.instance_id)
        .toBeLessThanOrEqual(exclusionRules.maxPassToPass);
    }
    // Rule 4 — repo concentration.
    expect(new Set(rows().map((row) => row.repo)).size)
      .toBeGreaterThanOrEqual(exclusionRules.minDistinctRepos);
  });

  test("carries the shipped parser identity, not an invented one", () => {
    // Upstream publishes only a bare log-parser string. The real identity ships from
    // evaluator-adapters; a hand-assigned digest here would make the report's grader claim a lie.
    for (const row of rows()) {
      expect(row.parser, row.instance_id).toEqual(SWE_REBENCH_PARSER);
    }
    expect(provenance().parser).toEqual(SWE_REBENCH_PARSER);
    expect(provenance().graderProgramDigest).toBe(graderProgramDigest());
    expect(provenance().status).toMatch(/FINAL P5 FIXTURE/u);
  });

  test("assigns a positive integer timeout on every row", () => {
    // Upstream publishes no per-task timeout, so it is a declared policy value. It is also the
    // only bound on the container run (container-grader-source.ts:385).
    const { timeoutSeconds } = provenance();
    for (const row of rows()) {
      expect(Number.isInteger(row.timeout), row.instance_id).toBe(true);
      expect(row.timeout, row.instance_id).toBe(timeoutSeconds);
    }
  });

  test("carries a 40-hex base commit and a well-formed owner/repo on every row", () => {
    for (const row of rows()) {
      expect(row.base_commit, row.instance_id).toMatch(/^[a-f0-9]{40}$/u);
      expect(row.repo, row.instance_id).toMatch(/^[^/\s]+\/[^/\s]+$/u);
      expect(row.problem_statement.length, row.instance_id).toBeGreaterThan(0);
      expect(row.language, row.instance_id).toBe("python");
    }
  });

  test("never carries a gold solution", () => {
    // The gold patch belongs only to the green-baseline grader control, fetched at run time and
    // never persisted. It must never reach a sealed Task or an agent's context.
    // (Same discipline as swe-rebench-journey's `parseHfRow`, pinned at its test:121.)
    const raw = readFileSync(fileURLToPath(new URL("rows.json", FIXTURE_DIR)), "utf8");
    expect(JSON.parse(raw).some((row: Record<string, unknown>) => "patch" in row)).toBe(false);
  });

  test("agrees with its provenance sidecar row for row", () => {
    // The sidecar is what makes the fixture auditable without a re-fetch; drift between them
    // would make the recorded evidence unverifiable.
    const slate = rows();
    const sidecar = provenance();
    expect(sidecar.rows).toHaveLength(slate.length);
    for (const row of slate) {
      const entry = sidecar.rows.find((candidate) => candidate.instance_id === row.instance_id);
      expect(entry, row.instance_id).toBeDefined();
      expect(entry?.repo).toBe(row.repo);
      expect(entry?.base_commit).toBe(row.base_commit);
      expect(entry?.imageDigest).toBe(`sha256:${row.image.digest?.["sha256"]}`);
      expect(entry?.imageUri).toBe(row.image.uri);
    }
  });

  test("converts to a sealed Benchmark over three distinct Task digests", () => {
    const converted = convertSweBenchRows(rows(), CONVERT_OPTS);
    expect(converted.imported.tasks).toHaveLength(3);
    expect(new Set(converted.imported.tasks.map((task) => task.digest)).size).toBe(3);
    expect(converted.imported.benchmark.record.items).toHaveLength(3);
    // P0-interop half (b): the product retains each row's EvaluationSpec bytes, keyed by the
    // digest its Task references, because the venue's evaluation path resolves them that way.
    expect(converted.evaluationSpecs).toHaveLength(3);
  });

  test("resolves to three repo-level provenance clusters, one per source repo", () => {
    // This is the post-cluster-fix mint. Before that fix the provenance source carried
    // `@<base_commit>`, so three tasks across three repos produced three keys that merely LOOKED
    // correct while every real slate degenerated to one cluster per task. Asserting the keys are
    // repo-level — and carry no commit — is what makes this fixture demonstrate the fix rather
    // than coincidentally agree with it.
    const converted = convertSweBenchRows(rows(), CONVERT_OPTS);
    const byDigest = new Map(converted.imported.tasks.map((task) => [task.digest, task.bytes]));
    const clusters = converted.imported.tasks.map((task) => {
      const resolved = resolveBenchmarkTaskProvenance(task.digest, (digest) =>
        byDigest.get(digest as `sha256:${string}`));
      if (!resolved.ok) throw new Error(`provenance did not resolve: ${resolved.reason}`);
      return resolved.provenance.cluster;
    });

    expect(new Set(clusters.map((cluster) => cluster.value)).size).toBe(3);
    for (const cluster of clusters) {
      expect(cluster.tag).toBe("source");
      expect(cluster.value).not.toContain("@");
    }
    expect(clusters.map((cluster) => cluster.value).sort()).toEqual([
      "https://github.com/gerlero/foamlib",
      "https://github.com/python-wheel-build/fromager",
      "https://github.com/qBraid/pyqasm",
    ]);
  });
});
