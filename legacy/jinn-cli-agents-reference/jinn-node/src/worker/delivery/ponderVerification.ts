/**
 * Ponder-based delivery verification
 * 
 * Provides delivery status verification by querying Ponder GraphQL endpoint.
 * Used as a fallback when RPC verification fails.
 */

import { graphQLRequest } from '../../http/client.js';
import { workerLogger } from '../../logging/index.js';
import { config } from '../../config/index.js';

export async function checkDeliveryStatusViaPonder(params: {
  requestId: string;
  maxRetries?: number;
}): Promise<{ delivered: boolean; txHash?: string; error?: string }> {
  const { requestId, maxRetries = 3 } = params;
  const PONDER_URL = config.services.ponderUrl;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await graphQLRequest<{
        requests: {
          items: Array<{
            id: string;
            delivered: boolean;
            deliveryIpfsHash?: string;
            transactionHash?: string;
          }>;
        };
      }>({
        url: PONDER_URL,
        query: `
          query CheckDelivery($requestId: String!) {
            requests(where: { id: $requestId }) {
              items {
                id
                delivered
                deliveryIpfsHash
                transactionHash
              }
            }
          }
        `,
        variables: { requestId },
        context: { operation: 'checkDeliveryStatus', requestId },
        maxRetries: 0, // Handle retries at this level
      });

      const request = data?.requests?.items?.[0];
      if (!request) {
        workerLogger.warn({ requestId }, 'Request not found in Ponder');
        return { delivered: false, error: 'Request not found' };
      }

      return {
        delivered: request.delivered || false,
        txHash: request.transactionHash,
      };
    } catch (error: any) {
      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt - 1) * 1000;
        workerLogger.warn(
          { requestId, attempt, maxRetries, error: error?.message, backoffMs },
          'Ponder delivery check failed; retrying'
        );
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        workerLogger.error(
          { requestId, error: error?.message },
          'Ponder delivery check failed after all retries'
        );
        return { delivered: false, error: error?.message };
      }
    }
  }

  return { delivered: false, error: 'Max retries exceeded' };
}

