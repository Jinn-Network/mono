/**
 * Service Types
 *
 * Maps Ponder tables to consumer-friendly concepts:
 * - Service = Job Template (reusable blueprint)
 * - Service Instance = Workstream (specific running instance)
 */

// Maps to jobTemplate table in Ponder
export interface Service {
  id: string;
  templateId: string;
  name: string;
  description: string;
  tags: string[];
  priceUsd: string;
  runCount: number;
  createdAt: bigint;
}

// Maps to workstream table in Ponder
export interface ServiceInstance {
  id: string;
  workstreamId: string;
  jobName: string;
  sender: string;
  mech: string;
  blockTimestamp: bigint;
  lastActivity: bigint;
  childRequestCount: number;
  delivered: boolean;
}

// UI-friendly version with formatted data
export interface ServiceInstanceDisplay {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'completed' | 'pending';
  createdAt: string;
  lastActivity: string;
  requestCount: number;
}

/**
 * Parsed output from a SERVICE_OUTPUT artifact
 * Stored in artifact contentPreview as compact JSON
 */
export interface ServiceOutput {
  type: 'website' | 'api' | 'data_feed' | string;
  url: string;
  label?: string;
  primary?: boolean;
}
