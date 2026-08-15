import * as React from 'react';
export interface SelectOption { value: string; label: string }
/** Native dropdown, ruled to match Input. Use for closed sets: model, harness, evaluation policy. */
export interface SelectProps {
  label?: string;
  hint?: string;
  options?: (string | SelectOption)[];
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  id?: string;
  style?: React.CSSProperties;
}
export declare function Select(props: SelectProps): JSX.Element;
