import * as React from 'react';
/** Small metadata label — model names, task suites, run modes. For outcomes use VerdictChip instead. */
export interface TagProps {
  tone?: 'neutral' | 'ink' | 'accent' | 'indigo' | 'outline';
  /** Mono type for machine values (SHAs, versions, slugs). */
  mono?: boolean;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Tag(props: TagProps): JSX.Element;
