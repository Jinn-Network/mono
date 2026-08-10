import * as React from 'react';
/** Square glyph-only control for toolbars and table rows. Always takes a label for assistive text. */
export interface IconButtonProps {
  /** Accessible name — also rendered as the title tooltip. Required. */
  label: string;
  icon: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'outline';
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  style?: React.CSSProperties;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
