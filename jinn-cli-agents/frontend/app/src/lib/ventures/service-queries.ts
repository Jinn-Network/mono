/**
 * Service Queries
 *
 * Query functions for fetching services and service instances
 * from the Ponder backend. Adapted for Explorer using graphql-request patterns.
 */

import {
  getWorkstreams,
  getWorkstream,
  getRequest,
  getJobDefinition,
  queryRequests,
  queryDeliveries,
  queryArtifacts,
  type Workstream,
  type JobDefinition,
  type Request,
  type Delivery,
  type Artifact,
} from '@/lib/subgraph';
import type { Service, ServiceInstance } from './service-types';

const PONDER_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || 'https://indexer.jinn.network/graphql';

/** Fetch a job definition with latestStatusUpdate fields (not in shared-ui's query) */
async function getJobDefinitionWithStatus(id: string): Promise<JobDefinition | null> {
  try {
    const resp = await fetch(PONDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: String!) {
          jobDefinition(id: $id) {
            id name enabledTools blueprint workstreamId
            sourceJobDefinitionId sourceRequestId codeMetadata
            dependencies createdAt lastInteraction lastStatus
            latestStatusUpdate latestStatusUpdateAt
          }
        }`,
        variables: { id },
      }),
      cache: 'no-store',
    });
    const json = await resp.json();
    return json.data?.jobDefinition ?? null;
  } catch {
    return null;
  }
}

/**
 * Transform a Workstream from Ponder to a ServiceInstance
 */
function toServiceInstance(workstream: Workstream): ServiceInstance {
  return {
    id: workstream.id,
    workstreamId: workstream.id,
    jobName: workstream.jobName || 'Unnamed Instance',
    sender: workstream.sender,
    mech: workstream.mech,
    blockTimestamp: BigInt(workstream.blockTimestamp),
    lastActivity: BigInt(workstream.lastActivity || workstream.blockTimestamp),
    childRequestCount: workstream.childRequestCount || 0,
    delivered: workstream.delivered || false,
  };
}

/**
 * Fetch all service instances (workstreams)
 */
export async function getServiceInstances(): Promise<ServiceInstance[]> {
  const response = await getWorkstreams();
  return response.requests.items.map(toServiceInstance);
}

/**
 * Fetch a single service instance by ID
 */
export async function getServiceInstance(workstreamId: string): Promise<ServiceInstance | null> {
  const workstream = await getWorkstream(workstreamId);
  return workstream ? toServiceInstance(workstream) : null;
}

/**
 * Get the root job definition for a workstream
 * Flow: workstream.id -> request -> jobDefinitionId -> jobDefinition (with blueprint)
 */
export async function getRootJobDefinition(workstreamId: string): Promise<JobDefinition | null> {
  // The workstream ID is the same as the root request ID
  const rootRequest = await getRequest(workstreamId);
  if (!rootRequest?.jobDefinitionId) {
    return null;
  }
  return getJobDefinition(rootRequest.jobDefinitionId);
}

/**
 * Get the root request for a workstream (ID is the same)
 */
export async function getRootRequest(workstreamId: string): Promise<Request | null> {
  return getRequest(workstreamId);
}

/**
 * Get MEASUREMENT artifacts for a workstream
 * These are artifacts created by agents when they measure invariants
 */
export async function getMeasurementArtifacts(workstreamId: string): Promise<Artifact[]> {
  const response = await queryArtifacts({
    where: {
      sourceRequestId: workstreamId,
      topic: 'MEASUREMENT'
    },
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit: 100
  });
  return response.items;
}

/**
 * Get SERVICE_OUTPUT artifacts for a workstream
 * These are external outputs like deployed websites, APIs, data feeds, etc.
 */
export async function getServiceOutputs(workstreamId: string): Promise<Artifact[]> {
  const response = await queryArtifacts({
    where: {
      sourceRequestId: workstreamId,
      topic: 'SERVICE_OUTPUT'
    },
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit: 10
  });
  return response.items;
}

/**
 * Get job definitions (activity) for a workstream
 * Returns jobDefinitions ordered by lastInteraction, showing job status updates
 *
 * Note: JobDefinitions don't have workstreamId directly, so we need to:
 * 1. Get requests for the workstream
 * 2. Get unique jobDefinitionIds from those requests
 * 3. Fetch those jobDefinitions
 */
export async function getWorkstreamActivity(workstreamId: string, limit: number = 50): Promise<{ jobDefinitions: JobDefinition[] }> {
  // First get requests for this workstream
  const requestsResponse = await queryRequests({
    where: { workstreamId },
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit
  });

  // Get unique jobDefinitionIds from the requests
  const jobDefIds = [...new Set(
    requestsResponse.items
      .map(r => r.jobDefinitionId)
      .filter((id): id is string => !!id)
  )];

  if (jobDefIds.length === 0) {
    return { jobDefinitions: [] };
  }

  // Fetch the jobDefinitions with latestStatusUpdate in parallel (not in shared-ui's query)
  const results = await Promise.all(
    jobDefIds.map(id => getJobDefinitionWithStatus(id).catch(() => null))
  );
  const jobDefinitions = results.filter((jd): jd is JobDefinition => jd !== null);

  // Sort by lastInteraction descending (lastInteraction is Unix timestamp in seconds)
  jobDefinitions.sort((a, b) => {
    const aTime = a.lastInteraction ? Number(a.lastInteraction) : 0;
    const bTime = b.lastInteraction ? Number(b.lastInteraction) : 0;
    return bTime - aTime;
  });

  return { jobDefinitions };
}
