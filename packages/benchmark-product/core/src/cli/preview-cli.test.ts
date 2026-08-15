/**
 * `preview` CLI verb (BP-20, spec §7.2): flag-validation and dispatch-wiring coverage only — a
 * preview through the CLI would drive the REAL local venue (module header of
 * `../operations/preview.ts`), so this file stays on the refusal paths that never reach the venue.
 * The venue-touching behavior (previewed-cell counts, artifact honesty, non-advancement, etc.) is
 * covered at the operation level by `../operations/preview.test.ts`,
 * `../operations/preview-disclosure.test.ts`, and `../operations/preview-purity.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli, USAGE } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;
let tick: number;

function clock(): string {
  return `2026-08-06T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(dir: string): CliContext {
  return { cwd: dir, clock };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp20-preview-cli-"));
  tick = 0;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

interface JsonEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code: string; readonly detail: string; readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }> };
}

function parseJson<T>(stdout: string): JsonEnvelope<T> {
  return JSON.parse(stdout) as JsonEnvelope<T>;
}

describe("usage", () => {
  test("USAGE lists the preview verb between authority show and quote", () => {
    expect(USAGE).toContain("preview          --workspace <dir> --principal <id> --draft <draftId> [--items <n>]");
    const authorityShowIndex = USAGE.indexOf("authority show");
    const previewIndex = USAGE.indexOf("preview          --workspace");
    const quoteIndex = USAGE.indexOf("quote            --workspace");
    expect(authorityShowIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeGreaterThan(authorityShowIndex);
    expect(quoteIndex).toBeGreaterThan(previewIndex);
  });
});

describe("preview --items validation", () => {
  test("--items 0 refuses invalid-invocation naming --items, exit 2", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);

    const result = await runCli(
      ["preview", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "nope", "--items", "0", "--json"],
      context,
    );
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.issues?.some((issue) => issue.path === "--items")).toBe(true);
  });

  test("--items abc refuses invalid-invocation naming --items, exit 2", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);

    const result = await runCli(
      ["preview", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "nope", "--items", "abc", "--json"],
      context,
    );
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.issues?.some((issue) => issue.path === "--items")).toBe(true);
  });
});

describe("preview unknown flag", () => {
  test("an unknown flag refuses invalid-invocation, exit 2", async () => {
    const context = contextFor(workspaceDir);
    const result = await runCli(
      [
        "preview",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "x",
        "--frobnicate", "y", "--json",
      ],
      context,
    );
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });
});

describe("preview on a nonexistent draft", () => {
  test("refuses not-found, exit 1, without ever touching a venue", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);

    const result = await runCli(
      ["preview", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "does-not-exist", "--json"],
      context,
    );
    expect(result.exitCode).toBe(1);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("not-found");
  });
});
