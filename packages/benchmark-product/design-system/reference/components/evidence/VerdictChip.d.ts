import * as React from 'react';
/**
 * States an outcome in the system's six-value vocabulary. Colour and fill texture are redundant,
 * so the state survives monochrome printing and colour-blind reading. Never renders a bare tick.
 * @startingPoint section="Evidence" subtitle="Verdicts, assurance, accounting and disagreement" viewport="700x300"
 */
export interface VerdictChipProps {
  verdict?: 'met' | 'unmet' | 'conflicted' | 'attested' | 'incomplete' | 'unverifiable';
  /** Override the fill texture: how the result was obtained, independent of the verdict. */
  texture?: 'observed' | 'attested' | 'conflicted' | 'missing';
  /** Optional tally shown in mono after the label. */
  count?: number | string;
  size?: 'sm' | 'md';
  /** Replaces the default label text. Keep to the approved vocabulary. */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function VerdictChip(props: VerdictChipProps): JSX.Element;
export declare const VERDICTS: Record<string, { label: string; c: string; bg: string }>;
