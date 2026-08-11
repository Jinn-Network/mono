import * as React from 'react';
/** Binary toggle for view state (show failures, dark theme). Not for consequential settings — use Checkbox with a description. */
export interface SwitchProps {
  label?: React.ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
  style?: React.CSSProperties;
}
export declare function Switch(props: SwitchProps): JSX.Element;
