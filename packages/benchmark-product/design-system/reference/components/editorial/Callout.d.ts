import * as React from 'react';
/** Banded aside for the things a reader must not miss: limitations, method boundaries, cautions. Rule sits on top, never a left border. */
export interface CalloutProps {
  kind?: 'note' | 'limitation' | 'caution' | 'method';
  title?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Callout(props: CalloutProps): JSX.Element;
