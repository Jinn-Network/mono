// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPinnedOciInvocation, type PinnedOciGraderInput } from "./invocation.js";

const IMAGE = `example.registry/sweb.eval.x86_64.acme__widget-1@sha256:${"a".repeat(64)}`;

function scratch(): { root: string; inputFile: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), "jinn-oci-grader-"));
  const inputs = join(root, "inputs");
  const output = join(root, "output");
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const inputFile = join(inputs, "config.json");
  writeFileSync(inputFile, "{}", { mode: 0o600 });
  return { root, inputFile, output };
}

function baseInput(overrides: Partial<PinnedOciGraderInput> = {}): PinnedOciGraderInput {
  const { inputFile, output } = scratch();
  return {
    runtime: "docker",
    image: IMAGE,
    platform: "linux/amd64",
    inputs: [{ source: inputFile, targetName: "config.json" }],
    outputDirectory: output,
    command: ["/jinn/input/grader.py"],
    entrypoint: "python3",
    timeoutMs: 60_000,
    profileRequiresNetwork: false,
    ...overrides,
  };
}

describe("buildPinnedOciInvocation", () => {
  it("builds a shell-free, confined, network-none argv with the image last", () => {
    const invocation = buildPinnedOciInvocation(baseInput());

    expect(invocation.command).toBe("docker");
    expect(invocation.args[0]).toBe("run");
    expect(invocation.args).toContain("--rm");
    expect(invocation.args).toContain("--read-only");
    expect(invocation.args).toContain("no-new-privileges");
    expect(invocation.args.slice(invocation.args.indexOf("--network"))[1]).toBe("none");
    expect(invocation.args.slice(invocation.args.indexOf("--cap-drop"))[1]).toBe("ALL");
    expect(invocation.args.at(-1)).toBe("/jinn/input/grader.py");
    expect(invocation.args.at(-2)).toBe(IMAGE);
    expect(invocation.containerName).toMatch(/^jinn-oci-grader-[0-9a-f-]{36}$/u);
    expect(invocation.statementPath.endsWith("/verdict")).toBe(true);
  });

  it("mounts every declared input read-only under /jinn/input and the output writable", () => {
    const invocation = buildPinnedOciInvocation(baseInput());
    const mounts = invocation.args.filter((_, index) => invocation.args[index - 1] === "--mount");

    expect(mounts.some((mount) =>
      mount.endsWith(",dst=/jinn/input/config.json,readonly"))).toBe(true);
    expect(mounts.some((mount) =>
      mount.endsWith(",dst=/jinn/out") && !mount.includes("readonly"))).toBe(true);
  });

  it("refuses an image that is not pinned by sha256 digest", () => {
    expect(() => buildPinnedOciInvocation(baseInput({ image: "swerebench/sweb.eval:latest" })))
      .toThrow(/pinned by sha256 digest/u);
  });

  it("refuses an unsafe or duplicated mount target", () => {
    const { inputFile, output } = scratch();
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [
        { source: inputFile, targetName: "config.json" },
        { source: inputFile, targetName: "config.json" },
      ],
      outputDirectory: output,
    }))).toThrow(/unsafe or duplicated/u);
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [{ source: inputFile, targetName: "../escape" }],
      outputDirectory: output,
    }))).toThrow(/unsafe or duplicated/u);
  });

  it("refuses credential-shaped and symlinked inputs before anything is mounted", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-oci-grader-secret-"));
    const output = join(root, "output");
    mkdirSync(output, { mode: 0o700 });
    const secret = join(root, ".ssh");
    writeFileSync(secret, "key", { mode: 0o600 });
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [{ source: secret, targetName: "config.json" }],
      outputDirectory: output,
    }))).toThrow(/credential or signer material/u);

    const real = join(root, "real.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    const link = join(root, "link.json");
    symlinkSync(real, link);
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [{ source: link, targetName: "config.json" }],
      outputDirectory: output,
    }))).toThrow(/symbolic link|credential or signer material/u);
  });

  it("refuses host networking and an unbounded timeout", () => {
    expect(() => buildPinnedOciInvocation(baseInput({
      profileRequiresNetwork: true, allowedNetwork: "host",
    }))).toThrow(/network is disabled/u);
    expect(() => buildPinnedOciInvocation(baseInput({ timeoutMs: 0 })))
      .toThrow(/positive bounded duration/u);
    expect(() => buildPinnedOciInvocation(baseInput({ timeoutMs: 3_600_001 })))
      .toThrow(/positive bounded duration/u);
  });
});
