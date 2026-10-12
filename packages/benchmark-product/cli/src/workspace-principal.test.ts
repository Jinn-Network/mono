/**
 * Issue #4957: `init --principal me` makes `me` the only member of the workspace, and the local app
 * acted as a fixed `local-operator`, which every operation then refused. These tests hold the rule
 * that picks the principal, and the two effects the fixed one had on a workspace the command line
 * made: a denied authority record on the page, and a denial written to the user's audit journal on
 * every page load.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorityGrant,
  authorityShow,
  getDraft,
  listDrafts,
  readAuditEntries,
  type OperationContext,
} from "@colophon-claims/core";
import { describe, expect, test } from "vitest";
import { runColophonCli } from "./main.js";
import { LOCAL_OPERATOR, readWorkspaceMemberIds, resolveLocalAppPrincipal } from "./workspace-principal.js";

const CLOCK = () => "2026-10-12T12:00:00.000Z";

const cli = {
  now: () => new Date(CLOCK()),
  progress() {},
} as const;

/** A workspace and draft made the way a claimant makes them: with the command line. */
async function workspaceMadeByTheCommandLine(principal: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "colophon-principal-"));
  const initialized = await runColophonCli(["init", "--workspace", "ws", "--principal", principal], { ...cli, cwd });
  expect(initialized.exitCode, initialized.stderr).toBe(0);
  const drafted = await runColophonCli(
    ["draft", "create", "--workspace", "ws", "--principal", principal, "--name", "A draft", "--id", "draft-1"],
    { ...cli, cwd },
  );
  expect(drafted.exitCode, drafted.stderr).toBe(0);
  return join(cwd, "ws");
}

function contextFor(workspaceDir: string, principal: string): OperationContext {
  return { workspaceDir, principal, clock: CLOCK };
}

describe("resolveLocalAppPrincipal", () => {
  test("a workspace with no members yet keeps the principal the app has always used", () => {
    expect(resolveLocalAppPrincipal({ members: undefined })).toBe(LOCAL_OPERATOR);
    expect(LOCAL_OPERATOR).toBe("local-operator");
  });

  test("an explicit principal wins, and founds a workspace that has no members yet", () => {
    expect(resolveLocalAppPrincipal({ explicit: "me", members: undefined })).toBe("me");
    expect(resolveLocalAppPrincipal({ explicit: "me", members: ["me"] })).toBe("me");
    expect(resolveLocalAppPrincipal({ explicit: "agent-1", members: ["local-operator", "agent-1"] })).toBe("agent-1");
  });

  test("an explicit principal that is not a member refuses and lists the members", () => {
    expect(() => resolveLocalAppPrincipal({ explicit: "stranger", members: ["me", "agent-1"] }))
      .toThrow("stranger is not a member of this workspace. Members: me, agent-1. Choose one with --principal.");
  });

  test("an empty --principal is refused rather than passed to the app", () => {
    expect(() => resolveLocalAppPrincipal({ explicit: " ", members: ["me"] })).toThrow("--principal requires a value");
  });

  test("local-operator wins when it is a member, so a workspace the app founded keeps its principal", () => {
    expect(resolveLocalAppPrincipal({ members: ["local-operator"] })).toBe("local-operator");
    expect(resolveLocalAppPrincipal({ members: ["me", "local-operator"] })).toBe("local-operator");
  });

  test("the sole member is the principal when it is not local-operator", () => {
    expect(resolveLocalAppPrincipal({ members: ["me"] })).toBe("me");
  });

  test("several members and none of them local-operator refuses, naming each, rather than guessing", () => {
    expect(() => resolveLocalAppPrincipal({ members: ["me", "agent-1"] }))
      .toThrow("this workspace has several members (me, agent-1) and none is local-operator. Say which one to act as with --principal <id>.");
  });
});

describe("readWorkspaceMemberIds", () => {
  test("lists the members of a workspace the command line made", async () => {
    const workspace = await workspaceMadeByTheCommandLine("me");
    expect(readWorkspaceMemberIds(workspace)).toEqual(["me"]);
    expect(authorityGrant(contextFor(workspace, "me"), { principalId: "agent-1", operations: [] }).ok).toBe(true);
    expect(readWorkspaceMemberIds(workspace)).toEqual(["me", "agent-1"]);
  });

  test("has no members for a directory that is not a workspace yet, whether or not it exists", () => {
    const parent = mkdtempSync(join(tmpdir(), "colophon-principal-empty-"));
    expect(readWorkspaceMemberIds(parent)).toBeUndefined();
    expect(readWorkspaceMemberIds(join(parent, "not-created"))).toBeUndefined();
  });

  test("refuses an authority record it cannot read instead of reporting no members", async () => {
    const workspace = await workspaceMadeByTheCommandLine("me");
    writeFileSync(join(workspace, "authority.json"), "{ not json");
    expect(() => readWorkspaceMemberIds(workspace)).toThrow("authority.json is not valid JSON");
  });
});

describe("a workspace made with `init --principal me`", () => {
  test("the fixed principal was denied on the page's two reads, and each denial was written to the audit journal", async () => {
    const workspace = await workspaceMadeByTheCommandLine("me");
    const before = readAuditEntries(workspace).length;

    const drafts = listDrafts(contextFor(workspace, LOCAL_OPERATOR));
    const authority = authorityShow(contextFor(workspace, LOCAL_OPERATOR));

    expect(drafts).toMatchObject({ ok: false, error: { code: "authority-denied" } });
    expect(authority).toMatchObject({ ok: false, error: { code: "authority-denied", issues: [{ path: "principals.local-operator" }] } });
    expect(readAuditEntries(workspace).slice(before).map((entry) => [entry.actor, entry.outcome])).toEqual([
      [LOCAL_OPERATOR, "authority-denied"],
      [LOCAL_OPERATOR, "authority-denied"],
    ]);
  });

  test("the resolved principal reads the authority record and the draft the command line made, and is never denied", async () => {
    const workspace = await workspaceMadeByTheCommandLine("me");
    const principal = resolveLocalAppPrincipal({ members: readWorkspaceMemberIds(workspace) });
    expect(principal).toBe("me");
    const before = readAuditEntries(workspace).length;

    // The workspace page loads both; its Initialize card shows exactly when the draft list fails.
    const context = contextFor(workspace, principal);
    const drafts = listDrafts(context);
    const authority = authorityShow(context);
    expect(drafts.ok).toBe(true);
    expect(drafts.ok && drafts.result.drafts.map((draft) => draft.draftId)).toEqual(["draft-1"]);
    expect(authority.ok && authority.result.policy.principals.map((member) => member.id)).toEqual(["me"]);
    // The draft's own page, which the workspace page links to as /workspace/<draftId>.
    expect(getDraft(context, { draftId: "draft-1" }).ok).toBe(true);

    expect(readAuditEntries(workspace).slice(before).map((entry) => entry.outcome)).not.toContain("authority-denied");
  });
});
