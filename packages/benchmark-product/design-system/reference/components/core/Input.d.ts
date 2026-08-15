import * as React from 'react';
/** Single-line text field with a small-caps label and a mono mode for IDs, hashes and task counts. */
export interface InputProps {
  label?: string;
  /** Helper or error text below the field; turns vermilion when invalid. */
  hint?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Render the value in IBM Plex Mono — use for IDs, digests, URLs, counts. */
  mono?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  id?: string;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
