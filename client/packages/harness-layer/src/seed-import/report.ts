/**
 * The ImportReport — the approval-gate artifact (plan Task 6).
 *
 * `seed plan` renders and writes this; Oak reads and approves (editing
 * verdicts if needed) BEFORE `seed execute` runs. Nothing lands on chain
 * that was not on this list.
 */

import { z } from 'zod';

export const ImportReportRowSchema = z.strictObject({
  skill: z.string().min(1),
  source: z.string().min(1),
  licence: z.string().min(1).nullable(),
  verdict: z.enum(['import', 'skip']),
  reason: z.string().min(1),
});
export type ImportReportRow = z.infer<typeof ImportReportRowSchema>;

export const ImportReportSchema = z.array(ImportReportRowSchema);
export type ImportReport = z.infer<typeof ImportReportSchema>;

/** Parse an untrusted value (e.g. an edited report file); throws ZodError. */
export function parseImportReport(input: unknown): ImportReport {
  return ImportReportSchema.parse(input);
}

/** Human-readable report table for the terminal. */
export function renderImportReport(report: ImportReport): string {
  if (report.length === 0) return 'Empty report — no skills listed.';
  const lines: string[] = [`${report.length} skill(s)`, ''];
  for (const row of report) {
    lines.push(
      `${row.verdict === 'import' ? 'IMPORT' : 'skip  '}  ${row.skill}`,
      `        licence  ${row.licence ?? '- (none found)'}`,
      `        source   ${row.source}`,
      `        reason   ${row.reason}`,
      '',
    );
  }
  lines.pop();
  return lines.join('\n');
}
