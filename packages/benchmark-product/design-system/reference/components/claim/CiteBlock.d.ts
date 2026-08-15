import * as React from 'react';
export interface CiteTab { id: string; label: string; value: string }
/** Tabbed copy-out block for the ways a report travels: Markdown badge, HTML embed, BibTeX, CLI rerun, JSON claim URL. */
export interface CiteBlockProps {
  tabs?: CiteTab[];
  /** Controlled active tab id. */
  active?: string;
  onSelect?: (id: string) => void;
  /** Overrides the active tab's body. */
  value?: string;
  style?: React.CSSProperties;
}
export declare function CiteBlock(props: CiteBlockProps): JSX.Element;
