/**
 * Transaction types for worker operations
 */

export interface TransactionInput {
  payload: TransactionPayload;
  chainId: number;
  executionStrategy: ExecutionStrategy;
  idempotencyKey?: string;
  sourceJobId?: string;
}

export interface TransactionPayload {
  to: string;
  data: string;
  value: string;
}

export type TransactionStatus = 'PENDING' | 'CLAIMED' | 'CONFIRMED' | 'FAILED';
export type ExecutionStrategy = 'EOA' | 'SAFE';

export interface TransactionRequest {
  id: string;
  status: TransactionStatus;
  attempt_count: number;
  payload_hash: string;
  worker_id: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  payload: TransactionPayload;
  chain_id: number;
  safe_tx_hash: string | null;
  tx_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  source_job_id: string | null;
  created_at: string;
  updated_at: string;
  execution_strategy: ExecutionStrategy;
  idempotency_key: string | null;
}

export interface UpdateMetadata {
  safe_tx_hash?: string;
  tx_hash?: string;
  error_code?: string;
  error_message?: string;
  completed_at?: string;
}
