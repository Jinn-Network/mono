'use server'

import { getWorkstreamActivity, getGlobalActivity } from '@/lib/service-queries';
import type { Request, Delivery } from '@jinn/shared-ui';

/**
 * Server action to fetch workstream activity
 * Used for polling in client components
 */
export async function fetchWorkstreamActivityAction(workstreamId: string): Promise<{ requests: Request[], deliveries: Delivery[] }> {
    try {
        return await getWorkstreamActivity(workstreamId);
    } catch (error) {
        console.error('Failed to fetch activity:', error);
        return { requests: [], deliveries: [] };
    }
}

/**
 * Server action to fetch global activity
 */
export async function fetchGlobalActivityAction(): Promise<{ requests: Request[], deliveries: Delivery[] }> {
    try {
        return await getGlobalActivity();
    } catch (error) {
        console.error('Failed to fetch global activity:', error);
        return { requests: [], deliveries: [] };
    }
}
