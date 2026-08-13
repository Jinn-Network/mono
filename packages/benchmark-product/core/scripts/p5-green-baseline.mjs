#!/usr/bin/env node

/**
 * Real P5 grader control: for each committed task, the upstream gold patch must PASS and the
 * empty patch must FAIL through the exact frozen OCI grader. Gold bytes are fetched at runtime,
 * held only in memory/the grader's private temporary mount, and never written to the fixture,
 * transcript, Task, or solve workspace.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSweRebenchEvaluatorAdapter } from "@jinn-network/task-execution-evaluator-adapters";
import {
  ensurePinnedOciImage,
  graderProgramDigest,
  pinnedSweRebenchImage,
  sha256Hex,
  sweRebenchOciGraderReportSource,
} from "@jinn-network/task-execution-oci-grader";
import { sweRebenchRowToTaskAndSpec } from "@jinn-network/task-execution-profiles";
import { fetchRows } from "./mint-micro-slate.mjs";
import { assertP5DiskGate } from "./p5-disk-gate.mjs";

const fixturePath = fileURLToPath(new URL("../fixtures/p5-micro-slate/rows.json", import.meta.url));

function fail(message) {
  throw new Error(`P5 green baseline: ${message}`);
}

function outputPath(argv) {
  const index = argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) fail("--output requires a path");
  return value;
}

function exactString(record, key) {
  const value = record?.[key];
  if (typeof value !== "string") fail(`upstream row has no ${key}`);
  return value;
}

function materialFor(row) {
  const descriptor = row.testMaterial.find((entry) => entry.name === "swe-rebench-evaluation-row");
  if (descriptor?.content === undefined) fail(`${row.instance_id} has no canonical evaluation row`);
  const bytes = new Uint8Array(Buffer.from(descriptor.content, "base64"));
  if (sha256Hex(bytes) !== descriptor.digest?.sha256) {
    fail(`${row.instance_id} evaluation-row descriptor digest mismatch`);
  }
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
}

function exactMaterial(name, bytes) {
  return {
    descriptor: { name, digest: { sha256: sha256Hex(bytes) } },
    bytes,
  };
}

async function grade(adapter, row, patchBytes, attemptNumber) {
  const { evaluationSpec } = sweRebenchRowToTaskAndSpec(row);
  const diskGate = assertP5DiskGate(`grader ${row.instance_id} attempt ${attemptNumber}`);
  const evaluation = await adapter.evaluate(
    exactMaterial("subject-task.json", new Uint8Array()),
    [exactMaterial("result.patch", patchBytes)],
    evaluationSpec,
    {},
    {
      attemptUri: `urn:uuid:00000000-0000-4000-8000-${String(attemptNumber).padStart(12, "0")}`,
      attemptNumber,
      nonce: `p5-green-${attemptNumber}`,
    },
    new AbortController().signal,
  );
  return { diskGate, evaluation };
}

export async function runP5GreenBaseline({ dockerPath, output } = {}) {
  const startedAt = new Date();
  const initialDisk = assertP5DiskGate("green-baseline start");
  const fixtureRows = JSON.parse(readFileSync(fixturePath, "utf8"));
  const upstreamRows = await fetchRows();
  const upstreamById = new Map(upstreamRows.map((row) => [row.instance_id, row]));
  const work = mkdtempSync(join(tmpdir(), "demo1-p5-green-baseline-"));
  const source = sweRebenchOciGraderReportSource({
    attemptWorkRoot: () => work,
    runner: {
      imagePullPolicy: "never",
      ...(dockerPath === undefined ? {} : { dockerPath }),
    },
  });
  const adapter = createSweRebenchEvaluatorAdapter({ graderReportSource: source });
  const results = [];
  let attemptNumber = 0;
  try {
    for (const row of fixtureRows) {
      const upstream = upstreamById.get(row.instance_id);
      if (upstream === undefined) fail(`${row.instance_id} disappeared upstream`);
      const material = materialFor(row);
      for (const key of ["instance_id", "base_commit", "test_patch"]) {
        if (material[key] !== exactString(upstream, key)) {
          fail(`${row.instance_id} sealed ${key} moved from upstream`);
        }
      }

      const image = pinnedSweRebenchImage(sweRebenchRowToTaskAndSpec(row).evaluationSpec);
      const diskBeforeImage = assertP5DiskGate(`image pre-stage ${row.instance_id}`);
      const imageStarted = Date.now();
      await ensurePinnedOciImage(
        { runtime: "docker", ...image },
        dockerPath === undefined ? {} : { dockerPath },
      );
      const imageSetupMs = Date.now() - imageStarted;

      const goldBytes = new TextEncoder().encode(exactString(upstream, "patch"));
      const goldStarted = Date.now();
      const gold = await grade(adapter, row, goldBytes, ++attemptNumber);
      const goldMs = Date.now() - goldStarted;
      const emptyStarted = Date.now();
      const empty = await grade(adapter, row, new Uint8Array(), ++attemptNumber);
      const emptyMs = Date.now() - emptyStarted;
      if (gold.evaluation.verdict !== "pass") {
        fail(`${row.instance_id} gold patch returned ${gold.evaluation.verdict}`);
      }
      if (empty.evaluation.verdict !== "fail") {
        fail(`${row.instance_id} empty patch returned ${empty.evaluation.verdict}`);
      }
      results.push({
        instanceId: row.instance_id,
        image: image.image,
        diskBeforeImage,
        imageSetupMs,
        gold: { verdict: gold.evaluation.verdict, diskGate: gold.diskGate, elapsedMs: goldMs },
        empty: { verdict: empty.evaluation.verdict, diskGate: empty.diskGate, elapsedMs: emptyMs },
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const transcript = {
    schema: "demo1.p5-green-baseline/1",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    diskGate: initialDisk,
    graderProgramDigest: graderProgramDigest(),
    networkPolicy: "disabled (no sealed public-network extension; no host opt-in)",
    rows: results,
    passed: results.length === 3
      && results.every((row) => row.gold.verdict === "pass" && row.empty.verdict === "fail"),
  };
  const rendered = `${JSON.stringify(transcript, null, 2)}\n`;
  const destination = output;
  if (destination !== undefined) writeFileSync(destination, rendered, { encoding: "utf8", flag: "wx" });
  return { transcript, rendered };
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { rendered } = await runP5GreenBaseline({ output: outputPath(process.argv.slice(2)) });
  process.stdout.write(rendered);
}
