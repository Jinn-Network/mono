import * as React from 'react';
/**
 * README / docs badge. Three fields — source, value, status — and it always links to the full report.
 * The status field states how the result was obtained; it is deliberately not a pass/fail seal.
 * @startingPoint section="Claim" subtitle="Badges, report cards, citations and method locks" viewport="700x320"
 */
export interface ClaimBadgeProps {
  /** Left field. Defaults to "colophon"; use the suite name when space allows. */
  label?: string;
  /** The claim itself, e.g. "62.4% · 500 tasks". Always carry the denominator. */
  value: React.ReactNode;
  /** How the result was obtained — never a bare "verified". */
  status?: 'observed' | 'attested' | 'conflicted' | 'incomplete' | 'draft';
  /** Full report URL. Required in practice — a badge that does not resolve is not permitted. */
  href?: string;
  style?: React.CSSProperties;
}
export declare function ClaimBadge(props: ClaimBadgeProps): JSX.Element;
