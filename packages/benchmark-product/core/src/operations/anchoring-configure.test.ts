/**
 * `anchoringConfigure` (anchor-evidence design §7.3) against a real workspace and its real
 * `workspace.json`. No transport is involved: configuration never contacts a provider.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import { readAuditEntries } from "../audit/journal.js";
import { readAuthorityPolicy, writeAuthorityPolicy } from "../authority/policy.js";
import { assertWorkspace } from "../workspace/workspace.js";
import { workspaceMetadataPath } from "../workspace/layout.js";
import { anchoringConfigure } from "./anchoring-configure.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "anchoring-configure-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock: makeClock() };
}

function metadata(): Record<string, unknown> {
  return JSON.parse(readFileSync(workspaceMetadataPath(workspaceDir), "utf8")) as Record<string, unknown>;
}

describe("anchoringConfigure (§7.3)", () => {
  beforeEach(() => {
    initWorkspace(contextFor());
  });

  test("stores the ordered list and canonicalizes each endpoint", () => {
    const result = anchoringConfigure(contextFor(), {
      entries: [
        { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr/" },
        { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: " https://a.invalid , https://b.invalid/ " },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("configure refused");
    expect(result.result.anchoring).toEqual([
      { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr" },
      { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: "https://a.invalid,https://b.invalid" },
    ]);
    expect(assertWorkspace(workspaceDir).anchoring).toEqual(result.result.anchoring);
  });

  test("an empty list removes the block rather than storing a second spelling of absent", () => {
    anchoringConfigure(contextFor(), {
      entries: [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr" }],
    });
    expect(metadata()).toHaveProperty("anchoring");

    const cleared = anchoringConfigure(contextFor(), { entries: [] });
    expect(cleared.ok).toBe(true);
    expect(metadata()).not.toHaveProperty("anchoring");
    expect(assertWorkspace(workspaceDir).anchoring).toBeUndefined();
    // Everything else the file carries survives an anchoring edit.
    expect(metadata()).toMatchObject({ storageVersion: 1 });
  });

  test("replaces the whole list rather than appending to it", () => {
    anchoringConfigure(contextFor(), {
      entries: [
        { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://one.invalid" },
        { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: "https://two.invalid" },
      ],
    });
    const replaced = anchoringConfigure(contextFor(), {
      entries: [{ providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: "https://three.invalid" }],
    });

    expect(replaced.ok).toBe(true);
    expect(assertWorkspace(workspaceDir).anchoring).toEqual([
      { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: "https://three.invalid" },
    ]);
  });

  test("refuses a profile no acquisition source implements, and stores nothing", () => {
    const refused = anchoringConfigure(contextFor(), {
      entries: [{
        providerProfile: "https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1",
        endpoint: "https://timestamp.invalid/tsr",
      }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("configure accepted a lookup-only profile");
    expect(refused.error.code).toBe("validation");
    expect(refused.error.detail).toContain("no acquisition source implements");
    expect(metadata()).not.toHaveProperty("anchoring");
  });

  test("refuses an endpoint that is not absolute https", () => {
    for (const endpoint of ["http://timestamp.invalid/tsr", "timestamp.invalid/tsr", "", "  "]) {
      const refused = anchoringConfigure(contextFor(), {
        entries: [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint }],
      });
      expect(refused.ok, endpoint).toBe(false);
      if (refused.ok) throw new Error(`configure accepted ${endpoint}`);
      expect(refused.error.code).toBe("validation");
    }
    expect(metadata()).not.toHaveProperty("anchoring");
  });

  test("refuses a malformed entry as validation naming the index and field, never as execution", () => {
    for (const [entries, path] of [
      [[null], "anchoring.0"],
      [[{ endpoint: "https://timestamp.invalid/tsr" }], "anchoring.0.providerProfile"],
      [[{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: 42 }], "anchoring.0.endpoint"],
      [[{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://a.invalid" }, "nope"], "anchoring.1"],
    ] as const) {
      const refused = anchoringConfigure(contextFor(), { entries: entries as never });
      expect(refused.ok, path).toBe(false);
      if (refused.ok) throw new Error(`configure accepted ${JSON.stringify(entries)}`);
      expect(refused.error.code, path).toBe("validation");
      expect(refused.error.issues?.map((issue) => issue.path), path).toContain(path);
    }
    expect(metadata()).not.toHaveProperty("anchoring");
  });

  test("refuses a second entry for one profile, which resolution would never reach", () => {
    const refused = anchoringConfigure(contextFor(), {
      entries: [
        { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://one.invalid" },
        { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://two.invalid" },
      ],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("configure accepted a shadowed entry");
    expect(refused.error.code).toBe("validation");
    expect(refused.error.detail).toContain("configured more than once");
  });

  test("a workspace initialized before this grant existed recovers with one sponsor self-grant", () => {
    // Exactly what an already-initialized workspace's authority.json looks like: a founding
    // sponsor holding every grant that existed when it was written, and not this one.
    const policy = readAuthorityPolicy(workspaceDir);
    writeAuthorityPolicy(workspaceDir, {
      ...policy,
      principals: policy.principals.map((principal) => ({
        ...principal,
        grants: principal.grants.filter((grant) => grant !== "anchoring.configure"),
      })),
    });

    const entries = [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr" }];
    const denied = anchoringConfigure(contextFor(), { entries });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("a policy without the grant configured anchoring");
    expect(denied.error.code).toBe("authority-denied");

    // `authority.grant` is role-gated rather than grant-gated, so the sponsor is never locked out.
    expect(authorityGrant(contextFor(), { principalId: "sponsor-1", operations: ["anchoring.configure"] }).ok).toBe(true);
    expect(anchoringConfigure(contextFor(), { entries }).ok).toBe(true);
  });

  test("is authority-gated: a member without the grant is denied, and the denial is audited", () => {
    authorityGrant(contextFor(), { principalId: "agent-1", role: "delegated-agent", operations: [] });

    const denied = anchoringConfigure(contextFor("agent-1"), {
      entries: [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr" }],
    });

    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("an ungranted principal configured anchoring");
    expect(denied.error.code).toBe("authority-denied");
    expect(metadata()).not.toHaveProperty("anchoring");

    const granted = anchoringConfigure(contextFor(), {
      entries: [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://timestamp.invalid/tsr" }],
    });
    expect(granted.ok).toBe(true);

    const audited = readAuditEntries(workspaceDir).filter((entry) => entry.action === "anchoring.configure");
    expect(audited.map((entry) => [entry.actor, entry.outcome])).toEqual([
      ["agent-1", "authority-denied"],
      ["sponsor-1", "ok"],
    ]);
    expect(audited.every((entry) => entry.subject === "workspace")).toBe(true);
  });
});
