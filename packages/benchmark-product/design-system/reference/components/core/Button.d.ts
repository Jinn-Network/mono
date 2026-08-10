import * as React from 'react';
/**
 * Primary action control. Ink-filled for the committing action, ruled outline for everything else.
 * @startingPoint section="Core" subtitle="Buttons, inputs, tags and toggles" viewport="700x220"
 */
export interface ButtonProps {
  /** Ink fill (primary), vermilion fill (accent, reserved for publish/launch), ruled outline, ghost, or destructive. */
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Leading glyph node (Lucide 16px recommended). */
  icon?: React.ReactNode;
  iconAfter?: React.ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Button(props: ButtonProps): JSX.Element;
