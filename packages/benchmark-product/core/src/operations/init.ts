/**
 * Workspace creation (spec §4.6 Workspace row): distinct from the lifecycle
 * `create` that starts a draft (§4.1). The initializing principal becomes the
 * founding sponsor holding every gated grant (A3, `foundingAuthorityPolicy`).
 *
 * `initWorkspace` cannot go through the `operate` boundary the way every
 * other operation does: `operate`'s first step is `assertWorkspace`, which
 * exists precisely to guarantee a journal to write into before anything is
 * audited — and before this operation runs, there is no workspace and so no
 * journal. It therefore implements its own, shorter sequence below.
 */

import { appendAuditEntry, inputsDigest } from "../audit/journal.js";
import { foundingAuthorityPolicy, writeAuthorityPolicy } from "../authority/policy.js";
import { toErrorEnvelope } from "../errors.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { createWorkspaceLayout, isWorkspace, type WorkspaceMetadata } from "../workspace/workspace.js";
import type { OperationContext } from "./context.js";
import type { OperationResult } from "./result.js";

export function initWorkspace(context: OperationContext): OperationResult<{ workspace: WorkspaceMetadata }> {
  const { workspaceDir, principal } = context;

  // A directory that is already a workspace refuses "conflict" with no audit
  // append: this operation owns no workspace of its own to append into
  // either — the same "no journal, no entry" boundary `operate` enforces.
  if (isWorkspace(workspaceDir)) {
    return {
      ok: false,
      error: { code: "conflict", detail: `${workspaceDir} is already a workspace` },
    };
  }

  const at = context.clock();
  const digest = inputsDigest({ workspaceDir });

  let workspace: WorkspaceMetadata;
  try {
    workspace = createWorkspaceLayout(workspaceDir, at);
  } catch (cause) {
    // The layout was never created — there is nowhere durable to append into,
    // so this failure is not audited either.
    return { ok: false, error: toErrorEnvelope(cause) };
  }

  try {
    // The workspace identity must predate every Task/Benchmark it authors. Creating the key at
    // init removes the quote-time identity cycle while keeping one stable report/source key.
    loadOrCreateReportSigningKey(workspaceDir);
    writeAuthorityPolicy(workspaceDir, foundingAuthorityPolicy(principal));
  } catch (cause) {
    // The layout exists now, so the journal does too: this failure IS audited.
    const error = toErrorEnvelope(cause);
    appendAuditEntry(workspaceDir, {
      at,
      actor: principal,
      action: "init",
      subject: "workspace",
      inputsDigest: digest,
      outcome: error.code,
    });
    return { ok: false, error };
  }

  appendAuditEntry(workspaceDir, {
    at,
    actor: principal,
    action: "init",
    subject: "workspace",
    inputsDigest: digest,
    outcome: "ok",
  });
  return { ok: true, result: { workspace } };
}
