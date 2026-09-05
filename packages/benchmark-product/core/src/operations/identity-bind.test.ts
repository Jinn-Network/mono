/**
 * `identityBind` (issue #2983) against a real workspace and its real report-signing key. Nothing
 * here contacts a domain, because the operation does not: the proof it returns is the operator's
 * own next step.
 */

import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { verifyDomainBinding } from "@colophon-claims/verify";
import { readAuditEntries } from "../audit/journal.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import type { OperationContext } from "./context.js";
import { identityBind } from "./identity-bind.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "identity-bind-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function contextFor(principal = "sponsor-1"): OperationContext {
  let tick = 0;
  return { workspaceDir, principal, clock: () => `2026-09-02T00:00:${String(tick++).padStart(2, "0")}Z` };
}

describe("identityBind (issue #2983)", () => {
  beforeEach(() => {
    initWorkspace(contextFor());
  });

  test("binds the report key and names the exact record to publish", () => {
    const result = identityBind(contextFor(), { domain: "example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.detail);

    const keyId = loadOrCreateReportSigningKey(workspaceDir).keyId;
    expect(result.result.keyId).toBe(keyId);
    expect(result.result.mechanism).toBe("dns-txt");
    expect(result.result.proof).toEqual({
      mechanism: "dns-txt",
      location: "_colophon.example.com",
      expectedValue: `colophon-domain-binding=1; key=${keyId}`,
    });
  });

  test("the document it writes is one the shipped reader accepts", () => {
    const result = identityBind(contextFor(), { domain: "example.org", mechanism: "well-known-url" });
    if (!result.ok) throw new Error(result.error.detail);
    const bytes = new Uint8Array(readFileSync(result.result.documentPath));
    const verified = verifyDomainBinding(bytes, [result.result.keyId]);
    expect(verified.domain).toBe("example.org");
    expect(verified.proof.location).toBe("https://example.org/.well-known/colophon-domain-binding.txt");
  });

  test("the document sits beside the key it binds, readable only by its owner", () => {
    const result = identityBind(contextFor(), { domain: "example.com" });
    if (!result.ok) throw new Error(result.error.detail);
    expect(result.result.documentPath).toBe(join(workspaceDir, "venue", "domain-binding.json"));
    expect(statSync(result.result.documentPath).mode & 0o777).toBe(0o600);
  });

  test("rebinding to a second domain replaces the document rather than accumulating claims", () => {
    identityBind(contextFor(), { domain: "example.com" });
    const second = identityBind(contextFor(), { domain: "example.org" });
    if (!second.ok) throw new Error(second.error.detail);
    const document = JSON.parse(readFileSync(second.result.documentPath, "utf8")) as { domain: string };
    expect(document.domain).toBe("example.org");
  });

  test("refuses a domain that is not the one accepted spelling, naming what to supply", () => {
    for (const domain of ["https://example.com", "Example.com", "example.com.", "example.com/path"]) {
      const result = identityBind(contextFor(), { domain });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`accepted ${domain}`);
      expect(result.error.code).toBe("validation");
      expect(result.error.detail).toMatch(/no scheme, port, path, or trailing dot/);
    }
  });

  test("refuses a mechanism that is not a self-served proof", () => {
    const result = identityBind(contextFor(), {
      domain: "example.com",
      mechanism: "carrier-pigeon" as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("accepted an unknown mechanism");
    expect(result.error.code).toBe("validation");
    expect(result.error.detail).toMatch(/dns-txt or well-known-url/);
  });

  test("appends exactly one attributed audit entry, as every operation does", () => {
    const before = readAuditEntries(workspaceDir).length;
    identityBind(contextFor(), { domain: "example.com" });
    const entries = readAuditEntries(workspaceDir);
    expect(entries.length).toBe(before + 1);
    const last = entries.at(-1)!;
    expect(last.action).toBe("identity.bind");
    expect(last.actor).toBe("sponsor-1");
    expect(last.outcome).toBe("ok");
  });

  test("ungated does not mean unauthenticated: a non-member cannot name this workspace's key", () => {
    const result = identityBind(contextFor("stranger"), { domain: "example.com" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a non-member bound the key");
    expect(result.error.code).toBe("authority-denied");
    expect(readAuditEntries(workspaceDir).at(-1)!.outcome).toBe("authority-denied");
  });
});
