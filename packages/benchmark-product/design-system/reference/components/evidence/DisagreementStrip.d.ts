import * as React from 'react';
export interface EvaluatorVerdict { id: string; verdict: 'met' | 'unmet' | 'unverifiable'; note?: string }
/**
 * Shows which evaluator identity produced which verdict, and how the split was handled.
 * Disagreement is content, not an error state — this component exists so it can be published rather than smoothed over.
 */
export interface DisagreementStripProps {
  evaluators?: EvaluatorVerdict[];
  /** How the split was handled. "retained" means no resolution was forced. */
  resolution?: 'retained' | 'majority' | 'unanimous' | 'unresolved';
  taskId?: string;
  style?: React.CSSProperties;
}
export declare function DisagreementStrip(props: DisagreementStripProps): JSX.Element;
