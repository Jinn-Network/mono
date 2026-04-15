/**
 * Venture-scoped Ponder Queries
 *
 * These queries use `ventureId` to fetch data across ALL workstreams
 * belonging to a venture, rather than a single workstream.
 */

import { request } from 'graphql-request';
import {
  queryRequests,
  queryArtifacts,
  getJobDefinition,
  type Request,
  type Artifact,
  type JobDefinition,
  type Workstream,
} from '@/lib/subgraph';

const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || 'https://indexer.jinn.network/graphql';

/**
 * Get all requests belonging to a venture.
 */
export async function getVentureRequests(ventureId: string, limit = 100): Promise<Request[]> {
  const response = await queryRequests({
    where: { ventureId },
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit,
  });
  return response.items;
}

/**
 * Get job definitions (activity) for a venture across all workstreams.
 * Two-step: requests by ventureId -> unique jobDefinitionIds -> jobDefinitions.
 */
export async function getVentureActivity(ventureId: string, limit = 50): Promise<{ jobDefinitions: JobDefinition[] }> {
  const requests = await getVentureRequests(ventureId, limit);

  const jobDefIds = [...new Set(
    requests
      .map(r => r.jobDefinitionId)
      .filter((id): id is string => !!id)
  )];

  if (jobDefIds.length === 0) {
    return { jobDefinitions: [] };
  }

  const jobDefinitions: JobDefinition[] = [];
  for (const id of jobDefIds) {
    const jobDef = await getJobDefinition(id);
    if (jobDef) {
      jobDefinitions.push(jobDef);
    }
  }

  jobDefinitions.sort((a, b) => {
    const aTime = a.lastInteraction ? Number(a.lastInteraction) : 0;
    const bTime = b.lastInteraction ? Number(b.lastInteraction) : 0;
    return bTime - aTime;
  });

  return { jobDefinitions };
}

/**
 * Get measurement artifacts for a venture.
 * Two-step: requests by ventureId -> artifact by sourceRequestId_in + MEASUREMENT topic.
 */
export async function getVentureMeasurements(ventureId: string): Promise<Artifact[]> {
  const requests = await getVentureRequests(ventureId, 200);
  const requestIds = requests.map(r => r.id);

  if (requestIds.length === 0) return [];

  // Artifacts use sourceRequestId (root workstream ID), so we need unique workstream IDs
  const workstreamIds = [...new Set(
    requests
      .map(r => r.workstreamId)
      .filter((id): id is string => !!id)
  )];

  if (workstreamIds.length === 0) return [];

  // Query measurement artifacts by sourceRequestId (which is set to the workstream root)
  const allArtifacts: Artifact[] = [];
  for (const wsId of workstreamIds) {
    const response = await queryArtifacts({
      where: {
        sourceRequestId: wsId,
        topic: 'MEASUREMENT',
      },
      orderBy: 'blockTimestamp',
      orderDirection: 'desc',
      limit: 100,
    });
    allArtifacts.push(...response.items);
  }

  // Sort all by timestamp desc
  allArtifacts.sort((a, b) => {
    const aTime = Number(a.blockTimestamp || 0);
    const bTime = Number(b.blockTimestamp || 0);
    return bTime - aTime;
  });

  return allArtifacts;
}

/**
 * Get SERVICE_OUTPUT artifacts for a venture.
 */
export async function getVentureServiceOutputs(ventureId: string): Promise<Artifact[]> {
  const requests = await getVentureRequests(ventureId, 200);
  const workstreamIds = [...new Set(
    requests
      .map(r => r.workstreamId)
      .filter((id): id is string => !!id)
  )];

  if (workstreamIds.length === 0) return [];

  const allArtifacts: Artifact[] = [];
  for (const wsId of workstreamIds) {
    const response = await queryArtifacts({
      where: {
        sourceRequestId: wsId,
        topic: 'SERVICE_OUTPUT',
      },
      orderBy: 'blockTimestamp',
      orderDirection: 'desc',
      limit: 10,
    });
    allArtifacts.push(...response.items);
  }

  return allArtifacts;
}

/**
 * Get dispatched requests for a specific template within a venture over a time period.
 */
export async function getScheduleDispatches(
  ventureId: string,
  templateId: string,
  sinceDaysAgo = 30,
): Promise<{ count: number; latestRequest: Request | null; requests: Request[] }> {
  const sinceTimestamp = Math.floor((Date.now() - sinceDaysAgo * 86400000) / 1000);

  const response = await queryRequests({
    where: {
      ventureId,
      templateId,
      blockTimestamp_gte: String(sinceTimestamp),
    },
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit: 100,
  });

  return {
    count: response.items.length,
    latestRequest: response.items[0] || null,
    requests: response.items,
  };
}

/**
 * Get all workstreams belonging to a venture.
 * Falls back to request-based lookup if the workstreams table
 * doesn't have ventureId indexed yet (schema migration in progress).
 */
export async function getVentureWorkstreams(ventureId: string, limit = 50): Promise<Workstream[]> {
  // Try direct workstream query first (requires ventureId column on workstreams table)
  try {
    const query = `
      query VentureWorkstreams($ventureId: String!, $limit: Int) {
        workstreams(
          where: { ventureId: $ventureId }
          orderBy: "lastActivity"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            id
            rootRequestId
            jobName
            blockTimestamp
            lastActivity
            childRequestCount
            hasLauncherBriefing
            delivered
            mech
            sender
            ventureId
            templateId
          }
        }
      }
    `;

    type WorkstreamRaw = {
      id: string
      rootRequestId: string
      jobName: string
      blockTimestamp: string
      lastActivity: string
      childRequestCount: number
      hasLauncherBriefing: boolean
      delivered: boolean
      mech: string
      sender: string
      ventureId: string | null
      templateId: string | null
    };

    const data = await request<{ workstreams: { items: WorkstreamRaw[] } }>(SUBGRAPH_URL, query, {
      ventureId,
      limit,
    });

    return data.workstreams.items.map(ws => ({
      id: ws.id,
      jobName: ws.jobName,
      blockTimestamp: ws.blockTimestamp,
      mech: ws.mech,
      sender: ws.sender,
      childRequestCount: ws.childRequestCount,
      hasLauncherBriefing: ws.hasLauncherBriefing,
      delivered: ws.delivered,
      lastActivity: ws.lastActivity,
      ventureId: ws.ventureId,
      templateId: ws.templateId,
    }));
  } catch {
    // Fallback: workstreams table doesn't have ventureId yet (Ponder re-indexing).
    // Find workstreams via requests table (which does have ventureId).
    const ventureRequests = await getVentureRequests(ventureId, 200);
    const workstreamIds = [...new Set(
      ventureRequests
        .map(r => r.workstreamId)
        .filter((id): id is string => !!id)
    )];

    if (workstreamIds.length === 0) return [];

    // Build workstreamId → templateId map from root requests
    const templateByWorkstream = new Map<string, string>();
    for (const req of ventureRequests) {
      if (req.workstreamId && req.templateId && !templateByWorkstream.has(req.workstreamId)) {
        templateByWorkstream.set(req.workstreamId, req.templateId);
      }
    }

    const fallbackQuery = `
      query WorkstreamsByIds($ids: [String!]!, $limit: Int) {
        workstreams(
          where: { id_in: $ids }
          orderBy: "lastActivity"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            id
            rootRequestId
            jobName
            blockTimestamp
            lastActivity
            childRequestCount
            hasLauncherBriefing
            delivered
            mech
            sender
          }
        }
      }
    `;

    type WorkstreamFallback = {
      id: string
      rootRequestId: string
      jobName: string
      blockTimestamp: string
      lastActivity: string
      childRequestCount: number
      hasLauncherBriefing: boolean
      delivered: boolean
      mech: string
      sender: string
    };

    const data = await request<{ workstreams: { items: WorkstreamFallback[] } }>(SUBGRAPH_URL, fallbackQuery, {
      ids: workstreamIds,
      limit,
    });

    return data.workstreams.items.map(ws => ({
      id: ws.id,
      jobName: ws.jobName,
      blockTimestamp: ws.blockTimestamp,
      mech: ws.mech,
      sender: ws.sender,
      childRequestCount: ws.childRequestCount,
      hasLauncherBriefing: ws.hasLauncherBriefing,
      delivered: ws.delivered,
      lastActivity: ws.lastActivity,
      ventureId: ventureId,
      templateId: templateByWorkstream.get(ws.id) ?? null,
    }));
  }
}
