import { createServer } from 'node:http';
import { workerLogger } from '../logging/index.js';
import { getMasterSafe, getServiceSafeAddress } from '../env/operate-profile.js';
import { config } from '../config/index.js';

const DEFAULT_HEALTHCHECK_PORT = 8080;
// Railway sets PORT env var for the exposed service port
const getRailwayPort = () => process.env.PORT ? parseInt(process.env.PORT, 10) : null;

/**
 * Get abbreviated node ID from master safe address
 * Uses first 8 chars of the safe address (after 0x)
 */
function getNodeId(): string {
  // Priority: JINN_NODE_ID env var > master safe > service safe
  const envNodeId = process.env.JINN_NODE_ID;
  if (envNodeId) {
    return envNodeId;
  }

  const masterSafe = getMasterSafe('base');
  if (masterSafe && masterSafe.startsWith('0x')) {
    return masterSafe.slice(2, 10).toLowerCase();
  }

  const serviceSafe = getServiceSafeAddress();
  if (serviceSafe && serviceSafe.startsWith('0x')) {
    return serviceSafe.slice(2, 10).toLowerCase();
  }

  return 'unknown';
}

interface WorkerHealthInfo {
  workerId: string;
  startedAt: Date;
  lastActivityAt: Date;
  processedJobs: number;
  // Efficiency metrics for CPU optimization measurement
  idleCycles: number;
  totalExecutionTimeMs: number;
  totalIdleTimeMs: number;
}

export interface FleetStateInfo {
  currentServiceConfigId: string | null;
  totalServices: number;
  stakedServices: number;
  rotationCount: number;
  lastPollAt: number | null;
}

// Global state for health tracking
let healthInfo: WorkerHealthInfo | null = null;
let fleetState: FleetStateInfo | null = null;

export function initHealthInfo(workerId: string): void {
  healthInfo = {
    workerId,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    processedJobs: 0,
    idleCycles: 0,
    totalExecutionTimeMs: 0,
    totalIdleTimeMs: 0,
  };
}

export function recordJobProcessed(): void {
  if (healthInfo) {
    healthInfo.processedJobs += 1;
    healthInfo.lastActivityAt = new Date();
  }
}

export function updateLastActivity(): void {
  if (healthInfo) {
    healthInfo.lastActivityAt = new Date();
  }
}

/**
 * Record an idle cycle (no jobs found/processed)
 */
export function recordIdleCycle(idleTimeMs: number): void {
  if (healthInfo) {
    healthInfo.idleCycles += 1;
    healthInfo.totalIdleTimeMs += idleTimeMs;
    healthInfo.lastActivityAt = new Date();
  }
}

/**
 * Record execution time for a job
 */
export function recordExecutionTime(executionTimeMs: number): void {
  if (healthInfo) {
    healthInfo.totalExecutionTimeMs += executionTimeMs;
    healthInfo.lastActivityAt = new Date();
  }
}

/**
 * Update fleet state from ServiceRotator.getState() for /health endpoint.
 */
export function updateFleetState(state: FleetStateInfo): void {
  fleetState = state;
}

export function startHealthcheckServer(): void {
  // Priority: Railway's PORT (platform-injected) > config.services.healthcheckPort (default 8080)
  const railwayPort = getRailwayPort();
  const port = railwayPort || config.services.healthcheckPort;

  const server = createServer((req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/health' || url.pathname === '/') {
      const now = new Date();
      const uptimeMs = healthInfo ? now.getTime() - healthInfo.startedAt.getTime() : 0;
      const lastActivityAgo = healthInfo ? now.getTime() - healthInfo.lastActivityAt.getTime() : 0;

      const nodeId = getNodeId();
      const totalExecutionMs = healthInfo?.totalExecutionTimeMs || 0;
      const totalIdleMs = healthInfo?.totalIdleTimeMs || 0;
      const processedJobs = healthInfo?.processedJobs || 0;
      const idleCycles = healthInfo?.idleCycles || 0;

      const response = {
        status: 'ok',
        nodeId,
        workerId: healthInfo?.workerId || process.env.WORKER_ID || 'unknown',
        uptime: {
          ms: uptimeMs,
          human: formatDuration(uptimeMs),
        },
        lastActivity: {
          ms: lastActivityAgo,
          human: `${formatDuration(lastActivityAgo)} ago`,
        },
        processedJobs,
        timestamp: now.toISOString(),
        // Efficiency metrics for CPU optimization measurement
        efficiency: {
          idleCycles,
          avgJobDurationMs: processedJobs > 0
            ? Math.round(totalExecutionMs / processedJobs)
            : 0,
          totalExecutionMs,
          totalIdleMs,
          idlePercent: uptimeMs > 0
            ? Math.round((totalIdleMs / uptimeMs) * 100)
            : 0,
        },
        // Fleet state from ServiceRotator (if multi-service mode)
        fleet: fleetState || undefined,
        // V8 memory usage for right-sizing VPS/container limits
        memory: (() => {
          const m = process.memoryUsage();
          return {
            heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(m.heapTotal / 1024 / 1024),
            rssMB: Math.round(m.rss / 1024 / 1024),
            externalMB: Math.round(m.external / 1024 / 1024),
          };
        })(),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    workerLogger.info({ port, railwayPort: railwayPort ?? 'not set' }, 'Healthcheck server started');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      workerLogger.warn({ port }, 'Healthcheck port already in use, skipping server start');
    } else {
      workerLogger.error({ error: err.message, port }, 'Healthcheck server error');
    }
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
