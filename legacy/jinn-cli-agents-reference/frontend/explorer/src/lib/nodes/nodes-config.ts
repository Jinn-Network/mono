/**
 * Worker Nodes Configuration
 *
 * Known worker node endpoints for health monitoring.
 * Each node has a healthcheck endpoint that reports status.
 */

export interface WorkerNode {
  id: string;
  name: string;
  description: string;
  healthcheckUrl: string;
  owner?: string;
  location?: string;
}

export interface NodeHealthStatus {
  status: 'ok' | 'error' | 'unknown';
  nodeId?: string;
  service?: string;
  workerId?: string;
  uptime?: {
    ms: number;
    human: string;
  };
  lastActivity?: {
    ms: number;
    human: string;
  };
  processedJobs?: number;
  timestamp: string;
}

// Known worker nodes
export const WORKER_NODES: WorkerNode[] = [
  {
    id: 'jinn-worker-prod',
    name: 'Jinn Worker',
    description: 'Production worker on Railway',
    healthcheckUrl: process.env.NEXT_PUBLIC_WORKER_HEALTH_URL || 'https://jinn-worker-production.up.railway.app/health',
    location: 'Railway Cloud',
  },
];

/**
 * Fetch health status from a node
 */
export async function fetchNodeHealth(node: WorkerNode): Promise<NodeHealthStatus | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(node.healthcheckUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    // Try to parse JSON response, but handle empty body gracefully
    const text = await response.text();
    if (!text || text.trim() === '') {
      // Empty 200 response - service is up but no detailed health info
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const data = JSON.parse(text);
      return data as NodeHealthStatus;
    } catch {
      // Non-JSON response but 200 status - service is up
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    }
  } catch {
    return null;
  }
}

/**
 * Fetch health status for all nodes
 */
export async function fetchAllNodesHealth(): Promise<Map<string, NodeHealthStatus | null>> {
  const results = new Map<string, NodeHealthStatus | null>();

  await Promise.all(
    WORKER_NODES.map(async (node) => {
      const health = await fetchNodeHealth(node);
      results.set(node.id, health);
    })
  );

  return results;
}
