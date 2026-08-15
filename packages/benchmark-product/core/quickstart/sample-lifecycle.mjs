/**
 * The one canonical lifecycle behind the disposable contributor proof and the
 * retained first-run product demo.  It deliberately speaks only to the built
 * CLI: a demo is evidence of the shipped command surface, not an in-memory
 * shortcut around it.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

export const SAMPLE_LIFECYCLE_MODES = Object.freeze({
  CONTRIBUTOR_PROOF: "contributor-proof",
  PRODUCT_DEMO: "product-demo",
});

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
    // PATH is executable discovery, not credential or network configuration.
    PATH: process.env.PATH ?? dirname(process.execPath),
    TMPDIR: realpathSync(tmpdir()),
    TZ: "UTC",
  };
}

function cleanBuild({ emit = () => {} } = {}) {
  emit({ type: "progress", stage: "build", message: "clean-building the CLI" });
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

function isMissing(cause) {
  return cause !== null && typeof cause === "object" && cause.code === "ENOENT";
}

/** Reject a target or immediate parent which would make output ambiguous. */
function assertUnlinkedNewOutputRoot(outputRoot) {
  if (typeof outputRoot !== "string" || outputRoot.length === 0 || !isAbsolute(outputRoot)) {
    fail("product demo output root must be an explicit absolute path", 2);
  }
  if (resolve(outputRoot) !== outputRoot) {
    fail("product demo output root must not contain relative segments", 2);
  }

  try {
    const target = lstatSync(outputRoot);
    if (target.isSymbolicLink()) fail(`product demo output root is linked: ${outputRoot}`, 2);
    fail(`product demo output root already exists: ${outputRoot}`, 2);
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
  try {
    const parent = lstatSync(dirname(outputRoot));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      fail(`product demo output parent is not an exact directory: ${dirname(outputRoot)}`, 2);
    }
  } catch (cause) {
    if (isMissing(cause)) fail(`product demo output parent does not exist: ${dirname(outputRoot)}`, 2);
    throw cause;
  }
}

function createNewOutputRoot(outputRoot) {
  assertUnlinkedNewOutputRoot(outputRoot);
  try {
    mkdirSync(outputRoot, { mode: 0o700 });
  } catch (cause) {
    fail(`could not create new product demo output root ${outputRoot}: ${cause instanceof Error ? cause.message : String(cause)}`, 2);
  }
  const stat = lstatSync(outputRoot, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("product demo output root is not an exact directory", 2);
  return { path: outputRoot, identity: { dev: stat.dev, ino: stat.ino } };
}

function assertOutputRoot(output) {
  const stat = lstatSync(output.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== output.identity.dev || stat.ino !== output.identity.ino) {
    fail("product demo output root changed after it was created");
  }
  if (readdirSync(output.path).length !== 0) fail("product demo output root was populated before bundle copy");
}

function defaultExecuteCommand({ label, argv, packageRoot: cwd, cliBinPath: binPath, emit }) {
  const result = spawnSync(process.execPath, [binPath, ...argv], {
    cwd,
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
  emit({ type: "progress", stage: "command", label, message: `${label} completed` });
  return { result: envelope.result, exitCode: result.status };
}

/**
 * Runs the honest bundled sample once. Product mode intentionally never
 * removes `outputRoot`: the caller can retain both a successful copied bundle
 * and a failed verification's evidence without trusting runner cleanup.
 *
 * `prepareBuild` and `executeCommand` are narrow test seams, not alternate
 * product paths. Their defaults clean-build and invoke dist/cli/bin.js.
 */
export function runSampleLifecycle({
  mode = SAMPLE_LIFECYCLE_MODES.CONTRIBUTOR_PROOF,
  outputRoot,
  temporaryBase = realpathSync(tmpdir()),
  onProgress = () => {},
  prepareBuild = cleanBuild,
  executeCommand = defaultExecuteCommand,
} = {}) {
  if (!Object.values(SAMPLE_LIFECYCLE_MODES).includes(mode)) {
    fail(`unknown sample lifecycle mode: ${String(mode)}`, 2);
  }
  if (mode === SAMPLE_LIFECYCLE_MODES.CONTRIBUTOR_PROOF && outputRoot !== undefined) {
    fail("contributor proof does not accept an output root", 2);
  }
  requireNode22();

  // Refuse an occupied/linked target before building or creating staging.
  if (mode === SAMPLE_LIFECYCLE_MODES.PRODUCT_DEMO) assertUnlinkedNewOutputRoot(outputRoot);
  prepareBuild({ emit: onProgress });

  const output = mode === SAMPLE_LIFECYCLE_MODES.PRODUCT_DEMO ? createNewOutputRoot(outputRoot) : undefined;
  const owner = createOwnedRoot({ temporaryBase: realpathSync(temporaryBase) });
  const workspaceDir = join(owner.root, "source-workspace");
  const portableBundleDir = output === undefined ? join(owner.root, "copied-public-bundle") : join(output.path, "bundle");
  const principal = "sponsor-1";
  const draftId = "public-quickstart";
  const commandEvidence = [];
  let sourceWorkspaceDeleted = false;
  let finalEvidence;
  let primaryFailure;
  let cleanupFailure;

  const step = (label, argv) => {
    onProgress({ type: "progress", stage: "command", label, message: `${label} started` });
    const outcome = executeCommand({
      label,
      argv: [...argv, "--json"],
      packageRoot,
      cliBinPath,
      workspaceDir,
      emit: onProgress,
    });
    const result = outcome?.result ?? outcome;
    const exitCode = outcome?.exitCode ?? 0;
    commandEvidence.push({ label, exitCode });
    return result;
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
    if (output !== undefined) assertOutputRoot(output);
    cpSync(sourceBundleDir, portableBundleDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      dereference: false,
    });
    if (output === undefined) captureOwnedPortableBundle(owner, portableBundleDir);
    onProgress({ type: "progress", stage: "bundle-copy", message: "copied immutable bundle" });

    removeOwnedWorkspace(owner, workspaceDir);
    sourceWorkspaceDeleted = true;
    onProgress({ type: "progress", stage: "source-cleanup", message: "removed temporary source workspace" });
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
      sampleContract: {
        accountRequired: false,
        apiKeyRequired: false,
        fundsRequired: false,
        dockerRequired: false,
        providerCallsMade: false,
      },
      sourceWorkspaceDeleted,
      arms: ["prediction-v1-baseline", "sample-uniform"],
      conclusion: "This bundled sample demonstrates a verifiable comparison; it does not establish a comparative winner beyond this sample.",
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
    if (output !== undefined) {
      finalEvidence = {
        ...finalEvidence,
        mode,
        output: {
          root: output.path,
          bundle: portableBundleDir,
          retained: true,
        },
      };
    }
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
  if (terminalFailure !== undefined) {
    onProgress({
      type: "result",
      ok: false,
      mode,
      error: { message: terminalFailure instanceof Error ? terminalFailure.message : String(terminalFailure) },
    });
    throw terminalFailure;
  }
  const cleanup = { temporaryRootRemoved: true };
  onProgress({ type: "result", ok: true, mode, result: { ...finalEvidence, cleanup } });
  return { ...finalEvidence, cleanup };
}
