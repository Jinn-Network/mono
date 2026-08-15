import * as React from 'react';
export interface AssuranceLevel { id: string; label: string; note: string }
/**
 * Makes the assurance behind a score legible: what counts as success, and how a delivery becomes a verdict.
 * Reads as a stepped meter, not a quality rating — a higher step means more independence, not a better result.
 */
export interface AssuranceMeterProps {
  value?: 'deterministic' | 'single' | 'separated' | 'majority' | 'unanimous' | string;
  /** Override the level ladder. Each level states its own guarantee in plain words. */
  levels?: AssuranceLevel[];
  onChange?: (id: string) => void;
  /** Display-only (report pages). */
  readOnly?: boolean;
  /** Replaces the note under the label. */
  caption?: string;
  style?: React.CSSProperties;
}
export declare function AssuranceMeter(props: AssuranceMeterProps): JSX.Element;
