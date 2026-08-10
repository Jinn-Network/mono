#!/usr/bin/env node

/**
 * Cold product proof through the BUILT CLI and default REAL local venue.
 *
 * No caller path is accepted. The runner owns one mkdtemp root, marks it with
 * an unguessable token, copies the immutable bundle outside its source
 * workspace, deletes that exact source child, verifies the copy, then removes
 * only the exact owner-marked root. Product operations run with a deliberately
 * minimal environment: no ambient credential or network configuration is
 * forwarded.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureOwnedPortableBundle,
  captureOwnedWorkspace,
  combinePrimaryAndCleanupFailure,
  createOwnedRoot,
  removeOwnedRoot,
  removeOwnedWorkspace,
} from "./ownership.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliBinPath = join(packageRoot, "dist", "cli", "bin.js");
const buildScriptPath = join(packageRoot, "scripts", "build.mjs");
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const stepTimeoutMs = 180_000;
const expectedBundleChecks = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
];

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function requireNode22() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major) || major < 22) {
    fail(`Node 22 or newer is required; current runtime is ${process.versions.node}`, 2);
  }
}

function minimalEnvironment() {
  return {
    LANG: "C",
    LC_ALL: "C",
    NODE_OPTIONS: "--preserve-symlinks",
    // The local backend uses ordinary host process-control utilities. PATH is
    // executable discovery, not a credential or network configuration; every
    // other ambient variable remains excluded.
    PATH: process.env.PATH ?? dirname(process.execPath),
    TMPDIR: realpathSync(tmpdir()),
    TZ: "UTC",
  };
}

function cleanBuild() {
  console.error("public-quickstart: clean-building the CLI ...");
  const result = spawnSync(process.execPath, [buildScriptPath], {
    cwd: packageRoot,
    env: minimalEnvironment(),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) fail(`core build could not start: ${result.error.message}`);
  if (result.signal !== null && result.signal !== undefined) fail(`core build was killed by ${result.signal}`);
  if (result.status !== 0) {
    fail(`core build failed (exit ${String(result.status)}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  if (!existsSync(cliBinPath)) fail("core build succeeded without producing dist/cli/bin.js");
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function run() {
  requireNode22();
  cleanBuild();

  const owner = createOwnedRoot({ temporaryBase: realpathSync(tmpdir()) });
  const workspaceDir = join(owner.root, "source-workspace");
  const portableBundleDir = join(owner.root, "copied-public-bundle");
  const principal = "sponsor-1";
  const draftId = "public-quickstart";
  const commandEvidence = [];
  let sourceWorkspaceDeleted = false;
  let finalEvidence;
  let primaryFailure;
  let cleanupFailure;

  const step = (label, argv) => {
    const result = spawnSync(process.execPath, [cliBinPath, ...argv, "--json"], {
      cwd: packageRoot,
      env: minimalEnvironment(),
      encoding: "utf8",
      timeout: stepTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error !== undefined) fail(`${label} could not start: ${result.error.message}`);
    if (result.signal !== null && result.signal !== undefined) fail(`${label} was killed by ${result.signal}`);
    let envelope;
    try {
      envelope = JSON.parse(result.stdout ?? "");
    } catch (cause) {
      fail(`${label} did not return one JSON envelope: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (result.status !== 0 || envelope?.ok !== true) {
      fail(`${label} failed (exit ${String(result.status)}): ${JSON.stringify(envelope)}`);
    }
    if ((result.stderr ?? "") !== "") fail(`${label} wrote to stderr in JSON mode`);
    commandEvidence.push({ label, exitCode: result.status });
    console.error(`public-quickstart: ${label} -> ok`);
    return envelope.result;
  };

  const common = ["--workspace", workspaceDir, "--principal", principal];
  const forDraft = [...common, "--draft", draftId];

  try {
    step("init", ["init", ...common]);
    captureOwnedWorkspace(owner, workspaceDir);
    step("draft create", [
      "draft", "create", ...common,
      "--id", draftId,
      "--name", "Public quickstart",
      "--description", "Built-CLI real-local-venue public bundle proof",
    ]);
    const sample = step("sample init", ["sample", "init", ...forDraft]);
    step("arm add baseline", [
      "arm", "add", ...forDraft,
      "--arm", "baseline",
      "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
    ]);
    step("arm add sample-uniform", [
      "arm", "add", ...forDraft,
      "--arm", "sample-uniform",
      "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
    ]);
    const quote = step("quote", ["quote", ...forDraft]);
    const lock = step("lock", ["lock", ...forDraft]);
    step("launch", ["launch", ...forDraft]);
    step("status after launch", ["status", ...forDraft]);
    const resume = step("resume", ["resume", ...forDraft]);
    const status = step("status after resume", ["status", ...forDraft]);
    const collect = step("collect", ["collect", ...forDraft]);
    const results = step("results", ["results", ...forDraft]);
    const report = step("report", ["report", ...forDraft]);
    const workspaceVerify = step("workspace verify", ["verify", ...forDraft]);
    const publish = step("publish", ["publish", ...forDraft]);

    if (!sameStrings(publish.checks, expectedBundleChecks)) fail("publish did not return the six checks in canonical order");
    const relativeMatch = /^artifacts\/public-quickstart\/public-bundles\/([a-f0-9]{64})$/.exec(
      publish.bundleRelativePath,
    );
    if (relativeMatch === null || relativeMatch[1] !== publish.bundleIdentity) {
      fail("publish returned a non-canonical bundle path or identity");
    }
    const sourceBundleDir = resolve(workspaceDir, publish.bundleRelativePath);
    if (dirname(sourceBundleDir) !== join(workspaceDir, "artifacts", draftId, "public-bundles")) {
      fail("published bundle did not resolve below the draft-owned artifact directory");
    }
    const sourceStat = lstatSync(sourceBundleDir);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail("published bundle is not an exact directory");
    cpSync(sourceBundleDir, portableBundleDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      dereference: false,
    });
    captureOwnedPortableBundle(owner, portableBundleDir);

    removeOwnedWorkspace(owner, workspaceDir);
    sourceWorkspaceDeleted = true;
    const portableVerify = step("standalone copied-bundle verify", ["bundle", "verify", "--bundle", portableBundleDir]);
    if (!sameStrings(portableVerify.checks, expectedBundleChecks)) {
      fail("standalone verifier did not return the six checks in canonical order");
    }
    if (portableVerify.identity !== publish.bundleIdentity) fail("copied bundle identity changed");

    finalEvidence = {
      package: `${packageMetadata.name}@${packageMetadata.version}`,
      runtime: `node@${process.versions.node}`,
      interface: "built dist/cli/bin.js",
      venue: "real local venue",
      ambientCredentialsForwarded: false,
      ambientNetworkConfigurationForwarded: false,
      sourceWorkspaceDeleted,
      arms: ["prediction-v1-baseline", "sample-uniform"],
      expectedCells: status.counts.expected,
      quoteCells: quote.quote.expectedCellCount,
      resumedOutstandingCells: resume.outstandingCount,
      runOutcome: results.completeness.runOutcome,
      digests: {
        benchmarkSha256: sample.benchmarkSha256,
        runSha256: lock.runSha256,
        matrixSha256: collect.matrixSha256,
        reportSha256: report.reportSha256,
        bundleIdentity: publish.bundleIdentity,
      },
      workspaceChecks: workspaceVerify.checks,
      portableChecks: portableVerify.checks,
      commands: commandEvidence,
    };
  } catch (cause) {
    primaryFailure = cause;
  } finally {
    try {
      removeOwnedRoot(owner);
    } catch (cause) {
      cleanupFailure = cause;
    }
  }

  const terminalFailure = combinePrimaryAndCleanupFailure(primaryFailure, cleanupFailure);
  if (terminalFailure !== undefined) throw terminalFailure;
  return { ...finalEvidence, cleanup: { temporaryRootRemoved: true } };
}

if (process.argv.length > 2) {
  console.error("public-quickstart takes no arguments; caller-selected paths are refused.");
  process.exitCode = 2;
} else {
  try {
    const evidence = run();
    process.stdout.write(`${JSON.stringify({ ok: true, result: evidence })}\n`);
  } catch (cause) {
    console.error(`public-quickstart: FATAL: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = typeof cause?.exitCode === "number" ? cause.exitCode : 1;
  }
}
