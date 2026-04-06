#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Service Discovery operations
 * Usage: yarn tsx scripts/services/discovery.ts <action> [options]
 * Actions: search, by-venture, by-type, by-tag, full-text
 */

import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';
import type { Service, ServiceType, ServiceStatus } from './crud.js';
import type { Deployment, DeploymentStatus, HealthStatus, Environment, Provider } from './deployments.js';
import type { Interface, InterfaceType, AuthType, InterfaceStatus } from './interfaces.js';

// ============================================================================
// Types
// ============================================================================

export interface ServiceWithRelations extends Service {
  deployments?: Deployment[];
  interfaces?: Interface[];
  venture?: {
    id: string;
    name: string;
    slug: string;
  };
}

export interface SearchOptions {
  query?: string;
  ventureId?: string;
  ventureName?: string;
  serviceType?: ServiceType;
  status?: ServiceStatus;
  tags?: string[];
  language?: string;
  hasDeployment?: boolean;
  environment?: Environment;
  provider?: Provider;
  healthStatus?: HealthStatus;
  hasInterface?: boolean;
  interfaceType?: InterfaceType;
  authType?: AuthType;
  includeDeployments?: boolean;
  includeInterfaces?: boolean;
  includeVenture?: boolean;
  limit?: number;
  offset?: number;
}

export interface DiscoveryResult {
  services: ServiceWithRelations[];
  total: number;
  facets?: {
    types: Record<string, number>;
    languages: Record<string, number>;
    providers: Record<string, number>;
    tags: Record<string, number>;
  };
}

// ============================================================================
// Discovery Functions
// ============================================================================

/**
 * Full-featured service discovery with multiple filter options
 */
export async function discoverServices(options: SearchOptions = {}): Promise<DiscoveryResult> {
  let query = supabase
    .from('services')
    .select(`
      *,
      venture:ventures!services_venture_id_fkey(id, name, slug)
    `, { count: 'exact' })
    .order('created_at', { ascending: false });

  // Apply filters
  if (options.ventureId) {
    query = query.eq('venture_id', options.ventureId);
  }
  if (options.serviceType) {
    query = query.eq('service_type', options.serviceType);
  }
  if (options.status) {
    query = query.eq('status', options.status);
  }
  if (options.language) {
    query = query.eq('primary_language', options.language);
  }
  if (options.tags && options.tags.length > 0) {
    query = query.contains('tags', options.tags);
  }
  if (options.query) {
    query = query.or(`name.ilike.%${options.query}%,description.ilike.%${options.query}%`);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Discovery query failed: ${error.message}`);
  }

  let services = data as ServiceWithRelations[];

  // Filter by venture name if specified
  if (options.ventureName) {
    const pattern = options.ventureName.toLowerCase();
    services = services.filter(s =>
      s.venture?.name.toLowerCase().includes(pattern) ||
      s.venture?.slug.toLowerCase().includes(pattern)
    );
  }

  // Fetch deployments if needed
  if (options.includeDeployments || options.hasDeployment || options.environment || options.provider || options.healthStatus) {
    const serviceIds = services.map(s => s.id);
    if (serviceIds.length > 0) {
      let deployQuery = supabase
        .from('deployments')
        .select('*')
        .in('service_id', serviceIds);

      if (options.environment) {
        deployQuery = deployQuery.eq('environment', options.environment);
      }
      if (options.provider) {
        deployQuery = deployQuery.eq('provider', options.provider);
      }
      if (options.healthStatus) {
        deployQuery = deployQuery.eq('health_status', options.healthStatus);
      }

      const { data: deployments, error: depError } = await deployQuery;
      if (depError) {
        throw new Error(`Failed to fetch deployments: ${depError.message}`);
      }

      // Group deployments by service
      const deploymentsByService = new Map<string, Deployment[]>();
      for (const dep of deployments || []) {
        const existing = deploymentsByService.get(dep.service_id) || [];
        existing.push(dep as Deployment);
        deploymentsByService.set(dep.service_id, existing);
      }

      // Attach to services
      for (const service of services) {
        service.deployments = deploymentsByService.get(service.id) || [];
      }

      // Filter by hasDeployment
      if (options.hasDeployment !== undefined) {
        services = services.filter(s =>
          options.hasDeployment ? (s.deployments?.length ?? 0) > 0 : (s.deployments?.length ?? 0) === 0
        );
      }
    }
  }

  // Fetch interfaces if needed
  if (options.includeInterfaces || options.hasInterface || options.interfaceType || options.authType) {
    const serviceIds = services.map(s => s.id);
    if (serviceIds.length > 0) {
      let ifaceQuery = supabase
        .from('interfaces')
        .select('*')
        .in('service_id', serviceIds);

      if (options.interfaceType) {
        ifaceQuery = ifaceQuery.eq('interface_type', options.interfaceType);
      }
      if (options.authType) {
        ifaceQuery = ifaceQuery.eq('auth_type', options.authType);
      }

      const { data: interfaces, error: ifaceError } = await ifaceQuery;
      if (ifaceError) {
        throw new Error(`Failed to fetch interfaces: ${ifaceError.message}`);
      }

      // Group interfaces by service
      const interfacesByService = new Map<string, Interface[]>();
      for (const iface of interfaces || []) {
        const existing = interfacesByService.get(iface.service_id) || [];
        existing.push(iface as Interface);
        interfacesByService.set(iface.service_id, existing);
      }

      // Attach to services
      for (const service of services) {
        service.interfaces = interfacesByService.get(service.id) || [];
      }

      // Filter by hasInterface
      if (options.hasInterface !== undefined) {
        services = services.filter(s =>
          options.hasInterface ? (s.interfaces?.length ?? 0) > 0 : (s.interfaces?.length ?? 0) === 0
        );
      }
    }
  }

  return {
    services,
    total: count ?? services.length,
  };
}

/**
 * Search services by full-text query
 */
export async function searchByText(query: string, options: Omit<SearchOptions, 'query'> = {}): Promise<DiscoveryResult> {
  return discoverServices({ ...options, query });
}

/**
 * Find services by venture
 */
export async function findByVenture(ventureId: string, options: Omit<SearchOptions, 'ventureId'> = {}): Promise<DiscoveryResult> {
  return discoverServices({ ...options, ventureId, includeDeployments: true, includeInterfaces: true });
}

/**
 * Find services by type
 */
export async function findByType(serviceType: ServiceType, options: Omit<SearchOptions, 'serviceType'> = {}): Promise<DiscoveryResult> {
  return discoverServices({ ...options, serviceType });
}

/**
 * Find services by tags
 */
export async function findByTags(tags: string[], options: Omit<SearchOptions, 'tags'> = {}): Promise<DiscoveryResult> {
  return discoverServices({ ...options, tags });
}

/**
 * Find MCP tools across all services
 */
export async function findMcpTools(options: { serviceId?: string; search?: string; limit?: number } = {}): Promise<Interface[]> {
  let query = supabase
    .from('interfaces')
    .select('*, service:services!interfaces_service_id_fkey(id, name, slug, venture_id)')
    .eq('interface_type', 'mcp_tool')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (options.serviceId) {
    query = query.eq('service_id', options.serviceId);
  }
  if (options.search) {
    query = query.or(`name.ilike.%${options.search}%,description.ilike.%${options.search}%`);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to find MCP tools: ${error.message}`);
  }

  return data as Interface[];
}

/**
 * Find healthy deployments
 */
export async function findHealthyDeployments(options: { environment?: Environment; provider?: Provider; limit?: number } = {}): Promise<(Deployment & { service: Service })[]> {
  let query = supabase
    .from('deployments')
    .select('*, service:services!deployments_service_id_fkey(*)')
    .eq('health_status', 'healthy')
    .eq('status', 'active')
    .order('deployed_at', { ascending: false });

  if (options.environment) {
    query = query.eq('environment', options.environment);
  }
  if (options.provider) {
    query = query.eq('provider', options.provider);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to find healthy deployments: ${error.message}`);
  }

  return data as (Deployment & { service: Service })[];
}

/**
 * Get service with all relations
 */
export async function getServiceDetails(serviceId: string): Promise<ServiceWithRelations | null> {
  const { data: service, error } = await supabase
    .from('services')
    .select(`
      *,
      venture:ventures!services_venture_id_fkey(id, name, slug, owner_address, status)
    `)
    .eq('id', serviceId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get service: ${error.message}`);
  }

  const result = service as ServiceWithRelations;

  // Fetch deployments
  const { data: deployments } = await supabase
    .from('deployments')
    .select('*')
    .eq('service_id', serviceId)
    .order('deployed_at', { ascending: false });

  result.deployments = (deployments || []) as Deployment[];

  // Fetch interfaces
  const { data: interfaces } = await supabase
    .from('interfaces')
    .select('*')
    .eq('service_id', serviceId)
    .order('created_at', { ascending: false });

  result.interfaces = (interfaces || []) as Interface[];

  return result;
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/services/discovery.ts <action> [options]

Actions:
  search        General service discovery with filters
  by-venture    Find all services in a venture
  by-type       Find services by type
  by-tag        Find services with specific tags
  full-text     Full-text search in name/description
  mcp-tools     Find all MCP tool interfaces
  healthy       Find healthy deployments
  details       Get full service details

Search options:
  --query <text>               Full-text search
  --ventureId <uuid>           Filter by venture
  --ventureName <name>         Filter by venture name (partial match)
  --serviceType <type>         Filter by type: mcp, api, worker, frontend, library, other
  --status <status>            Filter by status: active, deprecated, archived
  --tags <tag1,tag2>           Filter by tags (all must match)
  --language <lang>            Filter by primary language
  --hasDeployment <true|false> Only services with/without deployments
  --environment <env>          Filter by deployment environment
  --provider <provider>        Filter by deployment provider
  --healthStatus <status>      Filter by health: healthy, unhealthy, degraded, unknown
  --hasInterface <true|false>  Only services with/without interfaces
  --interfaceType <type>       Filter by interface type
  --authType <type>            Filter by auth type
  --includeDeployments         Include deployment data
  --includeInterfaces          Include interface data
  --limit <n>                  Limit results
  --offset <n>                 Offset for pagination

Examples:
  yarn tsx scripts/services/discovery.ts search --serviceType "mcp" --status "active"

  yarn tsx scripts/services/discovery.ts by-venture --ventureId "123..."

  yarn tsx scripts/services/discovery.ts full-text --query "authentication"

  yarn tsx scripts/services/discovery.ts mcp-tools --search "create"

  yarn tsx scripts/services/discovery.ts healthy --environment "production"

  yarn tsx scripts/services/discovery.ts details --id "123..."
`);
}

function parseOptions(args: string[]): SearchOptions & { id?: string; search?: string } {
  const result: SearchOptions & { id?: string; search?: string } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--query': result.query = next; i++; break;
      case '--search': result.query = next; i++; break;
      case '--id': (result as any).id = next; i++; break;
      case '--ventureId': result.ventureId = next; i++; break;
      case '--ventureName': result.ventureName = next; i++; break;
      case '--serviceType': result.serviceType = next as ServiceType; i++; break;
      case '--status': result.status = next as ServiceStatus; i++; break;
      case '--tags': result.tags = next.split(',').map(t => t.trim()); i++; break;
      case '--language': result.language = next; i++; break;
      case '--hasDeployment': result.hasDeployment = next === 'true'; i++; break;
      case '--environment': result.environment = next as Environment; i++; break;
      case '--provider': result.provider = next as Provider; i++; break;
      case '--healthStatus': result.healthStatus = next as HealthStatus; i++; break;
      case '--hasInterface': result.hasInterface = next === 'true'; i++; break;
      case '--interfaceType': result.interfaceType = next as InterfaceType; i++; break;
      case '--authType': result.authType = next as AuthType; i++; break;
      case '--includeDeployments': result.includeDeployments = true; break;
      case '--includeInterfaces': result.includeInterfaces = true; break;
      case '--limit': result.limit = parseInt(next, 10); i++; break;
      case '--offset': result.offset = parseInt(next, 10); i++; break;
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || action === '--help' || action === '-h') {
    printUsage();
    process.exit(0);
  }

  const options = parseOptions(args.slice(1));

  try {
    switch (action) {
      case 'search': {
        const result = await discoverServices(options);
        console.log(JSON.stringify({ ok: true, data: result }, null, 2));
        break;
      }
      case 'by-venture': {
        if (!options.ventureId) {
          console.error('Error: --ventureId is required');
          process.exit(1);
        }
        const result = await findByVenture(options.ventureId, options);
        console.log(JSON.stringify({ ok: true, data: result }, null, 2));
        break;
      }
      case 'by-type': {
        if (!options.serviceType) {
          console.error('Error: --serviceType is required');
          process.exit(1);
        }
        const result = await findByType(options.serviceType, options);
        console.log(JSON.stringify({ ok: true, data: result }, null, 2));
        break;
      }
      case 'by-tag': {
        if (!options.tags || options.tags.length === 0) {
          console.error('Error: --tags is required');
          process.exit(1);
        }
        const result = await findByTags(options.tags, options);
        console.log(JSON.stringify({ ok: true, data: result }, null, 2));
        break;
      }
      case 'full-text': {
        if (!options.query) {
          console.error('Error: --query is required');
          process.exit(1);
        }
        const result = await searchByText(options.query, options);
        console.log(JSON.stringify({ ok: true, data: result }, null, 2));
        break;
      }
      case 'mcp-tools': {
        const tools = await findMcpTools({
          serviceId: options.ventureId,
          search: options.query,
          limit: options.limit,
        });
        console.log(JSON.stringify({ ok: true, data: { tools, count: tools.length } }, null, 2));
        break;
      }
      case 'healthy': {
        const deployments = await findHealthyDeployments({
          environment: options.environment,
          provider: options.provider,
          limit: options.limit,
        });
        console.log(JSON.stringify({ ok: true, data: { deployments, count: deployments.length } }, null, 2));
        break;
      }
      case 'details': {
        const id = (options as any).id;
        if (!id) {
          console.error('Error: --id is required');
          process.exit(1);
        }
        const service = await getServiceDetails(id);
        console.log(JSON.stringify({ ok: true, data: { service } }, null, 2));
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
