import type { SessionResult } from './types.js';

/**
 * SEAM: what happens to finished work.
 * Local implementation records the GitHub PR / escalation; the future
 * SolverNet implementation submits an on-chain delivery for evaluation.
 */
export interface DeliverySink {
  /** Record a finished session's outcome, verifying external state. */
  collect(result: SessionResult): Promise<void>;
}
