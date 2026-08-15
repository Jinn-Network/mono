import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
// The runtime asset remains plain ESM so the packed product can execute it directly.
// @ts-expect-error No declarations are published for this private runtime module.
import { createSandboxController, SANDBOX_POLICY, sandboxPolicySha256 } from "./sandbox-controller.mjs";
import { INSPECT_SANDBOX_POLICY, inspectSandboxPolicySha256 } from "./oci.js";

const imageDigest = `sha256:${"a".repeat(64)}`;

function frame(id: string, operation: string, params: Record<string, unknown>) {
  return {
    channel: "sandbox",
    protocol: "jinn.network/inspect-sandbox-host/1",
    id,
    operation,
    params,
  };
}

describe("Inspect sandbox host controller", () => {
  test("binds the fixed policy and never accepts runtime-selected Docker policy", async () => {
    const calls: string[][] = [];
    const controller = createSandboxController({
      dockerPath: "/docker",
      imageDigest,
      containerPrefix: "jinn-inspect-cell",
      async runProcess(_executable: string, args: string[]) {
        calls.push(args);
        if (args[0] === "exec" && args.some((argument) => argument.includes("read_bytes()"))) {
          return { code: 0, stdout: Buffer.from("contents"), stderr: Buffer.alloc(0), timedOut: false, overflow: false };
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, overflow: false };
      },
    });
    const policySha256 = createHash("sha256").update(JSON.stringify(SANDBOX_POLICY)).digest("hex");
    expect(sandboxPolicySha256()).toBe(policySha256);
    expect(INSPECT_SANDBOX_POLICY).toEqual(SANDBOX_POLICY);
    expect(inspectSandboxPolicySha256()).toBe(policySha256);
    const started = await controller.handle(frame("1", "startSample", {
      taskName: "fixture",
      sampleId: "alpha",
      config: {
        schema: "jinn.network/benchmark-product/inspect-sandbox/1",
        imageDigest,
        platform: "linux/amd64",
        policySha256,
      },
    }));
    expect(started.ok).toBe(true);
    const environmentId = started.value.environmentId as string;
    expect(await controller.handle(frame("2", "exec", {
      environmentId,
      cmd: ["python", "-c", "print('ok')"],
      inputBase64: null,
      cwd: null,
      env: {},
      user: null,
      timeoutSeconds: 10,
    }))).toMatchObject({ ok: true, value: { returncode: 0 } });
    await controller.handle(frame("3", "writeFile", {
      environmentId,
      path: "answer.txt",
      contentsBase64: Buffer.from("contents").toString("base64"),
    }));
    expect(await controller.handle(frame("4", "readFile", { environmentId, path: "answer.txt" })))
      .toMatchObject({ ok: true, value: { contentsBase64: Buffer.from("contents").toString("base64") } });
    await controller.handle(frame("5", "finishSample", { environmentId, interrupted: false }));
    expect(await controller.handle(frame("6", "startSample", {
      taskName: "fixture",
      sampleId: "bravo",
      config: { schema: "jinn.network/benchmark-product/inspect-sandbox/1", imageDigest, platform: "linux/amd64", policySha256 },
    }))).toMatchObject({ ok: false, error: { kind: "budget" } });
    await controller.cleanup();

    const start = calls.find((args) => args[0] === "run");
    expect(start).toContain("--pull=never");
    expect(start).toContain("--network=none");
    expect(start).toContain("--read-only");
    expect(start).toContain("--cap-drop=ALL");
    expect(start).toContain("--security-opt=no-new-privileges");
    expect(start).toContain("--tmpfs=/workspace:rw,nosuid,nodev,uid=65532,gid=65532,mode=0700,size=268435456");
    expect(start).not.toEqual(expect.arrayContaining(["--mount", expect.anything()]));
    expect(start).not.toContain("/var/run/docker.sock");
  });

  test("rejects malformed base64 before invoking Docker", async () => {
    const calls: string[][] = [];
    const controller = createSandboxController({
      dockerPath: "/docker",
      imageDigest,
      containerPrefix: "jinn-inspect-cell",
      async runProcess(_executable: string, args: string[]) {
        calls.push(args);
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, overflow: false };
      },
    });
    const started = await controller.handle(frame("1", "startSample", {
      taskName: "fixture",
      sampleId: "alpha",
      config: { schema: "jinn.network/benchmark-product/inspect-sandbox/1", imageDigest, platform: "linux/amd64", policySha256: sandboxPolicySha256() },
    }));
    const environmentId = started.value.environmentId as string;
    const before = calls.length;
    expect(await controller.handle(frame("2", "writeFile", {
      environmentId,
      path: "answer.txt",
      contentsBase64: "not base64",
    }))).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(calls).toHaveLength(before);
    await controller.cleanup();
  });

  test("rejects image drift, unsupported operations, user escalation, and a second environment", async () => {
    const controller = createSandboxController({
      dockerPath: "/docker",
      imageDigest,
      containerPrefix: "jinn-inspect-cell",
      async runProcess() {
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, overflow: false };
      },
    });
    const bad = await controller.handle(frame("1", "startSample", {
      taskName: "fixture",
      sampleId: "alpha",
      config: {
        schema: "jinn.network/benchmark-product/inspect-sandbox/1",
        imageDigest: `sha256:${"b".repeat(64)}`,
        platform: "linux/amd64",
        policySha256: sandboxPolicySha256(),
      },
    }));
    expect(bad).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const started = await controller.handle(frame("2", "startSample", {
      taskName: "fixture",
      sampleId: "alpha",
      config: {
        schema: "jinn.network/benchmark-product/inspect-sandbox/1",
        imageDigest,
        platform: "linux/amd64",
        policySha256: sandboxPolicySha256(),
      },
    }));
    const environmentId = started.value.environmentId as string;
    expect(await controller.handle(frame("3", "startSample", {
      taskName: "fixture",
      sampleId: "bravo",
      config: { schema: "jinn.network/benchmark-product/inspect-sandbox/1", imageDigest, platform: "linux/amd64", policySha256: sandboxPolicySha256() },
    }))).toMatchObject({ ok: false, error: { kind: "budget" } });
    expect(await controller.handle(frame("4", "exec", {
      environmentId,
      cmd: ["id"],
      inputBase64: null,
      cwd: null,
      env: {},
      user: "0",
      timeoutSeconds: 10,
    }))).toMatchObject({ ok: false, error: { kind: "permission" } });
    expect(await controller.handle(frame("5", "createNetwork", { environmentId })))
      .toMatchObject({ ok: false, error: { kind: "unsupported" } });
    await controller.cleanup();
  });
});
