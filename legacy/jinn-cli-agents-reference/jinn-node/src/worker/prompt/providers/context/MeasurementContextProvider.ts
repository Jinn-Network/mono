/**
 * MeasurementContextProvider - Provides latest measurement data for invariants
 *
 * This provider fetches MEASUREMENT artifacts from Ponder and makes them
 * available in BlueprintContext so the invariant renderer can show
 * measurement status alongside each invariant.
 */

import { config } from '../../../../config/index.js';
import { workerLogger } from '../../../../logging/index.js';
import type {
  ContextProvider,
  BuildContext,
  BlueprintContext,
  BlueprintBuilderConfig,
  MeasurementInfo,
} from '../../types.js';

/**
 * Raw measurement data from artifact contentPreview
 * Note: DELEGATED type is deprecated and will be ignored
 */
interface RawMeasurement {
  invariant_id: string;
  invariant_type?: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';
  score?: number | boolean;
  measured_value?: number;
  threshold?: { min?: number; max?: number };
  passed?: boolean;
  context?: string;
}

/**
 * Raw response shape from Ponder GraphQL artifacts query
 */
interface PonderArtifactsResponse {
  data?: {
    artifacts?: {
      items?: Array<{
        id: string;
        contentPreview?: string;
        blockTimestamp?: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Fetch workstream ID for the current request
 */
async function fetchWorkstreamId(requestId: string): Promise<string | null> {
  const ponderUrl = config.services.ponderUrl;

  const query = `
    query GetWorkstreamId($requestId: String!) {
      mechRequests(where: { id: $requestId }) {
        items {
          workstreamId
        }
      }
    }
  `;

  try {
    const response = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { requestId } }),
    });

    if (!response.ok) return null;

    const result = await response.json();
    return result.data?.mechRequests?.items?.[0]?.workstreamId || null;
  } catch {
    return null;
  }
}

/**
 * Fetch MEASUREMENT artifacts for a workstream
 */
async function fetchMeasurementArtifacts(workstreamId: string): Promise<MeasurementInfo[]> {
  const ponderUrl = config.services.ponderUrl;

  const query = `
    query GetMeasurementArtifacts($workstreamId: String!) {
      artifacts(
        where: { sourceRequestId: $workstreamId, topic: "MEASUREMENT" }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: 100
      ) {
        items {
          id
          contentPreview
          blockTimestamp
        }
      }
    }
  `;

  try {
    const response = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { workstreamId } }),
    });

    if (!response.ok) {
      workerLogger.warn({ workstreamId, status: response.status }, 'Failed to fetch measurement artifacts');
      return [];
    }

    const result: PonderArtifactsResponse = await response.json();

    if (result.errors?.length) {
      workerLogger.warn({ workstreamId, errors: result.errors }, 'Ponder returned errors for measurements');
      return [];
    }

    const items = result.data?.artifacts?.items || [];
    const measurementMap = new Map<string, MeasurementInfo>();

    for (const item of items) {
      if (!item.contentPreview) continue;

      try {
        const raw: RawMeasurement = JSON.parse(item.contentPreview);
        if (!raw.invariant_id) continue;

        // Only keep the latest measurement for each invariant (first seen due to desc order)
        if (measurementMap.has(raw.invariant_id)) continue;

        // Parse timestamp
        let timestamp: string | undefined;
        let age: string | undefined;
        if (item.blockTimestamp) {
          const ts = typeof item.blockTimestamp === 'string'
            ? parseInt(item.blockTimestamp, 10)
            : Number(item.blockTimestamp);
          timestamp = new Date(ts * 1000).toISOString();
          age = formatAge(ts);
        }

        // Determine passed status
        const passed = raw.passed ?? (typeof raw.score === 'boolean' ? raw.score : undefined);

        measurementMap.set(raw.invariant_id, {
          invariantId: raw.invariant_id,
          type: raw.invariant_type || inferType(raw),
          value: raw.measured_value ?? raw.score,
          passed,
          context: raw.context,
          timestamp,
          age,
        });
      } catch {
        // Skip malformed measurements
        continue;
      }
    }

    return Array.from(measurementMap.values());
  } catch (error) {
    workerLogger.warn({ workstreamId, error: String(error) }, 'Error fetching measurement artifacts');
    return [];
  }
}

/**
 * Infer invariant type from measurement data when not explicitly set
 */
function inferType(raw: RawMeasurement): 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN' {
  if (typeof raw.passed === 'boolean' && raw.measured_value === undefined) return 'BOOLEAN';
  if (raw.threshold?.min !== undefined && raw.threshold?.max !== undefined) return 'RANGE';
  if (raw.threshold?.max !== undefined) return 'CEILING';
  return 'FLOOR';
}

/**
 * Format timestamp age as human-readable string
 */
function formatAge(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

/**
 * MeasurementContextProvider fetches latest measurements for invariants
 */
export class MeasurementContextProvider implements ContextProvider {
  name = 'measurement-context';

  enabled(config: BlueprintBuilderConfig): boolean {
    // Enable when job context is enabled (measurements are part of job state)
    return config.enableJobContext;
  }

  async provide(ctx: BuildContext): Promise<Partial<BlueprintContext>> {
    const requestId = ctx.requestId;

    // First, get the workstream ID for this request
    const workstreamId = await fetchWorkstreamId(requestId);
    if (!workstreamId) {
      workerLogger.debug({ requestId }, 'No workstream ID found for measurement fetch');
      return {};
    }

    // Fetch measurement artifacts for the workstream
    const measurements = await fetchMeasurementArtifacts(workstreamId);

    if (measurements.length === 0) {
      workerLogger.debug({ workstreamId }, 'No measurements found for workstream');
      return {};
    }

    workerLogger.info(
      {
        workstreamId,
        measurementCount: measurements.length,
        invariantIds: measurements.map((m) => m.invariantId),
      },
      'Loaded measurements for invariant context'
    );

    return { measurements };
  }
}
