import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import { checkAuthority, readAuthorityPolicy } from "../authority/policy.js";
import { authorityGrant, authorityRevoke, authorityShow } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp11-authority-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(dir: string, clock: () => string, principal: string): OperationContext {
  return { workspaceDir: dir, principal, clock };
}

describe("authority grant / revoke — the packet's acceptance flow, end to end", () => {
  test("a sponsor onboards a delegated agent with a narrow grant; the agent gains membership and only that grant", () => {
    const clock = makeClock();

    // 1: init workspace as sponsor-1.
    initWorkspace(contextFor(workspaceDir, clock, "sponsor-1"));

    // 2: agent-1 attempts createDraft before being granted membership.
    const tooEarly = createDraft(contextFor(workspaceDir, clock, "agent-1"), { name: "Too Early" });
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.error.code).toBe("authority-denied");

    // 3: sponsor-1 grants agent-1 (delegated-agent) the "report" operation.
    const granted = authorityGrant(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "agent-1",
      role: "delegated-agent",
      operations: ["report"],
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    const onDisk = readAuthorityPolicy(workspaceDir);
    expect(onDisk.principals.find((principal) => principal.id === "agent-1")).toEqual({
      id: "agent-1",
      role: "delegated-agent",
      grants: ["report"],
    });

    // 4: a granted principal can now perform ordinary member operations.
    const created = createDraft(contextFor(workspaceDir, clock, "agent-1"), { name: "Now Allowed" });
    expect(created.ok).toBe(true);

    // 5: the granted operation is allowed; an ungranted gated operation is refused.
    expect(() => checkAuthority(granted.result.policy, "agent-1", "report")).not.toThrow();
    expect(() => checkAuthority(granted.result.policy, "agent-1", "publish")).toThrow();

    // 6: agent-1 attempts self-escalation via authorityGrant.
    const selfEscalation = authorityGrant(contextFor(workspaceDir, clock, "agent-1"), {
      principalId: "agent-1",
      operations: ["publish"],
    });
    expect(selfEscalation.ok).toBe(false);
    if (!selfEscalation.ok) expect(selfEscalation.error.code).toBe("authority-denied");

    // 7: sponsor-1 revokes agent-1's "report" grant.
    const revoked = authorityRevoke(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "agent-1",
      operations: ["report"],
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(() => checkAuthority(revoked.result.policy, "agent-1", "report")).toThrow();

    // 8: an unknown operation name in a grant refuses validation; revoke of an absent principal refuses not-found.
    const badGrant = authorityGrant(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "agent-2",
      operations: ["not-a-real-operation"],
    });
    expect(badGrant.ok).toBe(false);
    if (!badGrant.ok) expect(badGrant.error.code).toBe("validation");

    const missingRevoke = authorityRevoke(contextFor(workspaceDir, clock, "sponsor-1"), { principalId: "ghost" });
    expect(missingRevoke.ok).toBe(false);
    if (!missingRevoke.ok) expect(missingRevoke.error.code).toBe("not-found");

    // 9: every step above appended exactly one attributed audit entry.
    const entries = readAuditEntries(workspaceDir);
    expect(entries.map((entry) => entry.action)).toEqual([
      "init",
      "draft.create",
      "authority.grant",
      "draft.create",
      "authority.grant",
      "authority.revoke",
      "authority.grant",
      "authority.revoke",
    ]);
    expect(entries.map((entry) => entry.outcome)).toEqual([
      "ok",
      "authority-denied",
      "ok",
      "ok",
      "authority-denied",
      "ok",
      "validation",
      "not-found",
    ]);
    expect(entries.map((entry) => entry.actor)).toEqual([
      "sponsor-1",
      "agent-1",
      "sponsor-1",
      "agent-1",
      "agent-1",
      "sponsor-1",
      "sponsor-1",
      "sponsor-1",
    ]);
  });
});

describe("authorityGrant — empty grants", () => {
  test("an empty operations list grants workspace membership only", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock, "sponsor-1"));

    const outcome = authorityGrant(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "observer-1",
      operations: [],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.policy.principals.find((principal) => principal.id === "observer-1")).toEqual({
      id: "observer-1",
      role: "delegated-agent",
      grants: [],
    });

    const created = createDraft(contextFor(workspaceDir, clock, "observer-1"), { name: "Member Now" });
    expect(created.ok).toBe(true);
  });
});

describe("authorityGrant — regranting an existing principal with a conflicting role", () => {
  test("refuses validation rather than silently changing role", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock, "sponsor-1"));
    authorityGrant(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "agent-1",
      role: "delegated-agent",
      operations: ["report"],
    });

    const outcome = authorityGrant(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "agent-1",
      role: "sponsor",
      operations: ["publish"],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
  });
});

describe("authorityRevoke — omitted operations clears every grant", () => {
  test("clears all grants without removing membership", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock, "sponsor-1"));
    authorityGrant(contextFor(workspaceDir, clock, "sponsor-1"), {
      principalId: "agent-1",
      role: "delegated-agent",
      operations: ["report", "publish"],
    });

    const outcome = authorityRevoke(contextFor(workspaceDir, clock, "sponsor-1"), { principalId: "agent-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const principal = outcome.result.policy.principals.find((candidate) => candidate.id === "agent-1");
    expect(principal?.grants).toEqual([]);

    // Membership itself is not removed — the principal still exists in the policy.
    expect(principal).toBeDefined();
  });
});

describe("authorityShow", () => {
  test("any member can read the policy, audited under its own action", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock, "sponsor-1"));

    const outcome = authorityShow(contextFor(workspaceDir, clock, "sponsor-1"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.policy.principals).toHaveLength(1);

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "authority.show", outcome: "ok" });
  });
});
