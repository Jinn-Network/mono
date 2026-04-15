/**
 * Service Queries
 *
 * Query functions for fetching services and service instances
 * from the Ponder backend.
 */

import {
  getWorkstreams,
  getWorkstream,
  getRequest,
  getJobDefinition,
  queryJobTemplates,
  queryArtifacts,
  type Workstream,
  type JobTemplate,
  type JobDefinition,
  type Request,
  type Delivery,
  type Artifact,
  getRequestsAndDeliveries,
  queryDeliveries
} from '@jinn/shared-ui';
import type { Service, ServiceInstance } from './service-types';

/**
 * Transform a JobTemplate from Ponder to a Service
 */
function toService(template: JobTemplate): Service {
  return {
    id: template.id,
    templateId: template.id,
    name: template.name || 'Unnamed Service',
    description: template.description || '',
    tags: template.tags || [],
    priceUsd: template.priceUsd || '0',
    runCount: template.runCount || 0,
    createdAt: BigInt(template.createdAt || '0'),
  };
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
 * Fetch all visible services (job templates)
 */
export async function getServices(): Promise<Service[]> {
  const response = await queryJobTemplates();
  return response.items.map(toService);
}

/**
 * Fetch a single service by ID
 */
export async function getService(templateId: string): Promise<Service | null> {
  const response = await queryJobTemplates();
  const template = response.items.find(t => t.id === templateId);
  return template ? toService(template) : null;
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
  // Use direct lookup instead of fetching all and filtering
  const workstream = await getWorkstream(workstreamId);
  return workstream ? toServiceInstance(workstream) : null;
}

/**
 * Fetch service instances for a specific service
 */
export async function getServiceInstancesForService(templateId: string): Promise<ServiceInstance[]> {
  // TODO: Filter workstreams by template ID once the relationship is established
  const response = await getWorkstreams();
  return response.requests.items.map(toServiceInstance);
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
 * Get child requests (activity) for a workstream
 * Returns requests ordered by timestamp, showing job creation and completion events
 */
export async function getWorkstreamActivity(workstreamId: string, limit: number = 50): Promise<{ requests: Request[], deliveries: Delivery[] }> {
  const { queryRequests, queryDeliveries } = await import('@jinn/shared-ui');

  // First fetch requests for this workstream
  const requestsResponse = await queryRequests({
    where: { workstreamId },
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit
  });

  const requests = requestsResponse.items;

  // If no requests, no deliveries to fetch
  if (requests.length === 0) {
    return { requests: [], deliveries: [] };
  }

  // Fetch deliveries for the requests in this workstream
  // The delivery.requestId matches request.id, so we filter client-side
  // after fetching recent deliveries globally (Ponder doesn't support _in filters easily)
  const requestIds = new Set(requests.map(r => r.id));

  // Fetch recent deliveries - more than we need to ensure coverage
  const deliveriesResponse = await queryDeliveries({
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit: limit * 2
  });

  // Filter to only deliveries for requests in this workstream
  const deliveries = deliveriesResponse.items.filter(d => requestIds.has(d.requestId));

  return { requests, deliveries };
}

/**
 * Get global activity (recent requests and deliveries)
 */
export async function getGlobalActivity(limit: number = 20): Promise<{ requests: Request[], deliveries: Delivery[] }> {
  return getRequestsAndDeliveries({
    limit,
    orderBy: 'blockTimestamp',
    orderDirection: 'desc'
  });
}
