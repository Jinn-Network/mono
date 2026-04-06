import { z } from 'zod';
import fetch from 'cross-fetch';
import { composeSinglePageResponse, decodeCursor } from './shared/context-management.js';
import { getCurrentJobContext } from './shared/context.js';
import { config } from '../../../config/index.js';

const base = z.object({
  query: z.string().min(1).describe('Case-insensitive text to match against job name and description.'),
  cursor: z.string().optional().describe('Opaque cursor for pagination.'),
  include_requests: z.boolean().optional().default(true).describe('If true, include requests made for each job.'),
  max_requests_per_job: z.number().optional().default(10).describe('Maximum number of requests to include per job.'),
});

export const searchJobsParams = base;
export type SearchJobsParams = z.infer<typeof searchJobsParams>;

export const searchJobsSchema = {
  description: 'Search job definitions by name/description. Returns job definitions with their associated requests.',
  inputSchema: searchJobsParams.shape,
};

async function fetchRequestsForJob(jobId: string, maxRequests: number): Promise<any[]> {
  const PONDER_GRAPHQL_URL = config.services.ponderUrl;
  const gql = `query GetJobRequests($jobId: String!, $limit: Int!) {
    requests(where: { sourceJobDefinitionId: $jobId }, 
            orderBy: "blockTimestamp", orderDirection: "desc", limit: $limit) {
      items { 
        id mech sender ipfsHash deliveryIpfsHash 
        blockTimestamp delivered requestData jobName
      }
    }
  }`;

  const variables = { jobId, limit: maxRequests };
  const res = await fetch(PONDER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables })
  });

  const json = await res.json();
  return json?.data?.requests?.items || [];
}

export async function searchJobs(params: SearchJobsParams) {
  try {
    const parsed = searchJobsParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: [], meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message } }) }]
      };
    }

    const { query, cursor, include_requests, max_requests_per_job } = parsed.data;
    const keyset = decodeCursor<{ offset: number }>(cursor) ?? { offset: 0 };

    // Get workstream context for scoping (if available)
    const context = getCurrentJobContext();
    const workstreamId = context.workstreamId;

    const PONDER_GRAPHQL_URL = config.services.ponderUrl;

    let jobs: any[] = [];

    if (workstreamId) {
      // Blood-Written Rule #11: Query requests by workstreamId first, then batch-fetch job definitions
      // This is necessary because jobDefinition.workstreamId only stores the FIRST workstream,
      // but a job can run in multiple workstreams. The requests table has the correct workstreamId.

      // Step 1: Get all unique jobDefinitionIds from requests in this workstream
      const requestsGql = `query GetWorkstreamJobs($workstreamId: String!, $limit: Int!) {
        requests(where: { workstreamId: $workstreamId }, limit: $limit) {
          items {
            jobDefinitionId
            jobName
          }
        }
      }`;

      const requestsRes = await fetch(PONDER_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: requestsGql, variables: { workstreamId, limit: 500 } })
      });

      const requestsJson = await requestsRes.json();
      const requests = requestsJson?.data?.requests?.items || [];

      // Extract unique jobDefinitionIds
      const jobDefIds = Array.from(new Set(requests
        .filter((r: any) => r.jobDefinitionId)
        .map((r: any) => r.jobDefinitionId)
      )) as string[];

      if (jobDefIds.length > 0) {
        // Step 2: Fetch job definitions by IDs, filtered by search query
        // Note: Ponder GraphQL may not support id_in, so we fetch all and filter client-side
        const jobsGql = `query GetJobDefinitions($ids: [String!]!, $limit: Int!) {
          jobDefinitions(where: { id_in: $ids }, limit: $limit) {
            items {
              id name blueprint enabledTools
              sourceJobDefinitionId sourceRequestId workstreamId
            }
          }
        }`;

        const jobsRes = await fetch(PONDER_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: jobsGql, variables: { ids: jobDefIds, limit: 100 } })
        });

        const jobsJson = await jobsRes.json();
        const allJobs = jobsJson?.data?.jobDefinitions?.items || [];

        // Filter by search query (case-insensitive)
        const lowerQuery = query.toLowerCase();
        jobs = allJobs.filter((job: any) => {
          const nameMatch = job.name?.toLowerCase().includes(lowerQuery);
          const blueprintMatch = job.blueprint?.toLowerCase().includes(lowerQuery);
          return nameMatch || blueprintMatch;
        });
      }
    } else {
      // No workstream context - search globally by name/blueprint
      const jobsGql = `query SearchJobs($q: String!, $limit: Int!) {
        jobDefinitions(where: { OR: [
          { name_contains: $q },
          { blueprint_contains: $q }
        ] }, limit: $limit) {
          items {
            id name blueprint enabledTools
            sourceJobDefinitionId sourceRequestId workstreamId
          }
        }
      }`;

      const res = await fetch(PONDER_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: jobsGql, variables: { q: query, limit: 100 } })
      });

      const json = await res.json();
      jobs = json?.data?.jobDefinitions?.items || [];
    }

    // Step 2: For each job, fetch its requests (if requested)
    let enrichedJobs = jobs;
    if (include_requests && jobs.length > 0) {
      const requestPromises = jobs.map(async (job: any) => {
        try {
          const requests = await fetchRequestsForJob(job.id, max_requests_per_job || 10);
          return { ...job, requests };
        } catch (error) {
          // If fetching requests fails for a job, include the job without requests
          return { ...job, requests: [], requestsError: 'Failed to fetch requests' };
        }
      });

      enrichedJobs = await Promise.all(requestPromises);
    }

    // Step 3: Apply pagination using context management utilities
    const composed = composeSinglePageResponse(enrichedJobs, {
      startOffset: keyset.offset,
      truncateChars: 1000, // Reduced since we're including more data
      perFieldMaxChars: 5000,
      pageTokenBudget: 10000, // 10k token budget per page
      upstreamLimit: 100, // Database limit - prevents false has_more when offset >= database page
      requestedMeta: { cursor, query, include_requests, max_requests_per_job, workstreamId: workstreamId || null }
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: composed.data,
          meta: { ok: true, ...composed.meta, source: 'ponder', type: 'job_definitions' }
        })
      }]
    };
  } catch (e: any) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ data: [], meta: { ok: false, code: 'UNEXPECTED_ERROR', message: e?.message || String(e) } }) }]
    };
  }
}


