import * as React from 'react';
/** Multi-select option with an optional second line for the consequence of choosing it. */
export interface CheckboxProps {
  label: React.ReactNode;
  /** Second line — state what the choice changes, e.g. "Adds a second evaluator identity." */
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  id?: string;
  style?: React.CSSProperties;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
