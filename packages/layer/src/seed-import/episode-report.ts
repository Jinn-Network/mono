/**
 * The EpisodeImportReport — the evidence-episode analogue of `report.ts`'s
 * ImportReport (issue #1771). Episodes are first-party authored content (no
 * upstream licence to gate on, unlike the skills.sh skill lane) so `verdict`
 * here is structural, not licence-based: 'skip' only for a duplicate `id`
 * within the same batch (see `episode-plan.ts`). `seed execute --episodes-dir`
 * still reads this report as the approval-gate artifact — nothing publishes
 * that was not on the list a human reviewed, and `contentDigest` binds each
 * row to the exact canonical episode content present at planning time.
 */

import { z } from 'zod';

export const EpisodeImportReportRowSchema = z.strictObject({
  id: z.string().min(1),
  taskSummary: z.string().min(1),
  tags: z.array(z.string().min(1)),
  /** SHA-256 over the canonical episode content the operator approved. */
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: z.enum(['import', 'skip']),
  reason: z.string().min(1),
});
export type EpisodeImportReportRow = z.infer<typeof EpisodeImportReportRowSchema>;

export const EpisodeImportReportSchema = z.array(EpisodeImportReportRowSchema);
export type EpisodeImportReport = z.infer<typeof EpisodeImportReportSchema>;

/** Parse an untrusted value (e.g. an edited report file); throws ZodError. */
export function parseEpisodeImportReport(input: unknown): EpisodeImportReport {
  return EpisodeImportReportSchema.parse(input);
}

/** Human-readable report table for the terminal. */
export function renderEpisodeImportReport(report: EpisodeImportReport): string {
  if (report.length === 0) return 'Empty report — no episodes listed.';
  const lines: string[] = [`${report.length} episode(s)`, ''];
  for (const row of report) {
    lines.push(
      `${row.verdict === 'import' ? 'IMPORT' : 'skip  '}  ${row.id}`,
      `        summary  ${row.taskSummary}`,
      `        tags     ${row.tags.join(', ')}`,
      `        digest   ${row.contentDigest}`,
      `        reason   ${row.reason}`,
      '',
    );
  }
  lines.pop();
  return lines.join('\n');
}
