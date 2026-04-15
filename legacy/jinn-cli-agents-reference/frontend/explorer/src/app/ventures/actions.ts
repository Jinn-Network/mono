'use server'

import { getWorkstreamActivity } from '@/lib/ventures/service-queries';
import type { JobDefinition } from '@/lib/subgraph';

/**
 * Server action to fetch workstream activity
 * Used for polling in client components
 */
export async function fetchWorkstreamActivityAction(workstreamId: string): Promise<{ jobDefinitions: JobDefinition[] }> {
    try {
        return await getWorkstreamActivity(workstreamId);
    } catch (error) {
        console.error('Failed to fetch activity:', error);
        return { jobDefinitions: [] };
    }
}
