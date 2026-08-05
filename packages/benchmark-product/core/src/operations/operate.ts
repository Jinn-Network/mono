/**
 * The one boundary helper every operation runs through (spec §5.1) — it is
 * what makes "every operation appends exactly one attributed audit entry"
 * (spec §4.4) a mechanical property of the library rather than a discipline
 * each operation module has to remember on its own.
 *
 * Not exported from the package root: it is an implementation seam for the
 * sibling operation modules in this directory, never a surface a CLI or GUI
 * client calls directly.
 */

import { appendAuditEntry, inputsDigest } from "../audit/journal.js";
import { checkAuthority, readAuthorityPolicy, type AuthorityPolicy } from "../authority/policy.js";
import { toErrorEnvelope } from "../errors.js";
import { assertWorkspace } from "../workspace/workspace.js";
import type { OperationContext } from "./context.js";
import type { OperationResult } from "./result.js";

export interface OperateOptions<T> {
  readonly context: OperationContext;
  /** Audit action name, e.g. "draft.create". */
  readonly action: string;
  /** Audit subject, e.g. a draftId or "workspace". */
  readonly subject: string;
  /** Digested via `inputsDigest` for the audit entry — not re-validated here. */
  readonly inputs: unknown;
  readonly run: () => T;
}

/**
 * Runs one operation through the trusted boundary. Semantics, in order:
 *
 * 1. `assertWorkspace` — a failure here (the directory is not a workspace)
 *    returns the typed error envelope WITHOUT an audit append: there is no
 *    journal to write to yet. The same holds when the authority policy
 *    itself cannot be read.
 * 2. `checkAuthority` — an authority-denied refusal IS audited: one entry,
 *    attributed to the denied principal, outcome `"authority-denied"`. A
 *    denied attempt is exactly what a sponsor wants to see in the journal.
 * 3. `run()` — on success, one entry with outcome `"ok"`. On a typed
 *    `BenchmarkProductError`, one entry whose outcome is the error's code.
 *    On an untyped throw, one entry with outcome `"execution"`
 *    (`toErrorEnvelope`'s carrier for anything not already typed).
 *
 * `context.clock()` is called exactly once per call to `operate`, and that
 * single timestamp becomes the audit entry's `at`. An operation that also
 * needs the same instant for document timestamps (createdAt/updatedAt — see
 * drafts.ts) arranges that itself by wrapping `context.clock` in a constant
 * closure before calling `operate`, so the one underlying clock call this
 * function makes is the only one for the whole operation.
 *
 * Every path through `operate` appends exactly one entry once the workspace
 * and policy are readable — never zero, never two.
 */
export function operate<T>(options: OperateOptions<T>): OperationResult<T> {
  const { context, action, subject, inputs, run } = options;

  try {
    assertWorkspace(context.workspaceDir);
  } catch (cause) {
    return { ok: false, error: toErrorEnvelope(cause) };
  }

  let policy: AuthorityPolicy;
  try {
    policy = readAuthorityPolicy(context.workspaceDir);
  } catch (cause) {
    return { ok: false, error: toErrorEnvelope(cause) };
  }

  const at = context.clock();
  const digest = inputsDigest(inputs);

  try {
    checkAuthority(policy, context.principal, action);
  } catch (cause) {
    const error = toErrorEnvelope(cause);
    appendAuditEntry(context.workspaceDir, {
      at,
      actor: context.principal,
      action,
      subject,
      inputsDigest: digest,
      outcome: error.code,
    });
    return { ok: false, error };
  }

  try {
    const result = run();
    appendAuditEntry(context.workspaceDir, {
      at,
      actor: context.principal,
      action,
      subject,
      inputsDigest: digest,
      outcome: "ok",
    });
    return { ok: true, result };
  } catch (cause) {
    const error = toErrorEnvelope(cause);
    appendAuditEntry(context.workspaceDir, {
      at,
      actor: context.principal,
      action,
      subject,
      inputsDigest: digest,
      outcome: error.code,
    });
    return { ok: false, error };
  }
}
