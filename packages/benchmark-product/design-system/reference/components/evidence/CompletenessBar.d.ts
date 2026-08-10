import * as React from 'react';
export interface CompletenessSegment { verdict: 'met' | 'unmet' | 'conflicted' | 'attested' | 'incomplete' | 'unverifiable'; count: number; label?: string }
/**
 * Full accounting of every expected execution, including the ones that never returned.
 * The bar is denominated by expected runs, not by returned runs — incompleteness is visible by construction.
 */
export interface CompletenessBarProps {
  segments?: CompletenessSegment[];
  /** Expected executions. If omitted, the segment counts are summed — prefer passing it explicitly. */
  total?: number;
  size?: 'md' | 'lg';
  showLegend?: boolean;
  label?: string;
  style?: React.CSSProperties;
}
export declare function CompletenessBar(props: CompletenessBarProps): JSX.Element;
