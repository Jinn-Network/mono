import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BENCHMARKING_METHOD_REGISTRY } from "@jinn-network/benchmarking-aggregate";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION } from "@jinn-network/benchmarking-records";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { buildMethodPorts } from "./ports.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-ports-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("buildMethodPorts", () => {
  it("exposes the shared benchmarking-aggregate method registry (wilson@1 resolvable)", () => {
    const ports = buildMethodPorts(workspaceDir);
    expect(ports.registry).toBe(BENCHMARKING_METHOD_REGISTRY);
    const wilson = ports.registry.get(BENCHMARKING_METHOD_IDS.wilson, BENCHMARKING_METHOD_VERSION);
    expect(wilson).toBeDefined();
  });

  it("resolveVerdictBytes strips the sha256: prefix and returns the exact sealed bytes", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ fixture: "verdict" }));
    const hex = putSealedBytes(workspaceDir, bytes);
    const ports = buildMethodPorts(workspaceDir);
    expect(ports.resolveVerdictBytes(`sha256:${hex}`)).toEqual(bytes);
  });

  it("resolveVerdictBytes returns undefined (never throws) when the digest is absent", () => {
    const ports = buildMethodPorts(workspaceDir);
    expect(() => ports.resolveVerdictBytes(`sha256:${"0".repeat(64)}`)).not.toThrow();
    expect(ports.resolveVerdictBytes(`sha256:${"0".repeat(64)}`)).toBeUndefined();
  });

  it("resolveRunBytes strips the sha256: prefix and returns the exact sealed bytes, undefined when absent", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ fixture: "run" }));
    const hex = putSealedBytes(workspaceDir, bytes);
    const ports = buildMethodPorts(workspaceDir);
    expect(ports.resolveRunBytes(`sha256:${hex}`)).toEqual(bytes);
    expect(ports.resolveRunBytes(`sha256:${"1".repeat(64)}`)).toBeUndefined();
  });

  it("resolveTaskBytes strips the sha256: prefix and returns the exact sealed bytes, undefined when absent", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ fixture: "task" }));
    const hex = putSealedBytes(workspaceDir, bytes);
    const ports = buildMethodPorts(workspaceDir);
    expect(ports.resolveTaskBytes(`sha256:${hex}`)).toEqual(bytes);
    expect(ports.resolveTaskBytes(`sha256:${"2".repeat(64)}`)).toBeUndefined();
  });
});
