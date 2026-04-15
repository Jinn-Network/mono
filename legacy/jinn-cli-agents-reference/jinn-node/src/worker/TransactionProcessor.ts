import { EoaExecutor } from './EoaExecutor.js';
import { TransactionRequest, TransactionStatus, UpdateMetadata } from './types/transaction.js';
import { logger } from '../logging/index.js';
import { claimTransactionRequest, updateTransactionStatus } from './control_api_client.js';

const txLogger = logger.child({ component: 'TransactionProcessor' });

export class TransactionProcessor {
    private eoaExecutor: EoaExecutor;
    private workerId: string;

    constructor(_supabaseUrl: string, _supabaseKey: string, workerId: string) {
        this.eoaExecutor = new EoaExecutor();
        this.workerId = workerId;
        txLogger.info("TransactionProcessor initialized (SafeExecutor removed)");
    }

    public async processPendingTransaction(): Promise<boolean> {
        const request = await this.claimPendingTransaction();
        if (!request) {
            return false;
        }

        await this.routeTransaction(request);
        return true;
    }

    private async claimPendingTransaction(): Promise<TransactionRequest | null> {
        try {
            const req = await claimTransactionRequest();
            if (!req) return null;
            txLogger.info({ requestId: req.id, strategy: req.execution_strategy }, "Claimed transaction request via Control API");
            return req as TransactionRequest;
        } catch (error) {
            txLogger.error({ error }, "Error claiming transaction request via Control API");
            return null;
        }
    }

    private async routeTransaction(request: TransactionRequest): Promise<void> {
        txLogger.info({ requestId: request.id, strategy: request.execution_strategy }, "Routing transaction");
        try {
            if (request.execution_strategy === 'SAFE') {
                txLogger.warn({ requestId: request.id }, "SAFE execution strategy no longer supported, falling back to EOA");
                // Update the request's execution strategy to EOA so validation passes
                request.execution_strategy = 'EOA';
            }

            // All transactions now use EOA executor
            if (request.execution_strategy !== 'EOA') {
                txLogger.warn({ requestId: request.id, originalStrategy: request.execution_strategy }, "Unknown execution strategy, defaulting to EOA");
                request.execution_strategy = 'EOA';
            }

            // Status update callback that redirects to Control API
            const onStatusUpdate = async (id: string, status: TransactionStatus, metadata?: UpdateMetadata) => {
                const updateParams: any = { id, status };
                if (metadata) {
                    if (metadata.tx_hash) updateParams.tx_hash = metadata.tx_hash;
                    if (metadata.error_code) updateParams.error_code = metadata.error_code;
                    if (metadata.error_message) updateParams.error_message = metadata.error_message;
                }
                await updateTransactionStatus(updateParams);
            };

            await this.eoaExecutor.processTransactionRequest(request, onStatusUpdate);
        } catch (error) {
            txLogger.error({ requestId: request.id, error }, "Error processing transaction");
            await this.updateTransactionAsFailed(request.id, 'ROUTING_ERROR', `Transaction routing failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async updateTransactionAsFailed(requestId: string, errorCode: string, errorMessage: string): Promise<void> {
        try {
            await updateTransactionStatus({ id: requestId, status: 'FAILED', error_code: errorCode, error_message: errorMessage });
            txLogger.info({ requestId, errorCode, errorMessage }, "Transaction marked as FAILED via Control API");
        } catch (error) {
            txLogger.error({ requestId, error }, "Error updating transaction status to FAILED via Control API");
        }
    }
}
