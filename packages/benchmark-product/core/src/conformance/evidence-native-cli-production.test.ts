// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3340 acceptance fixture: the evidence-native production path, driven through the CLI.
 *
 * The evidence-native graph builders have been exercised by conformance fixtures since #3283
 * (`./v5-signer-disclosure.test.ts`), but every one of them hand-sealed its records with
 * `@jinn-network/execution-evidence-builder` -- a devDependency. Nothing shipped could produce a
 * `benchmark-product-public-bundle/5` closure from a native run, which is what this file pins.
 *
 * It enters through `runCli` on purpose. Criterion 1 is a claim about the CLI, so a test that
 * called the operations directly would leave the verb surface -- flag parsing, `--from` routing,
 * the `VERBS` entry -- unpinned, and that surface is exactly what an operator touches.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { documentDigest } from "@jinn-network/benchmarking-protocol";
import { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } from "@jinn-network/benchmarking-evidence";
import { verifyPublicBundle } from "@colophon-claims/check";
import { describe, expect, test } from "vitest";
import { runCli } from "../cli/main.js";
import type { CliContext } from "../cli/result.js";

const PRINCIPAL = "urn:agent:sponsor";
const GRADER_A = "urn:evaluator:instrument-a";
const GRADER_B = "urn:evaluator:instrument-b";
const GROUP = "memory";
const SESSION = "session-1";

const encoder = new TextEncoder();

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function write(root: string, path: string, bytes: Uint8Array): Uint8Array {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return bytes;
}

/**
 * One Harbor 0.21 Job tree with a single captureable Trial. The shape is not invented: the adapter
 * (`@jinn-network/benchmarking-native-capture`'s `createHarborNativeAdapter`) requires a root
 * `config.json` + `result.json` for compatibility, a `<dir>/config.json` + `<dir>/result.json` pair
 * per Trial, exact `started_at`/`ended_at`, and a native trace -- it refuses to fabricate Execution
 * Evidence without the last two.
 */
function harborJob(root: string): {
  readonly taskDigest: `sha256:${string}`;
  readonly resultDigest: `sha256:${string}`;
} {
  write(root, "config.json", json({ job_name: "memory-job", agents: [{ name: "memory-agent" }] }));
  write(root, "result.json", json({ id: "job-1", status: "success", n_total_trials: 1 }));
  write(root, "trial-1/config.json", json({ task: { id: "memory-1" }, agent: { name: "memory-agent" }, attempt_number: 1 }));
  write(root, "trial-1/result.json", json({
    id: "trial-1",
    status: "success",
    started_at: "2026-08-16T09:00:00Z",
    ended_at: "2026-08-16T09:00:01Z",
  }));
  const task = write(root, "trial-1/task.json", json({ question: "Where was the key stored?", context: ["drawer"] }));
  const result = write(root, "trial-1/artifacts/prediction.json", json({ answer: "drawer" }));
  write(root, "trial-1/agent/trajectory.json", json({ schema: "ATIF", steps: [] }));
  return { taskDigest: documentDigest(task), resultDigest: documentDigest(result) };
}

/** Every field is a publisher pre-registration judgment; the CLI defaults none of them. */
function analysisPlan(taskDigest: `sha256:${string}`): unknown {
  const descriptor = (name: string, value: unknown) => ({
    name,
    digest: { sha256: documentDigest(json(value)).slice(7) },
  });
  return {
    benchmark: {
      name: "One-member evidence-native production path",
      description: "A single Harbor Trial graded by two separately-keyed instruments.",
      author: "urn:agent:analysis-owner",
      version: "1.0.0",
      items: [{
        task: { name: "memory-task-1.json", digest: { sha256: taskDigest.slice(7) }, mediaType: "application/json" },
        identifiers: [{ scheme: "https://harborframework.com/identifiers/task", value: "memory-1" }],
      }],
      reveal: { policy: "immediate" },
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    analysis: {
      owner: "urn:agent:analysis-owner",
      sourceCutoff: "2026-08-16T14:00:00.000Z",
      groups: [{ groupId: GROUP, selection: descriptor("all-one.json", { all: 1 }) }],
      taskRelation: { exactDigestRequired: true },
      multiplicity: {
        correlationUnit: "execution",
        duplicatePolicy: "retain-distinct",
        retryPolicy: "correlated",
        assignmentPolicy: descriptor("assignment.json", { slot: "native-trial" }),
      },
      evaluationAdmission: {
        evaluatorAllowlist: [GRADER_A, GRADER_B],
        methodAllowlist: [descriptor("binary-instrument.json", { method: "binary-instrument", version: 1 })],
        minimumClaims: 1,
        distinctEvaluators: true,
        humanLabelPolicy: "not-required",
        conflictPolicy: "preserve-unresolved",
        supersessionPolicy: "preserve-all",
        trustPolicy: descriptor("trust.json", { policy: "one-member" }),
      },
      verificationAdmission: {
        requiredChecks: [],
        trustPolicy: descriptor("verification-trust.json", { policy: "one-member" }),
        failurePolicy: "disclose",
      },
      completeness: {
        required: "complete",
        unavailableSource: "indeterminate",
        discoveredOmission: "fail",
        excludedMember: "count-attrition",
      },
      analysisPlan: [{ id: "jinn.benchmarking.method/binary-instrument", version: "1", parameters: { k: 1 } }],
      closeAt: "2026-08-16T14:00:00.000Z",
      preregistration: "local-sealed-before-selection",
    },
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters: { instruments: [GRADER_A, GRADER_B], k: 1 },
      implementation: descriptor("assembly-3.0.json", { procedure: "3.0" }),
    },
    evaluationMethod: descriptor("binary-instrument.json", { method: "binary-instrument", version: 1 }),
  };
}

function context(cwd: string): CliContext {
  let tick = 0;
  return {
    cwd,
    clock: () => {
      tick += 1;
      return `2026-08-16T1${Math.min(tick, 9)}:00:00.000Z`;
    },
  };
}

interface Envelope {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly detail: string };
}

describe("evidence-native production path (#3340)", () => {
  test("evidence prereg → capture → evaluate ×2 → seal → publish writes a public-bundle/5 closure its own verify path accepts", async () => {
    const root = mkdtempSync(join(tmpdir(), "evidence-native-cli-"));
    const workspace = join(root, "workspace");
    const jobs = join(root, "harbor-job");
    const out = join(root, "bundle");
    const { taskDigest, resultDigest } = harborJob(jobs);
    const planPath = join(root, "analysis-plan.json");
    writeFileSync(planPath, JSON.stringify(analysisPlan(taskDigest), null, 2));

    const cli = context(root);
    const run = async (argv: readonly string[]): Promise<Envelope> => {
      const result = await runCli([...argv, "--json"], cli);
      const envelope = JSON.parse(result.stdout) as Envelope;
      expect(envelope.error, `${argv.join(" ")} → ${result.stdout}${result.stderr}`).toBeUndefined();
      expect(result.exitCode, argv.join(" ")).toBe(0);
      expect(envelope.ok).toBe(true);
      return envelope;
    };
    const base = ["--workspace", workspace, "--principal", PRINCIPAL] as const;
    const session = [...base, "--evidence", SESSION] as const;

    await run(["init", ...base]);
    await run(["evidence", "prereg", ...session, "--file", planPath]);
    await run(["evidence", "capture", ...session, "--from", "harbor", jobs]);

    const memberKey = `${GROUP}/trial-1`;
    for (const evaluator of [GRADER_A, GRADER_B]) {
      await run([
        "evidence", "evaluate", ...session,
        "--member", memberKey, "--evaluator", evaluator, "--verdict", "pass",
      ]);
    }

    await run(["evidence", "seal", ...session]);
    const published = await run(["evidence", "publish", ...session, "--out", out]);
    expect(published.result).toMatchObject({ format: "benchmark-product-public-bundle/5" });

    // The bundle's own verify path, not the producer's word for it.
    const verified = await verifyPublicBundle(out);
    expect(verified.format).toBe("benchmark-product-public-bundle/5");
    expect(verified.checks).toEqual([...EVIDENCE_NATIVE_BUNDLE_V5_CHECKS]);

    const signers = verified.signers ?? [];
    expect(signers.filter((signer) => signer.role === "publisher")).toHaveLength(1);
    const graders = signers.filter((signer) => signer.role === "automated-grader");
    expect(graders.map((signer) => signer.identity).sort()).toEqual([GRADER_A, GRADER_B]);
    // Criterion 2: two evaluators over ONE Task+Result, so the two keys must be distinct.
    expect(new Set(graders.map((signer) => signer.keyId)).size).toBe(2);
    // Every key here is workspace-minted and workspace-held; nothing may read as independent.
    for (const signer of signers) expect(signer.custody).toBe("undeclared");

    // Both evaluations bind the same subject pair — distinctness of evaluators, not of subjects.
    const matrix = JSON.parse(
      new TextDecoder().decode(await readBundleFile(out, "matrix.json")),
    ) as { readonly cells: readonly { readonly taskDigest: string; readonly resultDigests: readonly string[]; readonly admittedEvaluations: readonly unknown[] }[] };
    expect(matrix.cells).toHaveLength(1);
    expect(matrix.cells[0]).toMatchObject({
      taskDigest: `sha256:${taskDigest.slice(7)}`,
      resultDigests: [`sha256:${resultDigest.slice(7)}`],
    });
    expect(matrix.cells[0]!.admittedEvaluations).toHaveLength(2);
  });

  test("--from inspect refuses rather than approximating the missing production projection reader", async () => {
    // The prefix deliberately avoids the word this test matches on: the refused path is echoed into
    // the detail, so a temp directory containing "inspect" would let the assertion pass on the path
    // rather than on the refusal.
    const root = mkdtempSync(join(tmpdir(), "evidence-native-reader-"));
    const workspace = join(root, "workspace");
    const cli = context(root);
    const base = ["--workspace", workspace, "--principal", PRINCIPAL] as const;
    await runCli(["init", ...base, "--json"], cli);

    const result = await runCli([
      "evidence", "capture", ...base, "--evidence", SESSION, "--from", "inspect", join(root, "logs"), "--json",
    ], cli);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Envelope;
    expect(envelope.error?.code).toBe("invalid-invocation");
    expect(envelope.error?.detail).toMatch(/no production Inspect projection reader/u);
  });
});

async function readBundleFile(bundleDir: string, path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(join(bundleDir, path)));
}
