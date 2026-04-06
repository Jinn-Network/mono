// @ts-nocheck
/**
 * Railway API helper for blog provisioning
 * Creates Railway services linked to customer repos
 */

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

export interface RailwayServiceResult {
    serviceId: string;
    domain: string;
    projectId: string;
    environmentId: string;
}

/**
 * Create a Railway service for a customer blog
 */
export async function createRailwayService(
    customerSlug: string,
    repoUrl: string,
    options: { dryRun?: boolean } = {}
): Promise<RailwayServiceResult> {
    const serviceName = `blog-${customerSlug}`;
    const domain = `${serviceName}.up.railway.app`;

    if (options.dryRun) {
        console.log(`[DRY RUN] Would create Railway service: ${serviceName}`);
        console.log(`[DRY RUN] Linked to repo: ${repoUrl}`);
        console.log(`[DRY RUN] Domain: ${domain}`);
        return {
            serviceId: 'srv_dryrun',
            domain,
            projectId: 'proj_dryrun',
            environmentId: 'env_dryrun',
        };
    }

    const token = process.env.RAILWAY_API_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;

    if (!token) {
        throw new Error('RAILWAY_API_TOKEN environment variable is required');
    }
    if (!projectId) {
        throw new Error('RAILWAY_PROJECT_ID environment variable is required');
    }

    // Check if service already exists
    const listServicesQuery = `
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

    const listResponse = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            query: listServicesQuery,
            variables: { projectId },
        }),
    });

    const listResult = await listResponse.json();
    const services = listResult.data?.project?.services?.edges || [];
    const existingService = services.find((s: any) => s.node.name === serviceName);

    if (existingService) {
        console.log(`Railway service ${serviceName} already exists, using existing`);
        const serviceId = existingService.node.id;

        // Get the domain for the existing service
        const domainQuery = `
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

        const domainResponse = await fetch(RAILWAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                query: domainQuery,
                variables: { projectId, serviceId },
            }),
        });

        const domainResult = await domainResponse.json();
        const environments = domainResult.data?.project?.environments?.edges || [];
        const prodEnv = environments.find((e: any) => e.node.name === 'production') || environments[0];
        const existingDomain = prodEnv?.node?.serviceDomains?.[0]?.domain || domain;

        return {
            serviceId,
            domain: existingDomain,
            projectId,
        };
    }

    // Create service
    const createServiceMutation = `
    mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `;

    console.log(`Creating Railway service: ${serviceName}...`);

    const createResponse = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            query: createServiceMutation,
            variables: {
                input: {
                    projectId,
                    name: serviceName,
                    source: {
                        repo: repoUrl.replace('git@github.com:', '').replace('.git', ''),
                    },
                },
            },
        }),
    });

    const createResult = await createResponse.json();
    if (createResult.errors) {
        throw new Error(`Railway API error: ${JSON.stringify(createResult.errors)}`);
    }

    const serviceId = createResult.data?.serviceCreate?.id;
    if (!serviceId) {
        throw new Error('Failed to create Railway service - no ID returned');
    }

    console.log(`Railway service created: ${serviceId}`);

    // Get project's default environment
    const envQuery = `
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

    const envResponse = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            query: envQuery,
            variables: { projectId },
        }),
    });

    const envResult = await envResponse.json();
    const environments = envResult.data?.project?.environments?.edges || [];
    const productionEnv = environments.find((e: any) => e.node.name === 'production');
    const environmentId = productionEnv?.node?.id || environments[0]?.node?.id;

    // Generate domain
    const domainMutation = `
    mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        domain
      }
    }
  `;

    const domainResponse = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            query: domainMutation,
            variables: {
                input: {
                    serviceId,
                    environmentId,
                },
            },
        }),
    });

    const domainResult = await domainResponse.json();
    const generatedDomain = domainResult.data?.serviceDomainCreate?.domain || domain;

    console.log(`Railway domain: ${generatedDomain}`);

    // Trigger deployment
    if (environmentId) {
        console.log(`Triggering deployment...`);
        const deployMutation = `
      mutation ServiceInstanceDeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
      }
    `;

        const deployResponse = await fetch(RAILWAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                query: deployMutation,
                variables: {
                    serviceId,
                    environmentId,
                },
            }),
        });
        const deployResult = await deployResponse.json();
        if (deployResult.errors) {
            console.warn(`Deployment trigger warning: ${JSON.stringify(deployResult.errors)}`);
        } else {
            console.log(`Deployment triggered successfully`);
        }
    }

    return {
        serviceId,
        domain: generatedDomain,
        projectId,
        environmentId: environmentId || '',
    };
}

/**
 * Set environment variables on a Railway service
 */
export async function setRailwayServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>,
    options: { dryRun?: boolean } = {}
): Promise<void> {
    if (options.dryRun) {
        console.log(`[DRY RUN] Would set Railway variables on service ${serviceId}:`);
        for (const [key, value] of Object.entries(variables)) {
            console.log(`[DRY RUN]   ${key}=${value}`);
        }
        return;
    }

    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) {
        throw new Error('RAILWAY_API_TOKEN environment variable is required');
    }

    const upsertMutation = `
    mutation VariableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;

    for (const [name, value] of Object.entries(variables)) {
        console.log(`Setting Railway variable: ${name}...`);

        const response = await fetch(RAILWAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                query: upsertMutation,
                variables: {
                    input: {
                        projectId,
                        serviceId,
                        environmentId,
                        name,
                        value,
                    },
                },
            }),
        });

        const result = await response.json();
        if (result.errors) {
            console.warn(`Warning: Failed to set ${name}: ${JSON.stringify(result.errors)}`);
        }
    }

    console.log(`Railway variables configured successfully`);
}
