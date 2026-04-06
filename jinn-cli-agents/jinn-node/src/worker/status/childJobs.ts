/**
 * Child job queries: query Ponder for child job statuses
 */

import { graphQLRequest } from '../../http/client.js';
import { workerLogger } from '../../logging/index.js';
import { serializeError } from '../logging/errors.js';
import type { ChildJobStatus } from '../types.js';
import { config } from '../../config/index.js';

const PONDER_GRAPHQL_URL = config.services.ponderUrl;

/**
 * Result of child job status query including timing info
 */
export interface ChildJobStatusResult {
  childJobs: ChildJobStatus[];
  queryDuration_ms: number;
  retryAttempts: number;
}

/**
 * Query Ponder for child jobs of this request with retry logic
 * Returns array of {id, delivered} for each child plus timing info
 */
export async function getChildJobStatus(requestId: string): Promise<ChildJobStatusResult> {
  const maxAttempts = 3;
  const baseDelayMs = 300;
  const queryStart = Date.now();
  let attemptCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptCount = attempt;
    try {
      const data = await graphQLRequest<{ requests: { items: Array<{ id: string; delivered: boolean }> } }>({
        url: PONDER_GRAPHQL_URL,
        query: `
          query GetChildJobs($sourceRequestId: String!) {
            requests(where: { sourceRequestId: $sourceRequestId }) {
              items {
                id
                delivered
              }
            }
          }
        `,
        variables: { sourceRequestId: requestId },
        context: { operation: 'getChildJobStatus', requestId }
      });

      return {
        childJobs: data?.requests?.items || [],
        queryDuration_ms: Date.now() - queryStart,
        retryAttempts: attempt - 1,
      };
    } catch (error: any) {
      const serialized = serializeError(error);
      workerLogger.warn({
        requestId,
        attempt,
        maxAttempts,
        error: serialized
      }, 'Retrying child job status lookup after GraphQL error');

      if (attempt === maxAttempts) {
        const message = 'Failed to query child job status';
        workerLogger.error({
          requestId,
          error: serialized
        }, message);
        const wrapped = new Error(`${message}: ${serialized}`);
        if (error && typeof error === 'object') {
          (wrapped as any).cause = error;
        }
        throw wrapped;
      }

      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }

  return {
    childJobs: [],
    queryDuration_ms: Date.now() - queryStart,
    retryAttempts: attemptCount - 1,
  };
}

/**
 * Query all requests for a given job definition from Ponder
 * Used to find all runs of a job across its lifetime
 */
export async function queryRequestsByJobDefinition(
  jobDefinitionId: string
): Promise<Array<{ id: string; blockTimestamp: string }>> {
  const maxAttempts = 3;
  const baseDelayMs = 300;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await graphQLRequest<{ 
        requests: { items: Array<{ id: string; blockTimestamp: string }> } 
      }>({
        url: PONDER_GRAPHQL_URL,
        query: `
          query GetRequestsForJobDef($jobDefId: String!) {
            requests(
              where: { jobDefinitionId: $jobDefId }
              orderBy: "blockTimestamp"
              orderDirection: "asc"
              limit: 100
            ) {
              items {
                id
                blockTimestamp
              }
            }
          }
        `,
        variables: { jobDefId: jobDefinitionId },
        context: { operation: 'queryRequestsByJobDefinition', jobDefinitionId }
      });

      return data?.requests?.items || [];
    } catch (error: any) {
      if (attempt === maxAttempts) {
        workerLogger.error({
          jobDefinitionId,
          error: serializeError(error)
        }, 'Failed to query requests for job definition');
        return [];
      }
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }

  return [];
}

/**
 * Get all children across all runs of a job definition
 * This queries Ponder for fresh data, not relying on hierarchy snapshots
 */
export interface JobLevelChildStatusResult {
  allChildren: Array<{ id: string; delivered: boolean; requestId: string; jobDefinitionId?: string; jobStatus?: string }>;
  totalChildren: number;
  undeliveredChildren: number;
  activeChildren: number; // delivered but still DELEGATING/WAITING
  queryDuration_ms: number;
}

export async function getAllChildrenForJobDefinition(
  jobDefinitionId: string
): Promise<JobLevelChildStatusResult> {
  const queryStart = Date.now();
  
  // Step 1: Get all requests for this job definition
  const allRequests = await queryRequestsByJobDefinition(jobDefinitionId);
  
  workerLogger.debug({
    jobDefinitionId,
    requestCount: allRequests.length
  }, 'Querying children for all requests of job definition');
  
  // Step 2: Get children for each request (parallel queries)
  const childrenByRequest = await Promise.all(
    allRequests.map(req => getChildJobStatus(req.id))
  );
  
  // Step 3: Flatten and deduplicate by child request ID
  const allChildrenMap = new Map<string, { id: string; delivered: boolean; requestId: string; jobDefinitionId?: string; jobStatus?: string }>();
  
  for (let i = 0; i < allRequests.length; i++) {
    const parentRequestId = allRequests[i].id;
    const { childJobs } = childrenByRequest[i];
    
    for (const child of childJobs) {
      // Only store first occurrence of each child
      if (!allChildrenMap.has(child.id)) {
        allChildrenMap.set(child.id, {
          id: child.id,
          delivered: child.delivered,
          requestId: parentRequestId
        });
      }
    }
  }
  
  const allChildren = Array.from(allChildrenMap.values());
  const undeliveredChildren = allChildren.filter(c => !c.delivered).length;
  
  // Step 4: For delivered children, query their job definitions to check status
  // A child that delivered with DELEGATING/WAITING means work is still in progress
  const deliveredChildren = allChildren.filter(c => c.delivered);
  
  if (deliveredChildren.length > 0) {
    try {
      // Query job definitions for delivered children to get their lastStatus
      const childJobDefIds = new Set<string>();
      const jobDefQueryResult = await graphQLRequest<{
        requests: { items: Array<{ id: string; jobDefinitionId: string }> }
      }>({
        url: PONDER_GRAPHQL_URL,
        query: `
          query GetChildJobDefinitions($requestIds: [String!]!) {
            requests(where: { id_in: $requestIds }) {
              items {
                id
                jobDefinitionId
              }
            }
          }
        `,
        variables: { requestIds: deliveredChildren.map(c => c.id) },
        context: { operation: 'getChildJobDefinitions', jobDefinitionId }
      });
      
      // Map request IDs to their job definition IDs
      const requestToJobDefMap = new Map<string, string>();
      for (const req of jobDefQueryResult?.requests?.items || []) {
        if (req.jobDefinitionId) {
          requestToJobDefMap.set(req.id, req.jobDefinitionId);
          childJobDefIds.add(req.jobDefinitionId);
        }
      }
      
      // Query the job definitions to get their lastStatus
      if (childJobDefIds.size > 0) {
        const jobDefsResult = await graphQLRequest<{
          jobDefinitions: { items: Array<{ id: string; lastStatus: string }> }
        }>({
          url: PONDER_GRAPHQL_URL,
          query: `
            query GetJobDefinitionStatus($jobDefIds: [String!]!) {
              jobDefinitions(where: { id_in: $jobDefIds }) {
                items {
                  id
                  lastStatus
                }
              }
            }
          `,
          variables: { jobDefIds: Array.from(childJobDefIds) },
          context: { operation: 'getJobDefinitionStatus', jobDefinitionId }
        });
        
        const jobDefStatusMap = new Map<string, string>();
        for (const jobDef of jobDefsResult?.jobDefinitions?.items || []) {
          jobDefStatusMap.set(jobDef.id, jobDef.lastStatus);
        }
        
        // Update allChildren with job definition info
        for (const child of allChildren) {
          const childJobDefId = requestToJobDefMap.get(child.id);
          if (childJobDefId) {
            child.jobDefinitionId = childJobDefId;
            child.jobStatus = jobDefStatusMap.get(childJobDefId);
          }
        }
      }
    } catch (error) {
      workerLogger.warn({
        jobDefinitionId,
        error: serializeError(error)
      }, 'Failed to query child job definition statuses, will treat all delivered children as complete');
    }
  }
  
  // Count "active" children: delivered but with non-terminal status
  const activeChildren = allChildren.filter(c => 
    c.delivered && 
    c.jobStatus && 
    (c.jobStatus === 'DELEGATING' || c.jobStatus === 'WAITING')
  ).length;
  
  workerLogger.debug({
    jobDefinitionId,
    totalChildren: allChildren.length,
    undeliveredChildren,
    activeChildren,
    queryDuration_ms: Date.now() - queryStart
  }, 'Aggregated all children for job definition with status check');
  
  return {
    allChildren,
    totalChildren: allChildren.length,
    undeliveredChildren,
    activeChildren,
    queryDuration_ms: Date.now() - queryStart
  };
}

