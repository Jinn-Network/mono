import type { PolledIssue } from './types.js';

/**
 * SEAM: where ready issues come from.
 * Local implementation polls `gh`; the future SolverNet implementation
 * claims on-chain tasks. Nothing above this interface knows which.
 */
export interface IssueSource {
  /** Poll for all candidate issues with their taxonomy fields. */
  poll(): Promise<PolledIssue[]>;
}
