// #2542: the swe-rebench-v2 deployment module's per-operator sidecar accepts an optional
// `dockerPath`, threaded into `createDockerContainerRuntime`'s `dockerPath` option -- the fix for
// container grading dying with `spawn docker ENOENT` on hosts (e.g. macOS Docker Desktop) where the
// docker binary is not on the daemon's inherited PATH. This file proves the sidecar-to-driver
// threading in isolation, mocking the Docker driver import so no real container runs. It is
// deliberately a SEPARATE file from swe-rebench-deployment.test.ts (which exercises the real driver
// through the full composition path) so the `vi.mock` here cannot leak into that file's assertions.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH,
  SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
  writeSweRebenchEvaluatorSidecar,
} from "../../src/native-evaluator/deployment-paths.js";

const AGENT = "urn:jinn:evaluator:swe-rebench-docker-path-fixture";
const MODULE_HREF = pathToFileURL(SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH).href;
const CLIENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
let claimEvidenceRoot: string;

/** Every options object the mocked driver was constructed with, in call order. */
const dockerRuntimeCalls: Array<Record<string, unknown>> = [];

// The relative specifier below must resolve to the SAME absolute file the deployment module itself
// imports (`../../dist/daemon/native-evaluator-container-runtime.js` from
// `operator/deployments/evaluator/`) -- both this test file and the deployment module sit two
// directories below `operator/`, so the same relative path reaches the same file.
vi.mock("../../dist/daemon/native-evaluator-container-runtime.js", () => ({
  createDockerContainerRuntime: (options: Record<string, unknown> = {}) => {
    dockerRuntimeCalls.push(options);
    return { run: async () => ({ exitCode: 0, stdout: "" }) };
  },
}));

/** Same helper as swe-rebench-deployment.test.ts -- makes the mocked specifier resolvable on a
 * source checkout with no prior `yarn build`. */
async function ensureDriverDist(): Promise<void> {
  const distDriver = join(CLIENT_ROOT, "dist", "daemon", "native-evaluator-container-runtime.js");
  if (existsSync(distDriver)) return;
  const source = await readFile(
    join(CLIENT_ROOT, "src", "daemon", "native-evaluator-container-runtime.ts"),
    "utf-8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  await mkdir(dirname(distDriver), { recursive: true });
  await writeFile(distDriver, outputText);
}

beforeAll(async () => {
  await ensureDriverDist();
  claimEvidenceRoot = await mkdtemp(join(tmpdir(), "jinn-swe-rebench-docker-path-evidence-"));
  roots.push(claimEvidenceRoot);
});

afterEach(() => {
  dockerRuntimeCalls.length = 0;
});

afterAll(async () => {
  await rm(SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, { force: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("swe-rebench-v2 deployment module — sidecar dockerPath threading (#2542)", () => {
  it("threads an absolute sidecar dockerPath into createDockerContainerRuntime", async () => {
    await writeSweRebenchEvaluatorSidecar({
      agent: AGENT,
      claimEvidenceDir: claimEvidenceRoot,
      dockerPath: "/usr/local/bin/docker",
    });
    await import(`${MODULE_HREF}?docker-path-case=absolute`);
    expect(dockerRuntimeCalls).toHaveLength(1);
    expect(dockerRuntimeCalls[0]!.dockerPath).toBe("/usr/local/bin/docker");
  });

  it("omits dockerPath when the sidecar does not declare one -- bare \"docker\" stays unchanged", async () => {
    await writeSweRebenchEvaluatorSidecar({ agent: AGENT, claimEvidenceDir: claimEvidenceRoot });
    await import(`${MODULE_HREF}?docker-path-case=absent`);
    expect(dockerRuntimeCalls).toHaveLength(1);
    expect("dockerPath" in dockerRuntimeCalls[0]!).toBe(false);
  });

  it("refuses a relative dockerPath loudly at sidecar read, never reaching the driver", async () => {
    await writeSweRebenchEvaluatorSidecar({
      agent: AGENT,
      claimEvidenceDir: claimEvidenceRoot,
      dockerPath: "relative/docker",
    });
    await expect(import(`${MODULE_HREF}?docker-path-case=relative`))
      .rejects.toThrow(/"dockerPath" must be an absolute path/);
    expect(dockerRuntimeCalls).toHaveLength(0);
  });

  it("rejects a present, non-string dockerPath instead of silently ignoring it", async () => {
    await writeFile(
      SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
      `${JSON.stringify({ agent: AGENT, claimEvidenceDir: claimEvidenceRoot, dockerPath: 7 })}\n`,
    );
    await expect(import(`${MODULE_HREF}?docker-path-case=non-string`))
      .rejects.toThrow(/"dockerPath".*must be a string/);
    expect(dockerRuntimeCalls).toHaveLength(0);
  });
});
