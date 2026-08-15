/**
 * The async twin of `operate.ts` — the same trusted boundary (spec §5.1),
 * exposed for operations whose `run` itself cannot be synchronous.
 *
 * BP-11's `sample.init` (./sample.ts) is the first such operation: building
 * the bundled sample benchmark reads the platform's golden fixture from disk
 * and seals a DSSE admission receipt over it, both of which are async APIs
 * on the platform side (`@jinn-network/task-admission`). Rather than bend
 * `operate.ts`'s callers to a synchronous `run`, this module reruns the same
 * sequence with `run: () => Promise<T>`.
 *
 * Every guarantee `operate.ts` documents holds identically here: exactly one
 * audit append per call once the workspace and policy are readable (never
 * zero, never two); a denied attempt is itself audited, attributed to the
 * denied principal; an untyped throw from `run` is carried through as the
 * `execution` error code via `toErrorEnvelope`, never swallowed.
 */

import { appendAuditEntry, inputsDigest } from "../audit/journal.js";
import { checkAuthority, readAuthorityPolicy, type AuthorityPolicy } from "../authority/policy.js";
import { toErrorEnvelope } from "../errors.js";
import { assertWorkspace } from "../workspace/workspace.js";
import type { OperationContext } from "./context.js";
import type { OperationResult } from "./result.js";

export interface OperateAsyncOptions<T> {
  readonly context: OperationContext;
  /** Audit action name, e.g. "sample.init". */
  readonly action: string;
  /** Audit subject, e.g. a draftId or "workspace". */
  readonly subject: string;
  /** Digested via `inputsDigest` for the audit entry — not re-validated here. */
  readonly inputs: unknown;
  readonly run: () => Promise<T>;
}

/** Async twin of `operate` (see operate.ts's own header for the full sequence semantics). */
export async function operateAsync<T>(options: OperateAsyncOptions<T>): Promise<OperationResult<T>> {
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
    const result = await run();
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
