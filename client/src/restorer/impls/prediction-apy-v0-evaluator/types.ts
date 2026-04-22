export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string | Record<string, unknown>;
}

export type Verdict = 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE';
