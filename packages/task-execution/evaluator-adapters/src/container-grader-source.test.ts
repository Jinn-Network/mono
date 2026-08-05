// SPDX-License-Identifier: Apache-2.0

import {
  EvaluationOperationalError,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SWE_REBENCH_PARSER } from "./parser-identity.js";
import {
  containerGraderReportSource,
  DEFAULT_GRADER_CONTAINER_WORKDIR,
  EVALUATION_CONTEXT_NAME,
  GRADER_CONTEXT_SCHEMA,
  GRADER_OUTPUT_NAME,
  SUBJECT_DIRECTORY_NAME,
  type ContainerRunRequest,
  type ContainerRunResult,
  type ContainerRuntime,
} from "./container-grader-source.js";

const encoder = new TextEncoder();
const IMAGE_DIGEST = "2".repeat(64);

const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptIdentity["attemptUri"],
  nonce: "evaluation-nonce",
  attemptNumber: 3,
};

function material(name: string, text: string): ExactEvaluationMaterial {
  return {
    descriptor: { name, digest: { sha256: "1".repeat(64) } },
    bytes: encoder.encode(text),
  };
}

function specification(overrides: {
  readonly image?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly platform?: string;
  readonly timeout?: number;
} = {}): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: SWE_REBENCH_PARSER.id,
      digest: { sha256: SWE_REBENCH_PARSER.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: overrides.image ?? { name: "grader-image", digest: { sha256: IMAGE_DIGEST } },
      platform: overrides.platform ?? "linux/amd64",
      workspace: overrides.workspace ?? {},
      testMaterial: [],
      parser: SWE_REBENCH_PARSER,
      transitions: { failToPass: ["t::a"], passToPass: [] },
      timeout: overrides.timeout ?? 1800,
    },
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [{ name: "environment-setup-failure", disposition: "retryable-infrastructure" }],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

async function workspace(): Promise<{ readonly root: string; readonly workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "jinn-container-grader-"));
  await writeFile(join(root, "sentinel"), "untouched");
  return { root, workspaceRoot: join(root, "ws") };
}

/** The host directory the container sees at its working directory. */
function hostWorkdir(request: ContainerRunRequest): string {
  const mount = (request.mounts ?? []).find((candidate) => candidate.target === request.workdir);
  if (mount === undefined) throw new Error("the grader run declares no mount at its working directory");
  return mount.source;
}

function runtimeWriting(
  output: string | undefined,
  result: ContainerRunResult = { exitCode: 0, stdout: "PASSED\n" },
): ContainerRuntime & { readonly run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (request: ContainerRunRequest) => {
      if (output !== undefined) {
        await writeFile(join(hostWorkdir(request), GRADER_OUTPUT_NAME), output);
      }
      return result;
    }),
  };
}

function read(
  source: ReturnType<typeof containerGraderReportSource>,
  input: {
    readonly specification?: EvaluationSpec;
    readonly results?: readonly ExactEvaluationMaterial[];
    readonly deadlineSignal?: AbortSignal;
  } = {},
) {
  return source.read({
    specification: input.specification ?? specification(),
    task: material("subject-task.json", "{\"instance_id\":\"acme__widget-1\"}"),
    results: input.results ?? [material("model.patch", "diff --git a/a b/a\n")],
    context: {},
    attempt: ATTEMPT,
    deadlineSignal: input.deadlineSignal ?? new AbortController().signal,
  });
}

async function operationalFrom(promise: Promise<unknown>): Promise<EvaluationOperationalError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(EvaluationOperationalError);
  return error as EvaluationOperationalError;
}

describe("containerGraderReportSource", () => {
  test("runs the pinned grader image and returns its report with the container log", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting('{"instance_id":"acme__widget-1","exit_code":0}');
    const raw = await read(containerGraderReportSource({ runtime, workspaceRoot }));

    expect(raw).toEqual({
      report: { instance_id: "acme__widget-1", exit_code: 0 },
      log: "PASSED\n",
    });
    expect(runtime.run).toHaveBeenCalledTimes(1);
    const request = runtime.run.mock.calls[0]![0] as ContainerRunRequest;
    expect(request.image).toBe(`grader-image@sha256:${IMAGE_DIGEST}`);
    expect(request.platform).toBe("linux/amd64");
    expect(request.workdir).toBe(DEFAULT_GRADER_CONTAINER_WORKDIR);
    expect(request.mounts).toEqual([
      { source: hostWorkdir(request), target: DEFAULT_GRADER_CONTAINER_WORKDIR, readOnly: false },
    ]);
  });

  test("a nonzero container exit with a readable report is the adapter's parse decision, not an error", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting(
      '{"instance_id":"acme__widget-1","exit_code":1}',
      { exitCode: 1, stdout: "FAILED tests/test_a.py::t\n" },
    );
    const raw = await read(containerGraderReportSource({ runtime, workspaceRoot }));

    expect(raw.report).toEqual({ instance_id: "acme__widget-1", exit_code: 1 });
    expect(raw.log).toBe("FAILED tests/test_a.py::t\n");
  });

  test("a container that writes no report is an operational failure, never a verdict", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting(undefined, { exitCode: 137, stdout: "" });
    const error = await operationalFrom(read(containerGraderReportSource({ runtime, workspaceRoot })));

    expect(error.canonicalCode).toBe("UNAVAILABLE");
    expect(error.reason).toBe("provider-unavailable");
    expect(error.recoveryAdvice).toBe("new-attempt-required");
    expect(error.safeDetail).toContain(GRADER_OUTPUT_NAME);
    expect(error.safeDetail).toContain("137");
  });

  test("a report that is not a JSON object is an operational failure, never a verdict", async () => {
    const { workspaceRoot } = await workspace();
    for (const output of ["not json", "[1,2]", "null", ""]) {
      const runtime = runtimeWriting(output);
      const error = await operationalFrom(read(containerGraderReportSource({ runtime, workspaceRoot })));
      expect(error.canonicalCode).toBe("UNAVAILABLE");
      expect(error.reason).toBe("provider-unavailable");
    }
  });

  test("an absent container runtime is provider-unavailable, never a verdict", async () => {
    const { workspaceRoot } = await workspace();
    const runtime: ContainerRuntime = {
      async run() {
        throw new Error("spawn docker ENOENT");
      },
    };
    const error = await operationalFrom(read(containerGraderReportSource({ runtime, workspaceRoot })));

    expect(error.canonicalCode).toBe("UNAVAILABLE");
    expect(error.reason).toBe("provider-unavailable");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("an already-elapsed evaluation deadline never starts a container", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const controller = new AbortController();
    controller.abort();
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), { deadlineSignal: controller.signal }),
    );

    expect(error.canonicalCode).toBe("CANCELLED");
    expect(error.recoveryAdvice).toBe("resume-attempt");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test("an evaluation deadline that elapses mid-run aborts the container and yields CANCELLED", async () => {
    const { workspaceRoot } = await workspace();
    const controller = new AbortController();
    const runtime: ContainerRuntime = {
      async run(request) {
        expect(request.timeoutSignal).toBeDefined();
        controller.abort();
        await new Promise((resolve) => { setTimeout(resolve, 1); });
        // A SIGTERMed container: the runtime returns the signal exit code and no report.
        return { exitCode: 143, stdout: "" };
      },
    };
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), { deadlineSignal: controller.signal }),
    );

    expect(error.canonicalCode).toBe("CANCELLED");
    expect(error.recoveryAdvice).toBe("resume-attempt");
  });

  test("a complete report is returned even when the deadline elapses at return time", async () => {
    const { workspaceRoot } = await workspace();
    const controller = new AbortController();
    const runtime: ContainerRuntime = {
      async run(request) {
        await writeFile(join(hostWorkdir(request), GRADER_OUTPUT_NAME), '{"exit_code":0}');
        // The grader finished; the deadline elapses on the way back. The grading still happened.
        controller.abort();
        return { exitCode: 0, stdout: "PASSED\n" };
      },
    };
    const raw = await read(containerGraderReportSource({ runtime, workspaceRoot }), {
      deadlineSignal: controller.signal,
    });

    expect(raw).toEqual({ report: { exit_code: 0 }, log: "PASSED\n" });
  });

  test("the specification's own timeout bounds the run and yields DEADLINE_EXCEEDED", async () => {
    const { workspaceRoot } = await workspace();
    const runtime: ContainerRuntime = {
      async run(request) {
        const signal = request.timeoutSignal!;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { resolve(); }, { once: true });
        });
        return { exitCode: 143, stdout: "" };
      },
    };
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ timeout: 1 }),
      }),
    );

    expect(error.canonicalCode).toBe("DEADLINE_EXCEEDED");
    expect(error.recoveryAdvice).toBe("new-attempt-required");
  });

  test("the container working directory comes from the specification's declared workspace root", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }), {
      specification: specification({ workspace: { root: "/testbed" } }),
    });

    const request = runtime.run.mock.calls[0]![0] as ContainerRunRequest;
    expect(request.workdir).toBe("/testbed");
    expect(request.mounts?.[0]?.target).toBe("/testbed");
  });

  test("an unpinned grader image is refused — a digest is the semantic commitment", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ image: { uri: "ghcr.io/acme/grader:latest" } }),
      }),
    );

    expect(error.canonicalCode).toBe("FAILED_PRECONDITION");
    expect(error.reason).toBe("unsupported-specification");
    expect(error.recoveryAdvice).toBe("do-not-retry");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test("an image whose reference and digest pin different images is refused", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({
          image: { uri: `ghcr.io/acme/grader@sha256:${"3".repeat(64)}`, digest: { sha256: IMAGE_DIGEST } },
        }),
      }),
    );

    expect(error.canonicalCode).toBe("FAILED_PRECONDITION");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test("an already-pinned image reference is passed through unchanged", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }), {
      specification: specification({
        image: { uri: `ghcr.io/acme/grader@sha256:${IMAGE_DIGEST}`, digest: { sha256: IMAGE_DIGEST } },
      }),
    });

    expect((runtime.run.mock.calls[0]![0] as ContainerRunRequest).image)
      .toBe(`ghcr.io/acme/grader@sha256:${IMAGE_DIGEST}`);
  });

  // Every value below reaches a container driver as an argument. A reference that is not a
  // reference lands in the positional slot docker parses as an option, so each of these is
  // refused before anything is provisioned or run.
  const HOSTILE_IMAGES: readonly (readonly [string, Record<string, unknown>])[] = [
    ["an image reference that is a docker flag", { uri: "--mount=type=bind,src=/,dst=/hostfs" }],
    ["an image reference that is a privileged flag", { name: "-v/:/hostfs" }],
    ["an image reference carrying a shell separator", { name: "grader-image;touch /tmp/pwn" }],
    ["an image reference carrying a newline", { name: "grader-image\n--privileged" }],
    ["an image reference carrying a space", { name: "grader-image --privileged" }],
    ["an image reference carrying a substitution", { name: "grader-image$(id)" }],
    ["an image reference that is empty", { name: "" }],
    ["an image reference that is only whitespace", { name: "   " }],
  ];

  test.each(HOSTILE_IMAGES)("%s is refused before anything runs", async (_label, image) => {
    const { root, workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ image: { ...image, digest: { sha256: IMAGE_DIGEST } } }),
      }),
    );

    expect(error.canonicalCode).toBe("FAILED_PRECONDITION");
    expect(error.reason).toBe("unsupported-specification");
    expect(error.recoveryAdvice).toBe("do-not-retry");
    expect(runtime.run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  test.each([
    "linux/amd64 --privileged",
    "linux/amd64;id",
    "linux/amd64\n",
    "--privileged",
    "",
  ])("the hostile platform %j is refused before anything runs", async (platform) => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ platform }),
      }),
    );

    expect(error.canonicalCode).toBe("FAILED_PRECONDITION");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test.each([
    "/testbed;touch$(id)",
    "/../../etc",
    "/testbed/../..",
    "/testbed --privileged",
    "/testbed\n",
    "relative/testbed",
    "/",
  ])("the hostile workspace root %j is refused before anything runs", async (root) => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ workspace: { root } }),
      }),
    );

    expect(error.canonicalCode).toBe("FAILED_PRECONDITION");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  // The docker reference grammar is total, so the validator must refuse nothing legitimate.
  test.each([
    "grader-image",
    "ghcr.io/acme/grader",
    "localhost:5000/team/sub/grader",
    "docker.io/library/python",
    "acme/grader_v2.1",
    "ghcr.io/acme/grader:2026-08-05",
  ])("the legitimate image reference %j runs", async (name) => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }), {
      specification: specification({ image: { name, digest: { sha256: IMAGE_DIGEST } } }),
    });

    expect((runtime.run.mock.calls[0]![0] as ContainerRunRequest).image)
      .toBe(`${name}@sha256:${IMAGE_DIGEST}`);
  });

  test.each(["linux/amd64", "linux/arm64", "linux/arm/v7", "windows/amd64"])(
    "the legitimate platform %j runs",
    async (platform) => {
      const { workspaceRoot } = await workspace();
      const runtime = runtimeWriting("{}");
      await read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ platform }),
      });

      expect((runtime.run.mock.calls[0]![0] as ContainerRunRequest).platform).toBe(platform);
    },
  );

  test.each(["/testbed", "/jinn/evaluation", "/opt/grader-v2/work_dir", "/a.b/c-d/e_f"])(
    "the legitimate workspace root %j runs",
    async (root) => {
      const { workspaceRoot } = await workspace();
      const runtime = runtimeWriting("{}");
      await read(containerGraderReportSource({ runtime, workspaceRoot }), {
        specification: specification({ workspace: { root } }),
      });

      expect((runtime.run.mock.calls[0]![0] as ContainerRunRequest).workdir).toBe(root);
    },
  );

  test("a non-deterministic-process specification is refused", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const modelGraded = { ...specification(), family: "model-graded" } as unknown as EvaluationSpec;
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), { specification: modelGraded }),
    );

    expect(error.reason).toBe("unsupported-specification");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test("subject material lands under the workspace, indexed by the evaluation context", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }));

    const workdir = hostWorkdir(runtime.run.mock.calls[0]![0] as ContainerRunRequest);
    const context = JSON.parse(await readFile(join(workdir, EVALUATION_CONTEXT_NAME), "utf8"));
    expect(context).toEqual({
      schema: GRADER_CONTEXT_SCHEMA,
      attempt: { attemptUri: ATTEMPT.attemptUri, attemptNumber: 3 },
      task: {
        name: "subject-task.json",
        digest: `sha256:${"1".repeat(64)}`,
        path: `${SUBJECT_DIRECTORY_NAME}/task`,
      },
      results: [{
        name: "model.patch",
        digest: `sha256:${"1".repeat(64)}`,
        path: `${SUBJECT_DIRECTORY_NAME}/result-0`,
      }],
      specification: { family: "deterministic-process", platform: "linux/amd64", timeoutSeconds: 1800 },
    });
    expect(await readFile(join(workdir, SUBJECT_DIRECTORY_NAME, "result-0"), "utf8"))
      .toBe("diff --git a/a b/a\n");
  });

  test("the attempt nonce never reaches the container", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }));

    const workdir = hostWorkdir(runtime.run.mock.calls[0]![0] as ContainerRunRequest);
    const context = await readFile(join(workdir, EVALUATION_CONTEXT_NAME), "utf8");
    expect(context).not.toContain(ATTEMPT.nonce);
  });

  test("a traversing subject name is written to its positional path, never followed", async () => {
    const { root, workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }), {
      results: [material("../../escape.patch", "escaped")],
    });

    const workdir = hostWorkdir(runtime.run.mock.calls[0]![0] as ContainerRunRequest);
    expect(await readFile(join(workdir, SUBJECT_DIRECTORY_NAME, "result-0"), "utf8")).toBe("escaped");
    expect(await readdir(join(workdir, SUBJECT_DIRECTORY_NAME))).toEqual(["result-0", "task"]);
    // The declared name survives as metadata only.
    const context = JSON.parse(await readFile(join(workdir, EVALUATION_CONTEXT_NAME), "utf8"));
    expect(context.results[0]).toEqual({
      name: "../../escape.patch",
      digest: `sha256:${"1".repeat(64)}`,
      path: `${SUBJECT_DIRECTORY_NAME}/result-0`,
    });
    expect((await readdir(root)).sort()).toEqual(["sentinel", "ws"]);
  });

  test("several Results never share an on-disk path", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }), {
      results: [material("same.patch", "first"), material("same.patch", "second")],
    });

    const workdir = hostWorkdir(runtime.run.mock.calls[0]![0] as ContainerRunRequest);
    expect(await readFile(join(workdir, SUBJECT_DIRECTORY_NAME, "result-0"), "utf8")).toBe("first");
    expect(await readFile(join(workdir, SUBJECT_DIRECTORY_NAME, "result-1"), "utf8")).toBe("second");
  });

  test("a subject carrying no well-formed sha256 digest is refused before anything is written", async () => {
    const { root, workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const error = await operationalFrom(
      read(containerGraderReportSource({ runtime, workspaceRoot }), {
        results: [{
          descriptor: { name: "model.patch", digest: { sha256: "not-a-digest" } },
          bytes: encoder.encode("x"),
        }],
      }),
    );

    expect(error.canonicalCode).toBe("INVALID_ARGUMENT");
    expect(error.reason).toBe("subject-digest-mismatch");
    expect(error.recoveryAdvice).toBe("do-not-retry");
    expect(runtime.run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  test("the source writes nothing outside its provisioned workspace, at 0700/0600", async () => {
    const { root, workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }));

    expect((await readdir(root)).sort()).toEqual(["sentinel", "ws"]);
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("untouched");
    // A workspace root this source had to create is private like everything under it.
    expect((await stat(workspaceRoot)).mode & 0o777).toBe(0o700);
    const provisioned = await readdir(workspaceRoot);
    expect(provisioned).toHaveLength(1);
    const workdir = join(workspaceRoot, provisioned[0]!);
    expect(workdir).toBe(hostWorkdir(runtime.run.mock.calls[0]![0] as ContainerRunRequest));
    expect((await stat(workdir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(workdir, SUBJECT_DIRECTORY_NAME))).mode & 0o777).toBe(0o700);
    expect((await stat(join(workdir, EVALUATION_CONTEXT_NAME))).mode & 0o777).toBe(0o600);
    // No temporary file survives the atomic write.
    expect((await readdir(workdir)).sort())
      .toEqual([EVALUATION_CONTEXT_NAME, GRADER_OUTPUT_NAME, SUBJECT_DIRECTORY_NAME].sort());
  });

  test("two reads against one workspace root never share a directory", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    const source = containerGraderReportSource({ runtime, workspaceRoot });
    await read(source);
    await read(source);

    expect(new Set(await readdir(workspaceRoot)).size).toBe(2);
  });

  test("the container inherits no ambient environment and no capability grant", async () => {
    const { workspaceRoot } = await workspace();
    process.env["JINN_CONTAINER_GRADER_AMBIENT_PROBE"] = "leaked";
    try {
      const runtime = runtimeWriting("{}");
      await read(containerGraderReportSource({ runtime, workspaceRoot }));
      const request = runtime.run.mock.calls[0]![0] as ContainerRunRequest;
      expect(request.env).toEqual({});
    } finally {
      delete process.env["JINN_CONTAINER_GRADER_AMBIENT_PROBE"];
    }
  });

  test("only the host's explicitly configured environment reaches the container", async () => {
    const { workspaceRoot } = await workspace();
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({
      runtime,
      workspaceRoot,
      env: { HTTP_PROXY: "http://proxy.internal:3128" },
    }));

    const request = runtime.run.mock.calls[0]![0] as ContainerRunRequest;
    expect(request.env).toEqual({ HTTP_PROXY: "http://proxy.internal:3128" });
  });

  test("an existing workspace root is reused without widening its permissions", async () => {
    const { workspaceRoot } = await workspace();
    await mkdir(workspaceRoot, { recursive: true, mode: 0o755 });
    const runtime = runtimeWriting("{}");
    await read(containerGraderReportSource({ runtime, workspaceRoot }));

    expect((await stat(workspaceRoot)).mode & 0o777).toBe(0o755);
    expect(await readdir(workspaceRoot)).toHaveLength(1);
  });
});
