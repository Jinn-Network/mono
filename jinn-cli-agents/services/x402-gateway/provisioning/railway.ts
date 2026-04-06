/**
 * Railway provisioning for x402 gateway
 * Re-exports from shared Railway module with per-project creation
 */

import {
  createRailwayProject,
  createRailwayService as sharedCreateService,
  setRailwayVariables,
  type RailwayServiceResult,
} from '../../../scripts/shared/railway.js';

export { setRailwayVariables as setRailwayServiceVariables } from '../../../scripts/shared/railway.js';
export type { RailwayServiceResult as RailwayProvisionResult } from '../../../scripts/shared/railway.js';

/**
 * Create a Railway project and service for a customer
 * This is the x402-gateway specific orchestration that creates per-workstream projects
 */
export async function provisionRailwayService(
  customerSlug: string,
  repoFullName: string
): Promise<RailwayServiceResult> {
  // Create a dedicated project for this workstream
  const projectName = `jinn-${customerSlug}`;
  console.log(`[provision] Creating Railway project: ${projectName}...`);
  const project = await createRailwayProject(projectName);

  // Create the service within the new project
  const serviceName = `blog-${customerSlug}`;
  console.log(`[provision] Creating Railway service: ${serviceName}...`);
  const service = await sharedCreateService(
    project.projectId,
    serviceName,
    { repo: repoFullName }
  );

  return service;
}
