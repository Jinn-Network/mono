import * as React from 'react';
export interface ImprintRow { label: string; value: React.ReactNode }
/**
 * The colophon block itself: how this report was made. Closes every public report and every claim page.
 * This is the ONLY approved home for the "Built on Jinn." attribution, alongside the infrastructure and docs pages.
 */
export interface ImprintProps {
  /** Label/value pairs — method digest, lock time, runner, evaluator identities, report version. */
  rows?: ImprintRow[];
  /** Renders the factual attribution "Built on Jinn." at low emphasis. Omit outside reports, docs and verification pages. */
  builtOnJinn?: boolean;
  mark?: boolean;
  style?: React.CSSProperties;
}
export declare function Imprint(props: ImprintProps): JSX.Element;
