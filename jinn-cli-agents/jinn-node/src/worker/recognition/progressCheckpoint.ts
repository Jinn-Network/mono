/**
 * Progress checkpoint: gather and summarize completed workstream jobs
 * 
 * This module builds a checkpoint of work completed in the same workstream,
 * giving agents awareness of progress made by all prior jobs in the venture.
 */

import { workerLogger } from '../../logging/index.js';
import { graphQLRequest } from '../../http/client.js';
import { serializeError } from '../logging/errors.js';
import { summarizeWorkstreamProgress } from './summarize.js';
import { config } from '../../config/index.js';

export interface WorkstreamJob {
  requestId: string;
  jobName?: string;
  blockTimestamp: string;
  deliverySummary?: string;  // Extracted from delivery payload
}

export interface ProgressCheckpoint {
  checkpointSummary: string;  // AI-generated summary for prompt injection
  workstreamJobs: WorkstreamJob[];
  stats: {
    totalJobs: number;
    completedJobs: number;
  };
}

/**
 * Build a basic fallback summary when AI summarization is not available
 */
function buildFallbackSummary(workstreamJobs: WorkstreamJob[]): string {
  const lines: string[] = [
    '## Workstream Progress',
    '',
    `${workstreamJobs.length} job(s) have been completed in this workstream (most recent first):`,
    '',
  ];

  for (const job of workstreamJobs.slice(0, 10)) {
    const jobTitle = job.jobName || `Job ${job.requestId.slice(0, 8)}`;
    const timestamp = new Date(parseInt(job.blockTimestamp) * 1000).toISOString().split('T')[0];
    lines.push(`### ${jobTitle}`);
    lines.push(`*Completed: ${timestamp}*`);
    
    if (job.deliverySummary) {
      const preview = job.deliverySummary.slice(0, 200);
      lines.push(preview + (job.deliverySummary.length > 200 ? '...' : ''));
    } else {
      lines.push('*(No summary available)*');
    }
    lines.push('');
  }

  if (workstreamJobs.length > 10) {
    lines.push(`*(+ ${workstreamJobs.length - 10} more completed jobs)*`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Reconstruct directory CID from delivery IPFS hash (f01551220...)
 * Implementation matches scripts/inspect-job-run.ts and ponder/src/index.ts
 */
function reconstructDeliveryCid(deliveryHash: string): string | null {
  if (!deliveryHash.startsWith('f01551220')) {
    return null;
  }

  try {
    const digestHex = deliveryHash.replace(/^f01551220/i, '');
    
    // Convert hex digest to bytes
    const digestBytes: number[] = [];
    for (let i = 0; i < digestHex.length; i += 2) {
      digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16));
    }
    
    // Build CIDv1 bytes: [0x01] + [0x70] (dag-pb) + multihash: [0x12, 0x20] + digest
    const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];
    
    // Base32 encode (lowercase, no padding)
    const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bitBuffer = 0;
    let bitCount = 0;
    let out = '';
    
    for (const b of cidBytes) {
      bitBuffer = (bitBuffer << 8) | (b & 0xff);
      bitCount += 8;
      while (bitCount >= 5) {
        const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
        bitCount -= 5;
        out += base32Alphabet[idx];
      }
    }
    
    if (bitCount > 0) {
      const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
      out += base32Alphabet[idx];
    }
    
    return 'b' + out;
  } catch (e) {
    workerLogger.warn({ deliveryHash, error: serializeError(e) }, 'Failed to reconstruct delivery CID');
    return null;
  }
}

/**
 * Fetch and parse delivery payload from IPFS
 */
async function fetchDeliveryPayload(
  deliveryHash: string,
  requestId: string
): Promise<{ structuredSummary?: string; output?: string } | null> {
  const gatewayBase = (config.services.ipfsGatewayUrl || 'https://gateway.autonolas.tech/ipfs/').replace(/\/+$/, '');
  
  // Reconstruct directory CID
  const dirCid = reconstructDeliveryCid(deliveryHash);
  if (!dirCid) {
    workerLogger.warn({ requestId, deliveryHash }, 'Could not reconstruct directory CID for delivery');
    return null;
  }
  
  const url = `${gatewayBase}/${dirCid}/${requestId}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    try {
      const response = await fetch(url, { signal: controller.signal });
      
      if (!response.ok) {
        workerLogger.warn({ requestId, url, status: response.status }, 'Failed to fetch delivery payload from IPFS');
        return null;
      }
      
      const data = await response.json();
      return data;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    workerLogger.warn({ requestId, url, error: serializeError(error) }, 'Error fetching delivery payload');
    return null;
  }
}

/**
 * Build progress checkpoint by gathering completed workstream job outputs
 * 
 * @param requestId - Current request ID
 * @param metadata - Job metadata (workstreamId, etc.)
 * @param currentJobObjective - The objective of the current job (for AI summarization)
 * @param currentJobName - Name of the current job
 * @returns Progress checkpoint with AI-generated summary, or null if no prior work
 */
export async function buildProgressCheckpoint(
  requestId: string,
  metadata: { sourceRequestId?: string; jobDefinitionId?: string; workstreamId?: string },
  currentJobObjective?: string,
  currentJobName?: string
): Promise<ProgressCheckpoint | null> {

  try {
    const PONDER_GRAPHQL_URL = config.services.ponderUrl;
    
    // First, fetch the current request to get its workstreamId
    let workstreamId = metadata.workstreamId;
    
    if (!workstreamId) {
      const currentRequestData = await graphQLRequest<{
        request?: {
          id: string;
          workstreamId?: string;
        };
      }>({
        url: PONDER_GRAPHQL_URL,
        query: `
          query GetCurrentRequestWorkstream($requestId: String!) {
            request(id: $requestId) {
              id
              workstreamId
            }
          }
        `,
        variables: { requestId },
        context: {
          operation: 'fetchWorkstreamId',
          requestId,
        },
      });
      
      workstreamId = currentRequestData?.request?.workstreamId;
      
      if (!workstreamId) {
        workerLogger.debug({ requestId }, 'Could not determine workstreamId for progress checkpoint');
        return null;
      }
    }
    
    // Query all completed jobs in the workstream (excluding current)
    const workstreamData = await graphQLRequest<{
      requests: {
        items: Array<{
          id: string;
          jobName?: string;
          delivered: boolean;
          deliveryIpfsHash?: string;
          blockTimestamp: string;
        }>;
      };
    }>({
      url: PONDER_GRAPHQL_URL,
      query: `
        query GetWorkstreamJobs($workstreamId: String!, $currentId: String!) {
          requests(
            where: { 
              workstreamId: $workstreamId,
              id_not: $currentId,
              delivered: true
            },
            orderBy: "blockTimestamp",
            orderDirection: "desc",
            limit: 50
          ) {
            items {
              id
              jobName
              delivered
              deliveryIpfsHash
              blockTimestamp
            }
          }
        }
      `,
      variables: {
        workstreamId,
        currentId: requestId,
      },
      context: {
        operation: 'buildProgressCheckpoint',
        requestId,
        workstreamId,
      },
    });

    const completedJobs = workstreamData?.requests?.items || [];
    
    if (completedJobs.length === 0) {
      workerLogger.debug({ requestId, workstreamId }, 'No completed jobs found in workstream for progress checkpoint');
      return null;
    }
    
    workerLogger.info({
      requestId,
      workstreamId,
      completedJobs: completedJobs.length,
    }, 'Building workstream progress checkpoint');

    // Fetch delivery payloads for completed jobs
    const workstreamJobsWithSummaries = await Promise.all(
      completedJobs.map(async (job) => {
        let deliverySummary: string | undefined;
        
        if (job.deliveryIpfsHash) {
          try {
            const payload = await fetchDeliveryPayload(job.deliveryIpfsHash, job.id);
            
            if (payload) {
              // Prefer structuredSummary, fallback to output (truncated)
              if (payload.structuredSummary) {
                deliverySummary = payload.structuredSummary;
              } else if (payload.output) {
                // Truncate to 1000 characters
                deliverySummary = payload.output.slice(0, 1000);
                if (payload.output.length > 1000) {
                  deliverySummary += '...';
                }
              }
            }
          } catch (error: any) {
            workerLogger.warn({
              requestId,
              jobId: job.id,
              error: serializeError(error),
            }, 'Failed to fetch delivery payload for workstream job');
          }
        }

        return {
          requestId: job.id,
          jobName: job.jobName,
          blockTimestamp: job.blockTimestamp,
          deliverySummary,
        };
      })
    );

    workerLogger.info({
      requestId,
      workstreamId,
      completedJobs: completedJobs.length,
      jobsWithSummaries: workstreamJobsWithSummaries.filter(j => j.deliverySummary).length,
    }, 'Fetched workstream job summaries');

    // Generate AI-powered summary of workstream progress
    let checkpointSummary = '';
    
    if (currentJobObjective) {
      const aiSummary = await summarizeWorkstreamProgress(
        workstreamJobsWithSummaries,
        currentJobObjective,
        currentJobName,
        requestId
      );
      
      if (aiSummary) {
        checkpointSummary = aiSummary;
      } else {
        // Fallback: basic summary if AI summarization fails
        workerLogger.warn({ requestId }, 'AI summarization failed, using fallback summary');
        checkpointSummary = buildFallbackSummary(workstreamJobsWithSummaries);
      }
    } else {
      // No objective provided, use fallback
      checkpointSummary = buildFallbackSummary(workstreamJobsWithSummaries);
    }

    return {
      checkpointSummary,
      workstreamJobs: workstreamJobsWithSummaries,
      stats: {
        totalJobs: completedJobs.length,
        completedJobs: completedJobs.length,
      },
    };
  } catch (error: any) {
    workerLogger.error({
      requestId,
      error: serializeError(error),
    }, 'Failed to build progress checkpoint');
    return null;
  }
}
