import * as React from 'react';
/**
 * Ruled container — a boxed section of a publication, not a floating panel. No shadow by default.
 * @startingPoint section="Editorial" subtitle="Cards, section heads, callouts and footnotes" viewport="700x300"
 */
export interface CardProps {
  title?: React.ReactNode;
  /** Small-caps line above the title. */
  eyebrow?: string;
  /** Right-aligned controls in the header. */
  actions?: React.ReactNode;
  /** Ruled-off caption band at the bottom — the natural home for limitations and provenance. */
  footnote?: React.ReactNode;
  tone?: 'raised' | 'sunken' | 'flat';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
