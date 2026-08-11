// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, sha256Hex } from "./canonical.js";
import { graderProgramDigest } from "./grader-program.js";
import {
  exactSweRebenchTestCommands,
  pinnedSweRebenchImage,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
  sweRebenchOciGraderReportSource,
} from "./swe-rebench-source.js";

const IMAGE_DIGEST = "c".repeat(64);
const IMAGE = `example.registry/sweb.eval.x86_64.acme__widget-1@sha256:${IMAGE_DIGEST}`;

const ROW = {
  FAIL_TO_PASS: ["tests/test_a.py::test_a"],
  PASS_TO_PASS: ["tests/test_b.py::test_b"],
  base_commit: "0".repeat(40),
  image_name: "swerebench/sweb.eval.x86_64.acme__widget-1",
  install_config: { install: ["pip install -e ."], log_parser: "parse_log_pytest", test_cmd: ["pytest -rA"] },
  instance_id: "acme__widget-1",
  repo: "acme/widget",
  test_patch: "diff --git a/tests/test_a.py b/tests/test_a.py\n",
};

function specification(overrides: Record<string, unknown> = {}) {
  const material = canonicalJsonBytes(ROW);
  return {
    family: "deterministic-process" as const,
    familyBlock: {
      image: { name: "swe-rebench-grader-image", uri: `docker://${IMAGE}`, digest: { sha256: IMAGE_DIGEST } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [{
        name: "swe-rebench-evaluation-row",
        content: Buffer.from(material).toString("base64"),
        digest: { sha256: sha256Hex(material) },
        mediaType: "application/json",
      }],
      transitions: { failToPass: ROW.FAIL_TO_PASS, passToPass: ROW.PASS_TO_PASS },
      timeout: 1800,
      ...overrides,
    },
  } as never;
}

function request(spec = specification(), deadlineSignal: AbortSignal = new AbortController().signal) {
  const work = mkdtempSync(join(tmpdir(), "jinn-oci-src-"));
  return {
    work,
    request: {
      specification: spec,
      task: { bytes: new Uint8Array(), descriptor: { name: "task", digest: { sha256: "d".repeat(64) } } },
      results: [{
        bytes: new TextEncoder().encode("diff --git a/x b/x\n"),
        descriptor: { name: "result.patch", digest: { sha256: "e".repeat(64) } },
      }],
      attempt: { attemptUri: "urn:jinn:attempt:1", attemptNumber: 1 },
      deadlineSignal,
    } as never,
  };
}

describe("pinnedSweRebenchImage", () => {
  it("accepts an exact docker:// sha256 reference and converts the timeout to milliseconds", () => {
    expect(pinnedSweRebenchImage(specification())).toEqual({
      image: IMAGE, platform: "linux/amd64", timeoutMs: 1_800_000,
    });
  });

  it("refuses a mutable tag", () => {
    expect(() => pinnedSweRebenchImage(specification({
      image: { uri: "docker://swerebench/sweb.eval:latest" },
    }))).toThrow(/exact docker sha256 reference/u);
  });

  it("refuses when the declared image digest disagrees with the digest embedded in the URI", () => {
    // The URI's digest must not silently win over a different declared descriptor digest — that
    // would let a spec show one (benign) digest while a different image is actually pulled.
    expect(() => pinnedSweRebenchImage(specification({
      image: { uri: `docker://${IMAGE}`, digest: { sha256: "d".repeat(64) } },
    }))).toThrow(/image digest does not match/u);
  });

  it("refuses a docker-flag-shaped image URI, never admitting it as an image reference", () => {
    const hex = "a".repeat(64);
    const flagShaped = [
      `--volume=/:/hostfs@sha256:${hex}`,
      `--privileged@sha256:${hex}`,
      `../../etc/passwd@sha256:${hex}`,
      `UPPER/Repo@sha256:${hex}`,
    ];
    for (const body of flagShaped) {
      expect(() => pinnedSweRebenchImage(specification({
        image: { uri: `docker://${body}` },
      }))).toThrow(/exact docker sha256 reference/u);
    }
  });
});

describe("exactSweRebenchTestCommands", () => {
  it("passes the benchmark's own commands through unchanged", () => {
    expect(exactSweRebenchTestCommands({ logParser: "parse_log_pytest", commands: ["pytest -rA"] }))
      .toEqual(["pytest -rA"]);
  });

  it("refuses an unsupported log parser and an empty command", () => {
    expect(() => exactSweRebenchTestCommands({ logParser: "parse_log_other", commands: ["x"] }))
      .toThrow(/unsupported sealed log parser/u);
    expect(() => exactSweRebenchTestCommands({ logParser: "parse_log_pytest", commands: [] }))
      .toThrow(/empty or invalid/u);
  });
});

describe("sweRebenchOciGraderReportSource", () => {
  it("runs the pinned image with network none and returns the canonical report and log", async () => {
    const { work, request: input } = request();
    const runner = vi.fn(async (invocation: { outputDirectory: string }) => {
      writeFileSync(join(invocation.outputDirectory, "verdict"),
        canonicalJsonBytes({ log: "1 passed", report: { instance_id: "acme__widget-1" } }));
      return canonicalJsonBytes({ log: "1 passed", report: { instance_id: "acme__widget-1" } });
    });
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: runner,
    } as never);

    const report = await source.read(input);

    expect(report.log).toBe("1 passed");
    expect(report.report).toEqual({ instance_id: "acme__widget-1" });
    const call = runner.mock.calls[0]![0] as unknown as
      { image: string; profileRequiresNetwork: boolean; entrypoint: string };
    expect(call.image).toBe(IMAGE);
    expect(call.profileRequiresNetwork).toBe(false);
    expect(call.entrypoint).toBe("python3");
  });

  it("mounts the frozen grader program, the config, the patch and the test patch", async () => {
    const { work, request: input } = request();
    const runner = vi.fn(async (_input: unknown) => canonicalJsonBytes({ log: "", report: {} }));
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work, runPinnedOciGraderForTesting: runner,
    } as never);

    await source.read(input);

    const call = runner.mock.calls[0]![0] as { inputs: { targetName: string }[] };
    expect(call.inputs.map((entry) => entry.targetName).sort())
      .toEqual(["config.json", "grader.py", "patch.diff", "test-patch.diff"]);
  });

  it("mounts the grader program bytes that hash to exactly the published digest", async () => {
    // The source is deleted in a `finally` once `read()` returns, so the mounted file can only be
    // inspected from inside the injected runner — verifying after `read()` resolves would read a
    // path that no longer exists.
    const { work, request: input } = request();
    let mountedProgramDigest: string | undefined;
    const runner = vi.fn(async (invocation: { inputs: { targetName: string; source: string }[] }) => {
      const program = invocation.inputs.find((entry) => entry.targetName === "grader.py");
      if (program === undefined) throw new Error("grader.py was not mounted");
      mountedProgramDigest = `sha256:${sha256Hex(new Uint8Array(readFileSync(program.source)))}`;
      return canonicalJsonBytes({ log: "", report: {} });
    });
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work, runPinnedOciGraderForTesting: runner,
    } as never);

    await source.read(input);

    expect(mountedProgramDigest).toBe(graderProgramDigest());
  });

  it("refuses row material whose bytes do not match its declared digest", async () => {
    const spec = specification();
    (spec as never as { familyBlock: { testMaterial: { digest: { sha256: string } }[] } })
      .familyBlock.testMaterial[0]!.digest.sha256 = "f".repeat(64);
    const { work, request: input } = request(spec);
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/row material digest/u);
  });

  it("matches a public row material digest case-insensitively", async () => {
    const spec = specification();
    (spec as never as { familyBlock: { testMaterial: { digest: { sha256: string } }[] } })
      .familyBlock.testMaterial[0]!.digest.sha256 =
      (spec as never as { familyBlock: { testMaterial: { digest: { sha256: string } }[] } })
        .familyBlock.testMaterial[0]!.digest.sha256.toUpperCase();
    const { work, request: input } = request(spec);
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).resolves.toBeDefined();
  });

  it("refuses a specification carrying no row material", async () => {
    const { work, request: input } = request(specification({ testMaterial: [] }));
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/no exact public row material/u);
  });

  it("refuses grader output that is not exact canonical JSON", async () => {
    const { work, request: input } = request();
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => new TextEncoder().encode('{ "report": {}, "log": "" }'),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/not exact canonical data/u);
  });

  it("refuses more or fewer than exactly one solver patch Result", async () => {
    const { work, request: input } = request();
    (input as never as { results: unknown[] }).results = [];
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/exactly one solver patch Result/u);
  });

  it("keeps the public-network extension opt-in and refuses a non-true value", async () => {
    const { work, request: input } = request(
      specification({ [SWE_REBENCH_PUBLIC_NETWORK_EXTENSION]: "yes" }),
    );
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/public-network extension is not true/u);
  });

  it("refuses the public-network extension when the host has not opted in", async () => {
    const { work, request: input } = request(
      specification({ [SWE_REBENCH_PUBLIC_NETWORK_EXTENSION]: true }),
    );
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
      // allowPublicNetwork omitted: defaults to false, so a specification alone cannot turn on
      // network access.
    } as never);

    await expect(source.read(input)).rejects.toThrow(/host to opt in via allowPublicNetwork/u);
  });

  it("grants the profile network when the host opts in with allowPublicNetwork: true", async () => {
    const { work, request: input } = request(
      specification({ [SWE_REBENCH_PUBLIC_NETWORK_EXTENSION]: true }),
    );
    const runner = vi.fn(async (_input: unknown) => canonicalJsonBytes({ log: "", report: {} }));
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      allowPublicNetwork: true,
      runPinnedOciGraderForTesting: runner,
    } as never);

    await source.read(input);

    const call = runner.mock.calls[0]![0] as unknown as { profileRequiresNetwork: boolean };
    expect(call.profileRequiresNetwork).toBe(true);
  });

  it("refuses with a typed cancellation when the deadline has already elapsed before grading starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { work, request: input } = request(specification(), controller.signal);
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    const rejection = source.read(input);
    await expect(rejection).rejects.toThrow(/deadline elapsed/u);
    await expect(rejection).rejects.toMatchObject({ name: "EvaluationOperationalError" });
  });

  it("returns a report the container already produced even if the deadline aborts while it ran", async () => {
    // The deadline signal firing mid-run must not discard finished grading work: the container
    // already completed, so its report is the correct outcome even if the signal aborted a
    // moment later, concurrently with (not before) that completion.
    const controller = new AbortController();
    const { work, request: input } = request(specification(), controller.signal);
    const runner = vi.fn(async () => {
      controller.abort(); // the attempt deadline elapses while the container is finishing up
      return canonicalJsonBytes({ log: "1 passed", report: { instance_id: "acme__widget-1" } });
    });
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: runner,
    } as never);

    const report = await source.read(input);

    expect(report.log).toBe("1 passed");
    expect(report.report).toEqual({ instance_id: "acme__widget-1" });
  });
});
