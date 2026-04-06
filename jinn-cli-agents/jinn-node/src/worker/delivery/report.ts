/**
 * Report storage: compose final delivery record, call Control API
 */

import { workerLogger } from '../../logging/index.js';
import { createJobReport as apiCreateJobReport } from '../control_api_client.js';
import { serializeError } from '../logging/errors.js';
import type { UnclaimedRequest, FinalStatus, AgentExecutionResult, IpfsMetadata } from '../types.js';

/**
 * Store on-chain report via Control API
 */
export async function storeOnchainReport(
  request: UnclaimedRequest,
  _workerAddress: string,
  result: AgentExecutionResult,
  finalStatus: FinalStatus,
  error?: any,
  metadata?: IpfsMetadata
): Promise<void> {
  try {
    const payload = {
      status: finalStatus.status,  // Use inferred status
      duration_ms: result?.telemetry?.duration || 0,
      total_tokens: result?.telemetry?.totalTokens || 0,
      tools_called: JSON.stringify(result?.telemetry?.toolCalls ?? []),
      final_output: result?.output || null,
      error_message: error ? serializeError(error) : null,
      error_type: error ? 'AGENT_ERROR' : null,
      raw_telemetry: JSON.stringify({
        ...result?.telemetry ?? {},
        finalStatus,  // Include inferred status in telemetry
        sourceJobDefinitionId: metadata?.sourceJobDefinitionId,  // Preserve parent reference
        jobInstanceStatusUpdate: result.jobInstanceStatusUpdate // Include extracted status update string
      })
    };
    await apiCreateJobReport(request.id, payload);
  } catch (reportError: any) {
    workerLogger.warn({
      requestId: request.id,
      status: finalStatus.status,
      error: serializeError(reportError)
    }, `Failed to store on-chain report (status ${finalStatus.status})`);
  }
}
