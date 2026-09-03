/**
 * `identity bind` (issue #2983) through `runCli`, exactly as `bin.ts` calls it.
 *
 * The load-bearing assertion is the human surface's: the verb exists so an operator learns what to
 * publish, so the record to publish must be in the output rather than only in the written document.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { verifyDomainBinding } from "@colophon-claims/verify";
import { runCli, USAGE } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;
let tick: number;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "identity-cli-"));
  tick = 0;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function contextFor(): CliContext {
  return { cwd: workspaceDir, clock: () => `2026-09-02T00:00:${String(tick++).padStart(2, "0")}Z` };
}

function base(): readonly string[] {
  return ["--workspace", workspaceDir, "--principal", "sponsor-1"];
}

async function initialized(context: CliContext): Promise<void> {
  const result = await runCli(["init", ...base(), "--json"], context);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
}

describe("identity bind (issue #2983)", () => {
  test("usage documents the verb and its optional mechanism", () => {
    expect(USAGE).toMatch(/identity bind {4}--workspace <dir> --principal <id> --domain <domain>/);
    expect(USAGE).toMatch(/\[--mechanism dns-txt\|well-known-url\]/);
  });

  test("the human surface names the exact record to publish, and where", async () => {
    const context = contextFor();
    await initialized(context);
    const result = await runCli(["identity", "bind", ...base(), "--domain", "example.com"], context);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/to example\.com by DNS TXT record/);
    expect(result.stdout).toMatch(/Publish this at _colophon\.example\.com:/);
    expect(result.stdout).toMatch(/colophon-domain-binding=1; key=did:key:z/);
    // Declaring is not proving, and the verb says so where the operator will read it.
    expect(result.stdout).toMatch(/Until it is published/);
  });

  test("the JSON envelope carries the proof, and the document verifies", async () => {
    const context = contextFor();
    await initialized(context);
    const result = await runCli(
      ["identity", "bind", ...base(), "--domain", "example.org", "--mechanism", "well-known-url", "--json"],
      context,
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      result: { keyId: string; documentPath: string; proof: { location: string } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.proof.location).toBe("https://example.org/.well-known/colophon-domain-binding.txt");
    const bytes = new Uint8Array(readFileSync(envelope.result.documentPath));
    expect(verifyDomainBinding(bytes, [envelope.result.keyId]).domain).toBe("example.org");
  });

  test("--domain is required, and an unknown flag is refused", async () => {
    const context = contextFor();
    await initialized(context);
    const missing = await runCli(["identity", "bind", ...base(), "--json"], context);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).error.code).toBe("invalid-invocation");

    const unknown = await runCli(
      ["identity", "bind", ...base(), "--domain", "example.com", "--proof", "dns", "--json"],
      context,
    );
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stdout).error.code).toBe("invalid-invocation");
  });
});
