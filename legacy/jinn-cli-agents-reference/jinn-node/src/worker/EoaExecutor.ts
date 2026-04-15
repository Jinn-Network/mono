/**
 * EOA Transaction Executor for Dual-Rail Architecture
 * 
 * This module provides direct transaction execution through an Externally Owned Account (EOA)
 * for the Jinn agent system. It implements the ITransactionExecutor interface and handles
 * direct signing and execution for transactions that don't require Safe multi-signature.
 * 
 * ## Security Features
 * 
 * - Allowlist-based contract and function validation
 * - Chain ID verification
 * - Payload integrity checks
 * - Direct EOA signing for speed and simplicity
 * - Comprehensive error categorization
 * 
 * ## Architecture
 * 
 * This executor is part of the dual-rail execution system and specifically
 * handles transactions that can be safely executed directly by an EOA for
 * improved speed and reduced complexity.
 * 
 * @version 2.0.0
 * @since Phase 3 - Dual Rail Architecture
 */

import { ethers } from 'ethers';
import { logger } from '../logging/index.js';
import { ITransactionExecutor, StatusUpdateCallback } from './IExecutor.js';
import { TransactionRequest } from './types/transaction.js';
import { ExecutionResult } from './types.js';
import { validateTransaction } from './validation.js';
import { updateTransactionStatus } from './control_api_client.js';
import { serializeError } from './logging/errors.js';
import { config, secrets, createRpcProvider } from '../config/index.js';
import { getServicePrivateKey } from '../env/operate-profile.js';

// Create a child logger for EOA executor operations
const eoaLogger = logger.child({ component: 'EOA-EXECUTOR' });

export class EoaExecutor implements ITransactionExecutor {
  private workerId: string;
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private chainId: number;
  private confirmations: number;

  constructor() {
    // Initialize worker configuration
    this.chainId = config.chain.chainId;
    this.confirmations = config.worker.txConfirmations;

    // Initialize blockchain connection
    const rpcUrl = secrets.rpcUrl;
    const privateKey = getServicePrivateKey();
    if (!privateKey) throw new Error('Worker private key not found in .operate config or environment');

    this.provider = createRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);

    eoaLogger.info('EoaExecutor initialized');
  }



  /**
   * Execute transaction directly with EOA signing
   */
  private async executeEoaTransaction(request: TransactionRequest): Promise<ExecutionResult> {
    try {
      // Prepare transaction object
      const tx = {
        to: request.payload.to,
        data: request.payload.data,
        value: request.payload.value
      };

      eoaLogger.info({ requestId: request.id, payload: tx }, 'Executing EOA transaction');

      // Send transaction
      const txResponse = await this.signer.sendTransaction(tx);
      eoaLogger.info({ requestId: request.id, txHash: txResponse.hash }, 'EOA transaction submitted');

      // Wait for confirmation
      const receipt = await txResponse.wait(this.confirmations);
      if (!receipt) {
        throw new Error('Failed to get transaction receipt after execution');
      }

      eoaLogger.info({ requestId: request.id, txHash: receipt.hash }, 'EOA transaction confirmed on-chain');

      return {
        success: true,
        txHash: receipt.hash
      };

    } catch (error: any) {
      eoaLogger.error({ requestId: request.id, error: error.message, stack: error.stack }, 'EOA transaction execution failed');

      // Categorize the error using valid transaction_error_code enum values
      let errorCode = 'UNKNOWN';
      let errorMessage = error.message || 'Unknown error occurred';

      if (error.message?.includes('insufficient funds')) {
        errorCode = 'INSUFFICIENT_FUNDS';
      } else if (error.message?.includes('revert')) {
        errorCode = 'SAFE_TX_REVERT'; // Use valid enum value
      } else if (error.message?.includes('network') || error.message?.includes('rpc')) {
        errorCode = 'RPC_FAILURE';
      } else if (error.message?.includes('nonce') || error.message?.includes('gas')) {
        // Consolidate nonce and gas errors into UNKNOWN as specific enum values don't exist
        errorCode = 'UNKNOWN';
      }

      return {
        success: false,
        errorCode,
        errorMessage
      };
    }
  }

  /**
   * Update transaction request status in database
   */
  private async updateTransactionStatus(
    requestId: string,
    status: 'CONFIRMED' | 'FAILED',
    result: ExecutionResult
  ): Promise<void> {
    try {
      if (result.success) {
        await updateTransactionStatus({ id: requestId, status, tx_hash: result.txHash });
      } else {
        await updateTransactionStatus({ id: requestId, status, error_code: result.errorCode, error_message: result.errorMessage });
      }
      eoaLogger.info('Transaction status updated via Control API');
    } catch (error) {
      eoaLogger.error({ error }, 'Error updating transaction status via Control API');
    }
  }

  /**
   * Process a single transaction request (implements ITransactionExecutor interface)
   */
  async processTransactionRequest(request: TransactionRequest, onStatusUpdate: StatusUpdateCallback): Promise<void> {
    eoaLogger.info({ requestId: request.id }, 'Processing EOA transaction request');

    try {
      // Validate the transaction with EOA execution context
      const validation = validateTransaction(request, {
        workerChainId: this.chainId,
        executionStrategy: 'EOA'
      });

      if (!validation.valid) {
        eoaLogger.warn({ requestId: request.id, error: validation.errorMessage }, 'EOA transaction validation failed');

        await onStatusUpdate(request.id, 'FAILED', {
          error_code: validation.errorCode,
          error_message: validation.errorMessage,
          completed_at: new Date().toISOString()
        });
        return;
      }

      // Execute the transaction
      const result = await this.executeEoaTransaction(request);

      // Update status based on result
      if (result.success) {
        await onStatusUpdate(request.id, 'CONFIRMED', {
          tx_hash: result.txHash,
          completed_at: new Date().toISOString()
        });
        eoaLogger.info({ requestId: request.id, txHash: result.txHash }, 'EOA transaction confirmed');
      } else {
        await onStatusUpdate(request.id, 'FAILED', {
          error_code: result.errorCode,
          error_message: result.errorMessage,
          completed_at: new Date().toISOString()
        });
        eoaLogger.error({ requestId: request.id, error: result.errorMessage }, 'EOA transaction failed');
      }
    } catch (error) {
      eoaLogger.error({ requestId: request.id, error }, 'Error processing EOA transaction');
      await onStatusUpdate(request.id, 'FAILED', {
        error_code: 'UNEXPECTED_ERROR',
        error_message: serializeError(error),
        completed_at: new Date().toISOString()
      });
    }
  }
}

/**
 * Factory function to create and configure an EoaExecutor
 */
export function createEoaExecutor(): EoaExecutor {
  return new EoaExecutor();
}
