import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { INSPECT_SANDBOX_PROVIDER, type InspectSelectionManifest } from "./manifest.js";
import {
  assertInspectOciHostUndrifted,
  buildInspectOciRunArgs,
  catalogInspectOciSelection,
  directoryTreeSha256,
  INSPECT_SANDBOX_POLICY,
  InspectOciCommandTimeoutError,
  InspectOciHostBindingSchema,
  inspectOciRunnerSha256,
  InspectOciUnavailableError,
  inspectSandboxPolicySha256,
  type InspectOciHostBinding,
} from "./oci.js";

const binding = InspectOciHostBindingSchema.parse({
  kind: "oci",
  dockerPath: "/usr/local/bin/docker",
  imageDigest: `sha256:${"a".repeat(64)}`,
  platform: "linux/amd64",
  projectDir: "/selected/project",
  datasetCacheDir: "/selected/dataset-cache",
  user: "501:20",
});

describe("Inspect OCI driver", () => {
  test("constructs a pull-free, read-only, capability-dropped worker boundary", () => {
    const args = buildInspectOciRunArgs(binding, {
      name: "jinn-inspect-cell-abc",
      operation: "run",
      inputDir: "/attempt/input",
      outputDir: "/attempt/output",
      network: "none",
    });

    expect(args).toContain("--pull=never");
    expect(args).toContain("--interactive");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--env=HOME=/tmp/home");
    expect(args).toContain("--env=XDG_DATA_HOME=/tmp/xdg/data");
    expect(args).toContain("--env=TIKTOKEN_CACHE_DIR=/opt/jinn/tiktoken-cache");
    expect(args).toContain("--network=none");
    expect(args).toContain("--pids-limit=64");
    expect(args).toContain("--memory=1073741824");
    expect(args).toContain("--cpus=1");
    expect(args).toContain("type=bind,src=/selected/project,dst=/jinn/project,readonly");
    expect(args).toContain("type=bind,src=/selected/dataset-cache,dst=/jinn/dataset-cache,readonly");
    expect(args).toContain("type=bind,src=/attempt/input,dst=/jinn/input,readonly");
    expect(args).toContain("type=bind,src=/attempt/output,dst=/jinn/output");
    expect(args.at(-3)).toBe(binding.imageDigest);
    expect(args.slice(-2)).toEqual(["run", "/jinn/input/inspect-run.json"]);
  });

  test("the worker receives no host environment or credential mount", () => {
    const serialized = buildInspectOciRunArgs(binding, {
      name: "jinn-inspect-probe-abc",
      operation: "probe",
      network: "none",
    }).join("\n");
    expect(serialized).not.toMatch(/OPENAI_API_KEY|auth\.json|docker\.sock|\.ssh|keychain|--env=HOME=(?!\/tmp\/home)/u);
    expect(serialized).not.toContain("/Users/");
  });

  test("rejects tags and mutable image names", () => {
    expect(() => InspectOciHostBindingSchema.parse({
      ...binding,
      imageDigest: "jinn-inspect:latest",
    })).toThrow();
  });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.JINN_INSPECT_OCI_COMMAND_TIMEOUT_MS;
  delete process.env.JINN_INSPECT_OCI_WORKER_TIMEOUT_MS;
});

/**
 * A stand-in for the `docker` CLI that satisfies the engine-reachability check and then exits 0
 * from `run` with nothing on stdout -- the state a worker whose output never reached the caller
 * leaves behind.
 */
function writeSilentFakeDocker(directory: string): string {
  const dockerPath = join(directory, "docker");
  writeFileSync(dockerPath, [
    `#!${process.execPath}`,
    "if (process.argv[2] === 'version') process.stdout.write('{}');",
  ].join("\n"), { mode: 0o755 });
  chmodSync(dockerPath, 0o755);
  return dockerPath;
}

/**
 * #3720. Every OCI command below parses its own stdout, and a bare `JSON.parse` reported only
 * V8's `Unexpected end of JSON input` -- a message `run-launch.ts` then wrapped as
 * `venue-unavailable` at path `venue`, naming neither which command produced it nor what that
 * command actually wrote. CI run 33686563879 recorded exactly that refusal and nothing else.
 * The failure must name its own subject.
 */
test("an OCI command that exits 0 without parseable stdout names itself and what it wrote", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-silent-"));
  const projectDir = mkdtempSync(join(tmpdir(), "jinn-oci-project-"));
  const datasetCacheDir = mkdtempSync(join(tmpdir(), "jinn-oci-dataset-"));
  temporaryDirectories.push(directory, projectDir, datasetCacheDir);

  await expect(catalogInspectOciSelection({
    dockerPath: writeSilentFakeDocker(directory),
    imageDigest: `sha256:${"a".repeat(64)}`,
    projectDir,
    datasetCacheDir,
    taskReference: "hermetic_eval.py@fixture",
  })).rejects.toThrow(
    /the OCI Inspect worker catalog probe exited 0 without parseable JSON on stdout \(0 chars, empty\)/u,
  );
});

/**
 * A stand-in for the `docker` CLI that answers the engine-reachability check and then hangs
 * forever on the subcommand named by `hangOn` -- the shape a wedged Docker Engine leaves behind.
 */
function writeHangingFakeDocker(directory: string, hangOn: "version" | "run"): string {
  const dockerPath = join(directory, "docker");
  writeFileSync(dockerPath, [
    `#!${process.execPath}`,
    `if (process.argv[2] === ${JSON.stringify(hangOn)}) setInterval(() => {}, 1000);`,
    "else if (process.argv[2] === 'version') process.stdout.write('{}');",
  ].join("\n"), { mode: 0o755 });
  chmodSync(dockerPath, 0o755);
  return dockerPath;
}

/**
 * #4025. `runBoundedProcess` bounded its child by bytes but not by time, and its `signal`
 * parameter -- the only wall-clock escape it had -- is supplied by no caller on this path. A
 * wedged engine therefore hung the launcher indefinitely instead of refusing, the hazard
 * `JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS` already exists to prevent for the sibling Docker stack.
 * Expiry must be a typed refusal that names the command, distinct from a real non-zero exit.
 */
test("a worker probe that never returns expires as a typed timeout naming the command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-hang-"));
  const projectDir = mkdtempSync(join(tmpdir(), "jinn-oci-project-"));
  const datasetCacheDir = mkdtempSync(join(tmpdir(), "jinn-oci-dataset-"));
  temporaryDirectories.push(directory, projectDir, datasetCacheDir);
  process.env.JINN_INSPECT_OCI_WORKER_TIMEOUT_MS = "300";

  const failure = await catalogInspectOciSelection({
    dockerPath: writeHangingFakeDocker(directory, "run"),
    imageDigest: `sha256:${"a".repeat(64)}`,
    projectDir,
    datasetCacheDir,
    taskReference: "hermetic_eval.py@fixture",
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(InspectOciCommandTimeoutError);
  expect((failure as Error).message).toContain("timed out after 300 ms: docker run");
});

/**
 * The short-lived `docker` calls carry their own, separate bound. A `docker version` that never
 * answers is exactly the wedged engine the reachability check exists to detect, so its expiry must
 * arrive as the actionable unavailability refusal rather than as a hang.
 */
test("a docker engine that never answers refuses as unavailable rather than hanging", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-hang-version-"));
  const projectDir = mkdtempSync(join(tmpdir(), "jinn-oci-project-"));
  const datasetCacheDir = mkdtempSync(join(tmpdir(), "jinn-oci-dataset-"));
  temporaryDirectories.push(directory, projectDir, datasetCacheDir);
  process.env.JINN_INSPECT_OCI_COMMAND_TIMEOUT_MS = "300";

  await expect(catalogInspectOciSelection({
    dockerPath: writeHangingFakeDocker(directory, "version"),
    imageDigest: `sha256:${"a".repeat(64)}`,
    projectDir,
    datasetCacheDir,
    taskReference: "hermetic_eval.py@fixture",
  })).rejects.toBeInstanceOf(InspectOciUnavailableError);
});

const SANDBOX_DIGEST = `sha256:${"b".repeat(64)}`;

const DRIFT_CHECK_COMMANDS = [
  { command: "docker version", selectedBy: '[ "$1" = version ]' },
  { command: "docker image inspect of the worker image", selectedBy: `[ "$5" = ${binding.imageDigest} ]` },
  { command: "docker image inspect of the sandbox image", selectedBy: `[ "$5" = ${SANDBOX_DIGEST} ]` },
] as const;

/**
 * A stand-in for the `docker` CLI that answers the drift check's three commands, except that the
 * one picked by `selectedBy` runs `misbehavior` first.
 */
function writeDriftCheckFakeDocker(directory: string, selectedBy: string, misbehavior: string): string {
  const dockerPath = join(directory, "docker");
  writeFileSync(dockerPath, [
    "#!/bin/sh",
    `if [ "$1" = version ]; then answer='{"Version":"29.0.0","ApiVersion":"1.51","Os":"linux"}'; `
    + `else answer="{\\"Id\\":\\"$5\\",\\"Architecture\\":\\"amd64\\",\\"Os\\":\\"linux\\"}"; fi`,
    `if ${selectedBy}; then ${misbehavior}; fi`,
    "printf '%s\\n' \"$answer\"",
  ].join("\n"), { mode: 0o755 });
  chmodSync(dockerPath, 0o755);
  return dockerPath;
}

function runtimeAssetSha256(name: string): string {
  return createHash("sha256").update(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)))).digest("hex");
}

function driftCheckBinding(dockerPath: string): InspectOciHostBinding {
  const datasetCacheDir = mkdtempSync(join(tmpdir(), "jinn-oci-dataset-"));
  temporaryDirectories.push(datasetCacheDir);
  return InspectOciHostBindingSchema.parse({
    ...binding,
    dockerPath,
    datasetCacheDir,
    sandboxExecution: { provider: INSPECT_SANDBOX_PROVIDER, imageDigest: SANDBOX_DIGEST, platform: binding.platform },
  });
}

/** The sealed identity the fake above and this checkout both satisfy, so that nothing drifts. */
function undriftedManifest(hostBinding: InspectOciHostBinding): InspectSelectionManifest {
  return {
    runtime: {
      execution: {
        datasetCacheSha256: directoryTreeSha256(hostBinding.datasetCacheDir),
        imageDigest: hostBinding.imageDigest,
        dockerEngineVersion: "29.0.0",
        dockerApiVersion: "1.51",
        workerSourceSha256: runtimeAssetSha256("worker.py"),
        runtimeHostSourceSha256: inspectOciRunnerSha256(),
        brokerSourceSha256: runtimeAssetSha256("broker.py"),
        modelProviderSourceSha256: runtimeAssetSha256("model_provider.py"),
        dockerExecutableSha256: createHash("sha256").update(readFileSync(hostBinding.dockerPath)).digest("hex"),
        sandbox: {
          imageDigest: SANDBOX_DIGEST,
          providerSourceSha256: directoryTreeSha256(fileURLToPath(new URL("./sandbox_extension", import.meta.url))),
          controllerSourceSha256: runtimeAssetSha256("sandbox-controller.mjs"),
          policySha256: inspectSandboxPolicySha256(),
          policy: INSPECT_SANDBOX_POLICY,
        },
      },
    },
  } as unknown as InspectSelectionManifest;
}

/**
 * #5139. Node emits `exit` with stdio possibly still open, and on Linux libuv reports a sibling's
 * exit from another child's SIGCHLD, so the drift check's three parallel commands could each be
 * read as an empty stdout. Exiting before answering forces that same order on any platform: the
 * one-off failure this reproduces is the `exited 0 without parseable JSON (0 chars, empty)` that
 * reached every one of these commands in CI, and the command must simply be read to its end.
 */
test.each(DRIFT_CHECK_COMMANDS)("the drift check reads $command to the end of its stdout, not to its exit", async ({ selectedBy }) => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-late-answer-"));
  temporaryDirectories.push(directory);
  const hostBinding = driftCheckBinding(writeDriftCheckFakeDocker(
    directory,
    selectedBy,
    "( sleep 0.2; printf '%s\\n' \"$answer\" ) & exit 0",
  ));

  await expect(assertInspectOciHostUndrifted(hostBinding, undriftedManifest(hostBinding))).resolves.toBeUndefined();
});

/** A command that really did write nothing is not that race. It keeps failing, and says so. */
test.each(DRIFT_CHECK_COMMANDS)("$command that always exits 0 with an empty stdout fails under its own name", async ({ command, selectedBy }) => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-always-empty-"));
  temporaryDirectories.push(directory);
  const hostBinding = driftCheckBinding(writeDriftCheckFakeDocker(directory, selectedBy, "exit 0"));

  await expect(assertInspectOciHostUndrifted(hostBinding, undriftedManifest(hostBinding))).rejects.toThrow(
    `${command} (post-lock drift check) exited 0 without parseable JSON on stdout (0 chars, empty)`,
  );
});

test.each(DRIFT_CHECK_COMMANDS)("$command that exits non-zero fails as that exit", async ({ selectedBy }) => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-nonzero-"));
  temporaryDirectories.push(directory);
  const hostBinding = driftCheckBinding(writeDriftCheckFakeDocker(directory, selectedBy, "exit 1"));

  await expect(assertInspectOciHostUndrifted(hostBinding, undriftedManifest(hostBinding))).rejects.toThrow(
    "OCI runtime command exited 1",
  );
});

/**
 * Waiting for stdio to close must not reopen the hang #4025 closed. Once the command has exited no
 * signal reaches the descendant holding its stdout, so the bound has to end the wait by itself.
 */
test("a descendant that holds stdout after the command exits still expires as a typed timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-held-stdout-"));
  temporaryDirectories.push(directory);
  // Long enough for the fake to have exited first, even on a loaded host, or this proves nothing.
  process.env.JINN_INSPECT_OCI_COMMAND_TIMEOUT_MS = "2000";
  const hostBinding = driftCheckBinding(writeDriftCheckFakeDocker(directory, DRIFT_CHECK_COMMANDS[0].selectedBy, "sleep 10 & exit 0"));

  const startedAt = Date.now();
  const failure = await assertInspectOciHostUndrifted(hostBinding, undriftedManifest(hostBinding)).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(InspectOciCommandTimeoutError);
  expect((failure as Error).message).toContain("timed out after 2000 ms: docker version");
  // A bound that only noticed once the descendant let go would satisfy every line above, ten
  // seconds late.
  expect(Date.now() - startedAt).toBeLessThan(8_000);
});
