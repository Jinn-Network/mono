/**
 * The per-draft preview log (BP-20, spec §7.2: preview = disclosed rehearsal). A preview can
 * never be eliminated — some amount of local trial-and-error before lock is unavoidable — so
 * rather than hide it, the product discloses its own rehearsal mechanism: every preview a draft
 * has run is appended here, and `previewDisclosureLine` renders that history into the one sentence
 * a later consumer (report, BP-20's own operation) surfaces wherever the draft or its results
 * appear. This is honesty about a residual, not an attempt to eliminate it.
 *
 * This module owns three things: the shapes (`PreviewLogEntry`/`PreviewLog`, and the artifact
 * shape's shared `PreviewArmSummary`), the read/append I/O against `../workspace/layout.ts`'s
 * `previewLogPath`, and the disclosure-line builder. It does not run a preview itself — that is
 * `../operations/preview.ts`'s job, which appends through this module and never writes the log
 * file directly.
 */

import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import { previewLogPath } from "../workspace/layout.js";

/** The rehearsal marker every preview artifact carries — see this module's own header. */
export const PREVIEW_MARKER = "rehearsal — not official evidence";

const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC3339 timestamp",
);

const PreviewOutcomeCountsSchema = z.object({
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});

export type PreviewOutcomeCounts = z.infer<typeof PreviewOutcomeCountsSchema>;

const PreviewArmSummarySchema = z.object({
  armId: z.string(),
  cells: z.number().int().nonnegative(),
  outcomes: PreviewOutcomeCountsSchema,
});

export type PreviewArmSummary = z.infer<typeof PreviewArmSummarySchema>;

const PreviewLogEntrySchema = z.object({
  /** `"preview-001"`, `"preview-002"`, … — 1-based, zero-padded, scoped to the draft. */
  previewId: z.string().min(1),
  /** RFC3339, the operation's frozen instant (the injected, non-live clock). */
  at: Rfc3339Schema,
  /** RFC3339, the LIVE injected clock at rehearsal start. */
  startedAt: Rfc3339Schema,
  /** RFC3339, the LIVE injected clock at rehearsal end. */
  finishedAt: Rfc3339Schema,
  elapsedMs: z.number().int().nonnegative(),
  draftState: z.enum(["draft", "quoted"]),
  itemCount: z.number().int().nonnegative(),
  cellCount: z.number().int().nonnegative(),
  arms: z.array(PreviewArmSummarySchema),
});

export type PreviewLogEntry = z.infer<typeof PreviewLogEntrySchema>;

const PreviewLogSchema = z.object({
  draftId: z.string().min(1),
  count: z.number().int().nonnegative(),
  previews: z.array(PreviewLogEntrySchema),
}).refine(
  (log) => log.count === log.previews.length,
  { message: "count must equal previews.length — a desynchronized log would misreport how many rehearsals ran" },
);

export type PreviewLog = z.infer<typeof PreviewLogSchema>;

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/** Reads and validates the preview log for `draftId`, or `undefined` when the draft has never
 * been previewed. Refuses `"validation"` when the file exists but is not valid JSON, or fails
 * the schema. */
export function readPreviewLog(workspaceDir: string, draftId: string): PreviewLog | undefined {
  const path = previewLogPath(workspaceDir, draftId);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", path, "preview log file is not valid JSON");
  }
  const result = PreviewLogSchema.safeParse(json);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  return result.data;
}

/** Read-modify-write append: validates `entry`, appends it to the draft's preview log (creating
 * the log at count 1 if this is the first preview), and atomically writes the whole document
 * back. Returns the updated log. */
export function appendPreviewLogEntry(workspaceDir: string, draftId: string, entry: PreviewLogEntry): PreviewLog {
  const parsedEntry = PreviewLogEntrySchema.safeParse(entry);
  if (!parsedEntry.success) {
    refuseWithIssues("validation", issuesFromZodError(parsedEntry.error));
  }

  const existing = readPreviewLog(workspaceDir, draftId);
  const previews = existing === undefined ? [parsedEntry.data] : [...existing.previews, parsedEntry.data];
  const updated: PreviewLog = { draftId, count: previews.length, previews };

  const result = PreviewLogSchema.safeParse(updated);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  atomicWriteFileSync(previewLogPath(workspaceDir, draftId), JSON.stringify(result.data, null, 2));
  return result.data;
}

/**
 * Renders a draft's preview history into the one disclosure sentence a later consumer (BP-20's
 * own `preview` operation, and eventually the report) surfaces wherever the draft or its results
 * appear (module header: honesty about a residual, not an attempt to eliminate it).
 */
export function previewDisclosureLine(log: PreviewLog): string {
  return previewDisclosureSummaryLine({
    previewCount: log.count,
    timestamps: log.previews.map((preview) => preview.at),
  });
}

/** Pure portable form of the same disclosure, usable after the source preview log is gone. */
export function previewDisclosureSummaryLine(summary: {
  readonly previewCount: number;
  readonly timestamps: readonly string[];
}): string {
  const timestamps = summary.timestamps.join(", ");
  return `${summary.previewCount} disposable preview rehearsal(s) of this benchmark ran before lock (at ${timestamps}); `
    + "preview results are rehearsal only and never entered official results.";
}
