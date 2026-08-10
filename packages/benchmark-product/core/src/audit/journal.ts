/**
 * The workspace's append-only audit journal (spec §4.4, assumption A7).
 *
 * One JSONL file per workspace. Every consequential operation (anything that
 * creates, mutates, seals, spends, cancels, or publishes) appends one
 * attributed entry. Entries are never rewritten or deleted; file order is
 * the authoritative order — there is no separate sequence number to drift
 * out of sync with it.
 *
 * The journal is **product state, not a sealed record** (§4.5): it makes
 * agent operation supervisable and concierge work attributable. It claims
 * no protocol semantics — `inputsDigest` exists for attribution (did this
 * actor run this operation with these inputs), not for the platform's
 * exactness/sealing guarantees, which live in the records package.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { appendFsyncedLineSync, readTextIfExistsSync } from "../fs/atomic.js";
import { journalPath } from "../workspace/layout.js";

export const AuditEntrySchema = z.object({
  /** RFC 3339 timestamp of the operation. */
  at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      "must be an RFC 3339 timestamp",
    ),
  /** The principal identity (sponsor or specific delegated agent) that acted. */
  actor: z.string().min(1),
  /** The operation name, e.g. "draft.create". */
  action: z.string().min(1),
  /** What was acted on, e.g. a draftId or "workspace". */
  subject: z.string().min(1),
  /** Lowercase sha256 hex digest of the operation inputs; see `inputsDigest`. */
  inputsDigest: z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest"),
  /** "ok" or the typed error code the operation refused with. */
  outcome: z.string().min(1),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/** Recursively sorts object keys and maps `undefined` to `null`, leaving array order untouched. */
function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Lowercase sha256 hex of a stable serialization of the operation inputs: JSON with
 * object keys sorted recursively at every level (arrays keep order); `undefined` is
 * treated as `null`. Deterministic across processes; used for attribution, not sealing.
 */
export function inputsDigest(inputs: unknown): string {
  const serialized = JSON.stringify(canonicalize(inputs));
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Validates the entry (refuse "validation" with dotted issue paths) then appends exactly
 * one fsynced JSONL line to `journalPath(workspaceDir)`.
 */
export function appendAuditEntry(workspaceDir: string, entry: AuditEntry): void {
  const result = AuditEntrySchema.safeParse(entry);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  appendFsyncedLineSync(journalPath(workspaceDir), JSON.stringify(result.data));
}

/**
 * Returns every entry in journal file order. An empty or absent journal returns `[]`.
 * A line that is not JSON, or that fails the schema, refuses "journal-integrity" with
 * the zero-based line index in the issue path (e.g. "journal.3").
 */
export function readAuditEntries(workspaceDir: string): AuditEntry[] {
  const text = readTextIfExistsSync(journalPath(workspaceDir));
  if (text === "") return [];

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.map((line, index): AuditEntry => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      refuse("journal-integrity", `journal.${index}`, `line ${index} is not valid JSON`);
    }
    const result = AuditEntrySchema.safeParse(parsed);
    if (!result.success) {
      refuse("journal-integrity", `journal.${index}`, `line ${index} fails the audit entry schema`);
    }
    return result.data;
  });
}
