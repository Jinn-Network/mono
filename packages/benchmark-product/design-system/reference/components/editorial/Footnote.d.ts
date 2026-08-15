import * as React from 'react';
/** Marginal note carrying a caveat, a source, or a link into full evidence. Never grey fine print — same weight as body. */
export interface FootnoteProps {
  /** Reference marker, e.g. "1", "†", "a". Rendered in vermilion mono. */
  marker: string;
  /** Optional destination — usually the evidence path for this claim. */
  href?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Footnote(props: FootnoteProps): JSX.Element;
