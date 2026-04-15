#!/usr/bin/env tsx
/**
 * Service Deployments CRUD operations
 * Usage: yarn tsx scripts/services/deployments.ts <action> [options]
 * Actions: create, get, list, update, delete
 */

import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

// ============================================================================
// Types
// ============================================================================

export type Environment = 'production' | 'staging' | 'development' | 'preview';
export type Provider = 'railway' | 'vercel' | 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'self-hosted' | 'other';
export type DeploymentStatus = 'active' | 'stopped' | 'failed' | 'deploying';
export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

export interface CreateDeploymentArgs {
  serviceId: string;
  environment: Environment;
  provider: Provider;
  providerProjectId?: string;
  providerServiceId?: string;
  url?: string;
  urls?: string[];
  version?: string;
  config?: object;
  healthCheckUrl?: string;
  status?: DeploymentStatus;
}

export interface UpdateDeploymentArgs {
  id: string;
  environment?: Environment;
  provider?: Provider;
  providerProjectId?: string;
  providerServiceId?: string;
  url?: string;
  urls?: string[];
  version?: string;
  config?: object;
  healthCheckUrl?: string;
  healthStatus?: HealthStatus;
  status?: DeploymentStatus;
}

export interface Deployment {
  id: string;
  service_id: string;
  environment: Environment;
  provider: Provider;
  provider_project_id: string | null;
  provider_service_id: string | null;
  url: string | null;
  urls: string[];
  version: string | null;
  config: object;
  health_check_url: string | null;
  last_health_check: string | null;
  health_status: HealthStatus;
  status: DeploymentStatus;
  deployed_at: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Exported Functions (for MCP tool usage)
// ============================================================================

/**
 * Create a new deployment
 */
export async function createDeployment(args: CreateDeploymentArgs): Promise<Deployment> {
  const record = {
    service_id: args.serviceId,
    environment: args.environment,
    provider: args.provider,
    provider_project_id: args.providerProjectId || null,
    provider_service_id: args.providerServiceId || null,
    url: args.url || null,
    urls: args.urls || [],
    version: args.version || null,
    config: args.config || {},
    health_check_url: args.healthCheckUrl || null,
    status: args.status || 'active',
    deployed_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('deployments')
    .insert(record)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create deployment: ${error.message}`);
  }

  return data as Deployment;
}

/**
 * Get a deployment by ID
 */
export async function getDeployment(id: string): Promise<Deployment | null> {
  const { data, error } = await supabase
    .from('deployments')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get deployment: ${error.message}`);
  }

  return data as Deployment;
}

/**
 * List deployments with optional filters
 */
export async function listDeployments(options: {
  serviceId?: string;
  environment?: Environment;
  provider?: Provider;
  status?: DeploymentStatus;
  healthStatus?: HealthStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<Deployment[]> {
  let query = supabase
    .from('deployments')
    .select('*')
    .order('deployed_at', { ascending: false });

  if (options.serviceId) {
    query = query.eq('service_id', options.serviceId);
  }
  if (options.environment) {
    query = query.eq('environment', options.environment);
  }
  if (options.provider) {
    query = query.eq('provider', options.provider);
  }
  if (options.status) {
    query = query.eq('status', options.status);
  }
  if (options.healthStatus) {
    query = query.eq('health_status', options.healthStatus);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list deployments: ${error.message}`);
  }

  return data as Deployment[];
}

/**
 * Update a deployment
 */
export async function updateDeployment(args: UpdateDeploymentArgs): Promise<Deployment> {
  const { id, ...updates } = args;

  const record: Record<string, any> = {};
  if (updates.environment !== undefined) record.environment = updates.environment;
  if (updates.provider !== undefined) record.provider = updates.provider;
  if (updates.providerProjectId !== undefined) record.provider_project_id = updates.providerProjectId;
  if (updates.providerServiceId !== undefined) record.provider_service_id = updates.providerServiceId;
  if (updates.url !== undefined) record.url = updates.url;
  if (updates.urls !== undefined) record.urls = updates.urls;
  if (updates.version !== undefined) record.version = updates.version;
  if (updates.config !== undefined) record.config = updates.config;
  if (updates.healthCheckUrl !== undefined) record.health_check_url = updates.healthCheckUrl;
  if (updates.healthStatus !== undefined) {
    record.health_status = updates.healthStatus;
    record.last_health_check = new Date().toISOString();
  }
  if (updates.status !== undefined) record.status = updates.status;

  if (Object.keys(record).length === 0) {
    throw new Error('No fields to update');
  }

  const { data, error } = await supabase
    .from('deployments')
    .update(record)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update deployment: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Deployment not found: ${id}`);
  }

  return data as Deployment;
}

/**
 * Delete a deployment
 */
export async function deleteDeployment(id: string): Promise<void> {
  const { error } = await supabase
    .from('deployments')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete deployment: ${error.message}`);
  }
}

/**
 * Update health status for a deployment
 */
export async function updateHealthStatus(id: string, healthStatus: HealthStatus): Promise<Deployment> {
  return updateDeployment({ id, healthStatus });
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/services/deployments.ts <action> [options]

Actions:
  create    Create a new deployment
  get       Get a deployment by ID
  list      List deployments with optional filters
  update    Update a deployment
  delete    Delete a deployment

Create options:
  --serviceId <uuid>           Service ID (required)
  --environment <env>          Environment: production, staging, development, preview (required)
  --provider <provider>        Provider: railway, vercel, cloudflare, aws, gcp, azure, self-hosted, other (required)
  --providerProjectId <id>     Provider project ID
  --providerServiceId <id>     Provider service ID
  --url <url>                  Primary deployment URL
  --urls <url1,url2>           Comma-separated URLs
  --version <version>          Deployed version
  --config <json>              Config as JSON
  --healthCheckUrl <url>       Health check endpoint
  --status <status>            Status: active, stopped, failed, deploying

Get options:
  --id <uuid>                  Deployment ID

List options:
  --serviceId <uuid>           Filter by service
  --environment <env>          Filter by environment
  --provider <provider>        Filter by provider
  --status <status>            Filter by status
  --healthStatus <status>      Filter by health: healthy, unhealthy, degraded, unknown
  --limit <n>                  Limit results
  --offset <n>                 Offset for pagination

Update options:
  --id <uuid>                  Deployment ID (required)
  (same as create options for fields to update)
  --healthStatus <status>      Update health status

Examples:
  yarn tsx scripts/services/deployments.ts create \\
    --serviceId "123..." --environment "production" --provider "railway" \\
    --url "https://my-app.railway.app"

  yarn tsx scripts/services/deployments.ts list --serviceId "123..." --status "active"
`);
}

function parseCreateArgs(args: string[]): CreateDeploymentArgs {
  const result: Partial<CreateDeploymentArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--serviceId': result.serviceId = next; i++; break;
      case '--environment': result.environment = next as Environment; i++; break;
      case '--provider': result.provider = next as Provider; i++; break;
      case '--providerProjectId': result.providerProjectId = next; i++; break;
      case '--providerServiceId': result.providerServiceId = next; i++; break;
      case '--url': result.url = next; i++; break;
      case '--urls': result.urls = next.split(',').map(u => u.trim()); i++; break;
      case '--version': result.version = next; i++; break;
      case '--config': result.config = JSON.parse(next); i++; break;
      case '--healthCheckUrl': result.healthCheckUrl = next; i++; break;
      case '--status': result.status = next as DeploymentStatus; i++; break;
    }
  }

  if (!result.serviceId || !result.environment || !result.provider) {
    console.error('Error: --serviceId, --environment, and --provider are required');
    process.exit(1);
  }

  return result as CreateDeploymentArgs;
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || action === '--help' || action === '-h') {
    printUsage();
    process.exit(0);
  }

  try {
    switch (action) {
      case 'create': {
        const createArgs = parseCreateArgs(args.slice(1));
        const deployment = await createDeployment(createArgs);
        console.log(JSON.stringify({ ok: true, data: deployment }, null, 2));
        break;
      }
      case 'get': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for get action');
          process.exit(1);
        }
        const deployment = await getDeployment(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, data: deployment }, null, 2));
        break;
      }
      case 'list': {
        const options: Parameters<typeof listDeployments>[0] = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--serviceId': options.serviceId = next; i++; break;
            case '--environment': options.environment = next as Environment; i++; break;
            case '--provider': options.provider = next as Provider; i++; break;
            case '--status': options.status = next as DeploymentStatus; i++; break;
            case '--healthStatus': options.healthStatus = next as HealthStatus; i++; break;
            case '--limit': options.limit = parseInt(next, 10); i++; break;
            case '--offset': options.offset = parseInt(next, 10); i++; break;
          }
        }
        const deployments = await listDeployments(options);
        console.log(JSON.stringify({ ok: true, data: deployments }, null, 2));
        break;
      }
      case 'update': {
        const updateArgs: Partial<UpdateDeploymentArgs> = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--id': updateArgs.id = next; i++; break;
            case '--environment': updateArgs.environment = next as Environment; i++; break;
            case '--provider': updateArgs.provider = next as Provider; i++; break;
            case '--providerProjectId': updateArgs.providerProjectId = next; i++; break;
            case '--providerServiceId': updateArgs.providerServiceId = next; i++; break;
            case '--url': updateArgs.url = next; i++; break;
            case '--urls': updateArgs.urls = next.split(',').map(u => u.trim()); i++; break;
            case '--version': updateArgs.version = next; i++; break;
            case '--config': updateArgs.config = JSON.parse(next); i++; break;
            case '--healthCheckUrl': updateArgs.healthCheckUrl = next; i++; break;
            case '--healthStatus': updateArgs.healthStatus = next as HealthStatus; i++; break;
            case '--status': updateArgs.status = next as DeploymentStatus; i++; break;
          }
        }
        if (!updateArgs.id) {
          console.error('Error: --id is required for update action');
          process.exit(1);
        }
        const deployment = await updateDeployment(updateArgs as UpdateDeploymentArgs);
        console.log(JSON.stringify({ ok: true, data: deployment }, null, 2));
        break;
      }
      case 'delete': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for delete action');
          process.exit(1);
        }
        await deleteDeployment(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, message: 'Deployment deleted' }));
        break;
      }
      default:
        console.error(`Unknown action: ${action}`);
        printUsage();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
