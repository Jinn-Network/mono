import * as React from 'react';
export interface ReportEntrant { name: string; score?: number; display?: string }
/**
 * The shareable social card / OG image for a published report. Fixed 600px design width (scale for 1200×630).
 * It states the claim, ranks the entrants, and names the execution status — but it never stands alone:
 * every card resolves to the full report.
 */
export interface ReportCardProps {
  title: React.ReactNode;
  /** Task suite and size, e.g. "SWE-bench Verified · 500 tasks". */
  suite?: string;
  /** Run or publication date. */
  date?: string;
  /** Compared configurations, in the order the report ranks them. */
  entrants?: ReportEntrant[];
  status?: 'observed' | 'attested' | 'conflicted' | 'incomplete';
  footer?: React.ReactNode;
  width?: number;
  style?: React.CSSProperties;
}
export declare function ReportCard(props: ReportCardProps): JSX.Element;
