import * as React from 'react';
/** Numbered section opener for reports and long pages: heavy rule, display title, optional standfirst. */
export interface SectionHeadProps {
  /** Section number, e.g. "04" — set in mono, sits in the left margin. */
  number?: string;
  title: React.ReactNode;
  /** One-paragraph summary directly under the title. */
  standfirst?: string;
  actions?: React.ReactNode;
  rule?: 'heavy' | 'hair' | 'none';
  level?: 2 | 3 | 4;
  style?: React.CSSProperties;
}
export declare function SectionHead(props: SectionHeadProps): JSX.Element;
