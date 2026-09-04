import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildInspectOciRunArgs, catalogInspectOciSelection, InspectOciHostBindingSchema } from "./oci.js";

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
