import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { storeAgentProfile, type ProductErrorCode, type RunStatusResult } from "@colophon-claims/core";
import { loadAgentProfilesForGui, projectRunStatusForGui } from "./view-models";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function failedStatus(code: ProductErrorCode, detail: string): RunStatusResult {
  return {
    state: "running",
    cancelRequested: false,
    driver: {
      operation: "launch",
      generation: "generation-1",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:00:01.000Z",
      status: "failed",
      error: { code, detail },
    },
    cells: [],
    counts: { expected: 0, dispatched: 0, delivered: 0, judged: 0, failed: 0, awaitingEvaluation: 0 },
  };
}

describe("run monitor GUI trust boundary", () => {
  test.each(["execution", "venue-unavailable"] as const)(
    "redacts a durable %s detail while retaining its typed code",
    (code) => {
      const sentinel = "/private/workspace/report-signing-key-VERY_SECRET.pem";
      const projected = projectRunStatusForGui(failedStatus(code, sentinel));
      expect(projected.driver?.error?.code).toBe(code);
      expect(projected.driver?.error?.detail).toContain("server logs");
      expect(JSON.stringify(projected)).not.toContain(sentinel);
      expect(JSON.stringify(projected)).not.toContain("VERY_SECRET");
    },
  );
});

describe("agent readiness projection", () => {
  test("distinguishes an executable problem from a missing credential", () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-gui-agent-"));
    roots.push(root);
    const executable = join(root, "codex");
    writeFileSync(executable, "#!/bin/sh\necho 'codex-cli 1.2.3'\n");
    chmodSync(executable, 0o700);
    storeAgentProfile(join(root, "data"), {
      format: "colophon-agent/1",
      agentId: "codex-main",
      adapter: "codex",
      executable: {
        path: executable,
        sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
        version: "1.2.3",
      },
      model: "gpt-test",
      effort: "high",
      network: "provider-required",
    });
    expect(loadAgentProfilesForGui(join(root, "data")).profiles[0]?.readiness).toBe("needs-credential");

    writeFileSync(executable, "#!/bin/sh\necho changed\n");
    expect(loadAgentProfilesForGui(join(root, "data")).profiles[0]?.readiness).toBe("needs-attention");
  });
});
