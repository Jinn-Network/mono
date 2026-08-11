import { describe, expect, test } from "vitest";
import { buildInspectOciRunArgs, InspectOciHostBindingSchema } from "./oci.js";

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
