/**
 * Transaction Executor Interface
 *
 * This interface defines the contract that all transaction executors must implement
 * in the dual-rail execution architecture. It provides a common interface for both
 * EOA (Externally Owned Account) and Safe (Gnosis Safe) execution strategies.
 *
 * @version 2.1.0
 * @since Phase 3 - Dual Rail Architecture
 */

import { TransactionRequest, TransactionStatus, UpdateMetadata } from './types/transaction.js';
import { ExecutionResult } from './types.js';

/**
 * Callback type for status updates during transaction processing
 */
export type StatusUpdateCallback = (
  id: string,
  status: TransactionStatus,
  metadata?: UpdateMetadata
) => Promise<void>;

/**
 * Interface that all transaction executors must implement
 */
export interface ITransactionExecutor {
  /**
   * Process a single transaction request
   *
   * This method handles the complete lifecycle of a transaction:
   * 1. Validates the transaction against security constraints
   * 2. Executes the transaction using the appropriate method (EOA or Safe)
   * 3. Reports status via the provided callback
   *
   * @param request The transaction request to process
   * @param onStatusUpdate Callback for reporting status changes
   */
  processTransactionRequest(
    request: TransactionRequest,
    onStatusUpdate: StatusUpdateCallback
  ): Promise<void>;
}
