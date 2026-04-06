/**
 * fetchChildren.ts - Single source of truth for child job data
 *
 * Queries Ponder to get ALL children of a parent job definition,
 * including their status and branch info. Replaces the dual-source
 * approach (completedChildRuns + hierarchy) with a single clean query.
 */

import { config } from '../../../../config/index.js';
import { workerLogger } from '../../../../logging/index.js';

/**
 * Child job info returned from Ponder query
 */
export interface ChildJobData {
    jobDefinitionId: string;
    jobName: string;
    status: 'COMPLETED' | 'FAILED' | 'ACTIVE';
    branchName?: string;
    baseBranch?: string;
}

/**
 * Raw response shape from Ponder GraphQL
 */
interface PonderChildResponse {
    data?: {
        jobDefinitions?: {
            items?: Array<{
                id: string;
                name: string;
                lastStatus: string;
                codeMetadata?: {
                    branch?: {
                        name?: string;
                    };
                    baseBranch?: string;
                };
            }>;
        };
    };
    errors?: Array<{ message: string }>;
}

/**
 * Fetch all children of a parent job definition from Ponder.
 *
 * Returns all child job definitions with their status and branch info.
 * This is the single source of truth for child data - no merging needed.
 */
export async function fetchAllChildren(parentJobDefId: string): Promise<ChildJobData[]> {
    if (!parentJobDefId) {
        workerLogger.warn('fetchAllChildren called with empty parentJobDefId');
        return [];
    }

    const ponderUrl = config.services.ponderUrl;

    const query = `
    query GetAllChildren($parentJobDefId: String!) {
      jobDefinitions(where: { sourceJobDefinitionId: $parentJobDefId }) {
        items {
          id
          name
          lastStatus
          codeMetadata
        }
      }
    }
  `;

    try {
        const response = await fetch(ponderUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                variables: { parentJobDefId },
            }),
        });

        if (!response.ok) {
            workerLogger.error(
                { parentJobDefId, status: response.status },
                'Ponder query failed for children'
            );
            return [];
        }

        const result: PonderChildResponse = await response.json();

        if (result.errors?.length) {
            workerLogger.error(
                { parentJobDefId, errors: result.errors },
                'Ponder query returned errors'
            );
            return [];
        }

        const items = result.data?.jobDefinitions?.items || [];

        const children: ChildJobData[] = items.map((item) => ({
            jobDefinitionId: item.id,
            jobName: item.name || `job-${item.id.slice(0, 8)}`,
            status: mapStatus(item.lastStatus),
            branchName: item.codeMetadata?.branch?.name,
            baseBranch: item.codeMetadata?.baseBranch,
        }));

        workerLogger.info(
            {
                parentJobDefId,
                totalChildren: children.length,
                completed: children.filter((c) => c.status === 'COMPLETED').length,
                failed: children.filter((c) => c.status === 'FAILED').length,
                active: children.filter((c) => c.status === 'ACTIVE').length,
            },
            'Fetched all children from Ponder'
        );

        return children;
    } catch (error) {
        workerLogger.error(
            { parentJobDefId, error: String(error) },
            'Failed to fetch children from Ponder'
        );
        return [];
    }
}

/**
 * Map Ponder lastStatus to our simplified status enum
 */
function mapStatus(lastStatus: string): 'COMPLETED' | 'FAILED' | 'ACTIVE' {
    const normalized = (lastStatus || '').toUpperCase();

    if (normalized === 'COMPLETED' || normalized === 'DELIVERED' || normalized === 'SUCCESS') {
        return 'COMPLETED';
    }

    if (normalized === 'FAILED' || normalized === 'ERROR') {
        return 'FAILED';
    }

    return 'ACTIVE';
}
