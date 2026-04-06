/**
 * Railway API - Shared Provisioning Module
 * 
 * Generic Railway provisioning for any workstream.
 * Creates per-workstream projects for full isolation.
 */

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

// ============================================================================
// Types
// ============================================================================

export interface RailwayProjectResult {
    projectId: string;
    name: string;
}

export interface RailwayServiceResult {
    serviceId: string;
    domain: string;
    projectId: string;
    environmentId: string;
}

export interface RailwayServiceSource {
    repo?: string;   // GitHub repo (e.g., "owner/repo")
    image?: string;  // Docker image
}

// ============================================================================
// Helpers
// ============================================================================

function getToken(): string {
    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) {
        throw new Error('RAILWAY_API_TOKEN environment variable is required');
    }
    return token;
}

async function railwayGraphQL<T = any>(
    query: string,
    variables: Record<string, any>
): Promise<T> {
    const response = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ query, variables }),
    });

    const result = await response.json();
    if (result.errors) {
        throw new Error(`Railway API error: ${JSON.stringify(result.errors)}`);
    }
    return result.data;
}

// ============================================================================
// Project Management
// ============================================================================

/**
 * Create a new Railway project for a workstream
 * @param name - Project name (e.g., "jinn-acme-corp")
 */
export async function createRailwayProject(
    name: string,
    options: { dryRun?: boolean; workspaceId?: string } = {}
): Promise<RailwayProjectResult> {
    if (options.dryRun) {
        console.log(`[DRY RUN] Would create Railway project: ${name}`);
        return { projectId: 'proj_dryrun', name };
    }

    // Check if a project with this name already exists
    const listQuery = `
    query Projects {
      projects {
        edges {
          node {
            id
            name
            workspaceId
          }
        }
      }
    }
  `;

    const listData = await railwayGraphQL(listQuery, {});
    const projects = listData.projects?.edges || [];
    const existing = projects.find((p: any) => {
        if (p.node.name !== name) return false;
        if (options.workspaceId && p.node.workspaceId !== options.workspaceId) return false;
        return true;
    });

    if (existing) {
        console.log(`[railway] Project ${name} already exists, reusing (${existing.node.id})`);
        return { projectId: existing.node.id, name: existing.node.name };
    }

    const mutation = `
    mutation ProjectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
      }
    }
  `;

    const data = await railwayGraphQL(mutation, {
        input: { name, ...(options.workspaceId && { workspaceId: options.workspaceId }) },
    });

    const project = data.projectCreate;
    if (!project?.id) {
        throw new Error('Failed to create Railway project - no ID returned');
    }

    console.log(`[railway] Created project: ${project.name} (${project.id})`);
    return { projectId: project.id, name: project.name };
}

/**
 * Get project info including environments
 */
export async function getProjectEnvironments(
    projectId: string
): Promise<{ environmentId: string; name: string }[]> {
    const query = `
    query GetProjectEnvironments($projectId: String!) {
      project(id: $projectId) {
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

    const data = await railwayGraphQL(query, { projectId });
    const edges = data.project?.environments?.edges || [];
    return edges.map((e: any) => ({
        environmentId: e.node.id,
        name: e.node.name,
    }));
}

// ============================================================================
// Service Management
// ============================================================================

/**
 * Create a Railway service in a project
 * @param projectId - Railway project ID
 * @param serviceName - Name for the service
 * @param source - Either a GitHub repo or Docker image
 */
export async function createRailwayService(
    projectId: string,
    serviceName: string,
    source: RailwayServiceSource,
    options: { dryRun?: boolean } = {}
): Promise<RailwayServiceResult> {
    if (options.dryRun) {
        console.log(`[DRY RUN] Would create Railway service: ${serviceName}`);
        console.log(`[DRY RUN] In project: ${projectId}`);
        console.log(`[DRY RUN] Source: ${JSON.stringify(source)}`);
        return {
            serviceId: 'srv_dryrun',
            domain: `${serviceName}.up.railway.app`,
            projectId,
            environmentId: 'env_dryrun',
        };
    }

    // Check if service already exists
    const listQuery = `
    query GetProjectServices($projectId: String!) {
      project(id: $projectId) {
        services {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

    const listData = await railwayGraphQL(listQuery, { projectId });
    const services = listData.project?.services?.edges || [];
    const existing = services.find((s: any) => s.node.name === serviceName);

    if (existing) {
        console.log(`[railway] Service ${serviceName} already exists, reusing`);
        const environments = await getProjectEnvironments(projectId);
        const prodEnv = environments.find(e => e.name === 'production') || environments[0];

        // Get existing domain
        const domain = await getServiceDomain(projectId, existing.node.id, prodEnv?.environmentId);

        return {
            serviceId: existing.node.id,
            domain: domain || `${serviceName}.up.railway.app`,
            projectId,
            environmentId: prodEnv?.environmentId || '',
        };
    }

    // Create service
    const createMutation = `
    mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `;

    const sourceInput: any = {};
    if (source.repo) {
        sourceInput.repo = source.repo.replace('git@github.com:', '').replace('.git', '');
    }
    if (source.image) {
        sourceInput.image = source.image;
    }

    const createData = await railwayGraphQL(createMutation, {
        input: {
            projectId,
            name: serviceName,
            source: sourceInput,
        },
    });

    const service = createData.serviceCreate;
    if (!service?.id) {
        throw new Error('Failed to create Railway service - no ID returned');
    }

    console.log(`[railway] Created service: ${service.name} (${service.id})`);

    // Get environment ID
    const environments = await getProjectEnvironments(projectId);
    const prodEnv = environments.find(e => e.name === 'production') || environments[0];
    const environmentId = prodEnv?.environmentId || '';

    // Generate domain
    const domain = await createServiceDomain(service.id, environmentId);

    // Trigger deployment
    if (environmentId) {
        await triggerDeployment(service.id, environmentId);
    }

    return {
        serviceId: service.id,
        domain,
        projectId,
        environmentId,
    };
}

/**
 * Get existing domain for a service
 */
async function getServiceDomain(
    projectId: string,
    serviceId: string,
    environmentId?: string
): Promise<string | null> {
    const query = `
    query GetServiceDomains($projectId: String!, $serviceId: String!) {
      project(id: $projectId) {
        environments {
          edges {
            node {
              id
              name
              serviceDomains(serviceId: $serviceId) {
                domain
              }
            }
          }
        }
      }
    }
  `;

    const data = await railwayGraphQL(query, { projectId, serviceId });
    const edges = data.project?.environments?.edges || [];

    // Find the target environment or first one with a domain
    for (const edge of edges) {
        if (environmentId && edge.node.id !== environmentId) continue;
        const domains = edge.node.serviceDomains || [];
        if (domains.length > 0) {
            return domains[0].domain;
        }
    }

    return null;
}

/**
 * Create a domain for a service
 */
async function createServiceDomain(
    serviceId: string,
    environmentId: string
): Promise<string> {
    const mutation = `
    mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        domain
      }
    }
  `;

    const data = await railwayGraphQL(mutation, {
        input: { serviceId, environmentId },
    });

    const domain = data.serviceDomainCreate?.domain;
    if (domain) {
        console.log(`[railway] Created domain: ${domain}`);
    }
    return domain || '';
}

/**
 * Trigger a deployment
 */
async function triggerDeployment(
    serviceId: string,
    environmentId: string
): Promise<void> {
    const mutation = `
    mutation ServiceInstanceDeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
    }
  `;

    try {
        await railwayGraphQL(mutation, { serviceId, environmentId });
        console.log(`[railway] Deployment triggered`);
    } catch (err: any) {
        console.warn(`[railway] Deployment trigger warning: ${err.message}`);
    }
}

// ============================================================================
// Variables
// ============================================================================

/**
 * Set environment variables on a service
 */
export async function setRailwayVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>,
    options: { dryRun?: boolean } = {}
): Promise<void> {
    if (options.dryRun) {
        console.log(`[DRY RUN] Would set Railway variables on service ${serviceId}:`);
        for (const [key, value] of Object.entries(variables)) {
            console.log(`[DRY RUN]   ${key}=${value.substring(0, 20)}...`);
        }
        return;
    }

    const mutation = `
    mutation VariableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;

    for (const [name, value] of Object.entries(variables)) {
        console.log(`[railway] Setting variable: ${name}`);

        try {
            await railwayGraphQL(mutation, {
                input: { projectId, serviceId, environmentId, name, value },
            });
        } catch (err: any) {
            console.warn(`[railway] Warning: Failed to set ${name}: ${err.message}`);
        }
    }

    console.log(`[railway] Variables configured`);
}
