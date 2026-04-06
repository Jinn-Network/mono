import { z } from 'zod';
import { getSupabase } from './shared/supabase.js';
import { mcpLogger } from '../../../logging/index.js';

// ============================================================================
// Schema Definitions
// ============================================================================

const serviceTypeEnum = z.enum(['mcp', 'api', 'worker', 'frontend', 'library', 'other']);
const serviceStatusEnum = z.enum(['active', 'deprecated', 'archived']);
const environmentEnum = z.enum(['production', 'staging', 'development', 'preview']);
const providerEnum = z.enum(['railway', 'vercel', 'cloudflare', 'aws', 'gcp', 'azure', 'self-hosted', 'other']);
const healthStatusEnum = z.enum(['healthy', 'unhealthy', 'degraded', 'unknown']);
const interfaceTypeEnum = z.enum(['mcp_tool', 'rest_endpoint', 'graphql', 'grpc', 'websocket', 'webhook', 'other']);
const authTypeEnum = z.enum(['bearer', 'api_key', 'oauth', 'x402', 'none']);

export const searchServicesParams = z.object({
  // Search mode
  mode: z.enum([
    'discover',      // General service discovery
    'mcp_tools',     // Find MCP tool interfaces
    'healthy',       // Find healthy deployments
    'by_venture',    // Services in a venture
    'details',       // Full service details
  ]).default('discover').describe('Search mode'),

  // Target (for details/by_venture)
  id: z.string().uuid().optional().describe('Service or venture ID (for details/by_venture modes)'),

  // Text search
  query: z.string().optional().describe('Full-text search in name/description'),

  // Service filters
  ventureId: z.string().uuid().optional().describe('Filter by venture ID'),
  ventureName: z.string().optional().describe('Filter by venture name (partial match)'),
  serviceType: serviceTypeEnum.optional().describe('Filter by service type'),
  status: serviceStatusEnum.optional().describe('Filter by service status'),
  tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
  language: z.string().optional().describe('Filter by primary language'),

  // Deployment filters
  hasDeployment: z.boolean().optional().describe('Only services with/without deployments'),
  environment: environmentEnum.optional().describe('Filter by deployment environment'),
  provider: providerEnum.optional().describe('Filter by deployment provider'),
  healthStatus: healthStatusEnum.optional().describe('Filter by health status'),

  // Interface filters
  hasInterface: z.boolean().optional().describe('Only services with/without interfaces'),
  interfaceType: interfaceTypeEnum.optional().describe('Filter by interface type'),
  authType: authTypeEnum.optional().describe('Filter by auth type'),

  // Includes
  includeDeployments: z.boolean().optional().default(false).describe('Include deployment data'),
  includeInterfaces: z.boolean().optional().default(false).describe('Include interface data'),

  // Pagination
  limit: z.number().optional().default(20).describe('Maximum results to return'),
  offset: z.number().optional().default(0).describe('Offset for pagination'),
});

export type SearchServicesParams = z.infer<typeof searchServicesParams>;

export const searchServicesSchema = {
  description: `Search and discover services across the registry.

MODES:
- discover: General service discovery with filters
- mcp_tools: Find all registered MCP tool interfaces
- healthy: Find services with healthy production deployments
- by_venture: List all services belonging to a venture
- details: Get full service details including deployments and interfaces

EXAMPLES:
1. Find all MCP services: { mode: "discover", serviceType: "mcp" }
2. Find production deployments: { mode: "healthy", environment: "production" }
3. Search by name: { mode: "discover", query: "auth" }
4. Find MCP tools: { mode: "mcp_tools", query: "create" }
5. Get service details: { mode: "details", id: "<service-uuid>" }
6. List venture services: { mode: "by_venture", id: "<venture-uuid>" }

Returns: { services/tools/deployments/service, total?, meta }`,
  inputSchema: searchServicesParams.shape,
};

// ============================================================================
// Implementation
// ============================================================================

export async function searchServices(args: unknown) {
  try {
    const parsed = searchServicesParams.safeParse(args);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', parsed.error.message);
    }

    const params = parsed.data;

    switch (params.mode) {
      case 'discover':
        return await discoverServices(params);

      case 'mcp_tools':
        return await findMcpTools(params);

      case 'healthy':
        return await findHealthyDeployments(params);

      case 'by_venture':
        if (!params.id) {
          return errorResponse('VALIDATION_ERROR', 'by_venture mode requires id');
        }
        return await discoverServices({ ...params, ventureId: params.id, includeDeployments: true, includeInterfaces: true });

      case 'details':
        if (!params.id) {
          return errorResponse('VALIDATION_ERROR', 'details mode requires id');
        }
        return await getServiceDetails(params.id);

      default:
        return errorResponse('VALIDATION_ERROR', `Unknown mode: ${params.mode}`);
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'search_services failed');
    return errorResponse('EXECUTION_ERROR', message);
  }
}

// ============================================================================
// Core Functions
// ============================================================================

async function discoverServices(params: SearchServicesParams) {
  const supabase = await getSupabase();
  let query = supabase
    .from('services')
    .select(`
      *,
      venture:ventures!services_venture_id_fkey(id, name, slug)
    `, { count: 'exact' })
    .order('created_at', { ascending: false });

  // Apply filters
  if (params.ventureId) query = query.eq('venture_id', params.ventureId);
  if (params.serviceType) query = query.eq('service_type', params.serviceType);
  if (params.status) query = query.eq('status', params.status);
  if (params.language) query = query.eq('primary_language', params.language);
  if (params.tags && params.tags.length > 0) query = query.contains('tags', params.tags);
  if (params.query) {
    query = query.or(`name.ilike.%${params.query}%,description.ilike.%${params.query}%`);
  }
  if (params.limit) query = query.limit(params.limit);
  if (params.offset) query = query.range(params.offset, params.offset + (params.limit || 50) - 1);

  const { data, error, count } = await query;

  if (error) {
    return errorResponse('DATABASE_ERROR', error.message);
  }

  let services = data || [];

  // Filter by venture name if specified
  if (params.ventureName) {
    const pattern = params.ventureName.toLowerCase();
    services = services.filter((s: any) =>
      s.venture?.name?.toLowerCase().includes(pattern) ||
      s.venture?.slug?.toLowerCase().includes(pattern)
    );
  }

  // Fetch deployments if needed
  if (params.includeDeployments || params.hasDeployment !== undefined || params.environment || params.provider || params.healthStatus) {
    const serviceIds = services.map((s: any) => s.id);
    if (serviceIds.length > 0) {
      let depQuery = supabase.from('deployments').select('*').in('service_id', serviceIds);
      if (params.environment) depQuery = depQuery.eq('environment', params.environment);
      if (params.provider) depQuery = depQuery.eq('provider', params.provider);
      if (params.healthStatus) depQuery = depQuery.eq('health_status', params.healthStatus);

      const { data: deployments } = await depQuery;

      const deploymentsByService = new Map<string, any[]>();
      for (const dep of deployments || []) {
        const existing = deploymentsByService.get(dep.service_id) || [];
        existing.push(dep);
        deploymentsByService.set(dep.service_id, existing);
      }

      for (const service of services) {
        (service as any).deployments = deploymentsByService.get((service as any).id) || [];
      }

      if (params.hasDeployment !== undefined) {
        services = services.filter((s: any) =>
          params.hasDeployment ? (s.deployments?.length ?? 0) > 0 : (s.deployments?.length ?? 0) === 0
        );
      }
    }
  }

  // Fetch interfaces if needed
  if (params.includeInterfaces || params.hasInterface !== undefined || params.interfaceType || params.authType) {
    const serviceIds = services.map((s: any) => s.id);
    if (serviceIds.length > 0) {
      let ifaceQuery = supabase.from('interfaces').select('*').in('service_id', serviceIds);
      if (params.interfaceType) ifaceQuery = ifaceQuery.eq('interface_type', params.interfaceType);
      if (params.authType) ifaceQuery = ifaceQuery.eq('auth_type', params.authType);

      const { data: interfaces } = await ifaceQuery;

      const interfacesByService = new Map<string, any[]>();
      for (const iface of interfaces || []) {
        const existing = interfacesByService.get(iface.service_id) || [];
        existing.push(iface);
        interfacesByService.set(iface.service_id, existing);
      }

      for (const service of services) {
        (service as any).interfaces = interfacesByService.get((service as any).id) || [];
      }

      if (params.hasInterface !== undefined) {
        services = services.filter((s: any) =>
          params.hasInterface ? (s.interfaces?.length ?? 0) > 0 : (s.interfaces?.length ?? 0) === 0
        );
      }
    }
  }

  mcpLogger.info({ count: services.length, total: count }, 'Discovered services');

  return successResponse({
    services,
    total: count ?? services.length,
  });
}

async function findMcpTools(params: SearchServicesParams) {
  const supabase = await getSupabase();
  let query = supabase
    .from('interfaces')
    .select('*, service:services!interfaces_service_id_fkey(id, name, slug, venture_id)')
    .eq('interface_type', 'mcp_tool')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (params.ventureId) {
    // Need to filter after fetch since we're joining
    const { data: services } = await supabase
      .from('services')
      .select('id')
      .eq('venture_id', params.ventureId);
    const serviceIds = (services || []).map((s: any) => s.id);
    if (serviceIds.length > 0) {
      query = query.in('service_id', serviceIds);
    }
  }

  if (params.query) {
    query = query.or(`name.ilike.%${params.query}%,description.ilike.%${params.query}%`);
  }

  if (params.limit) query = query.limit(params.limit);

  const { data, error } = await query;

  if (error) {
    return errorResponse('DATABASE_ERROR', error.message);
  }

  mcpLogger.info({ count: (data || []).length }, 'Found MCP tools');

  return successResponse({
    tools: data || [],
    count: (data || []).length,
  });
}

async function findHealthyDeployments(params: SearchServicesParams) {
  const supabase = await getSupabase();
  let query = supabase
    .from('deployments')
    .select('*, service:services!deployments_service_id_fkey(*)')
    .eq('health_status', 'healthy')
    .eq('status', 'active')
    .order('deployed_at', { ascending: false });

  if (params.environment) query = query.eq('environment', params.environment);
  if (params.provider) query = query.eq('provider', params.provider);
  if (params.limit) query = query.limit(params.limit);

  const { data, error } = await query;

  if (error) {
    return errorResponse('DATABASE_ERROR', error.message);
  }

  mcpLogger.info({ count: (data || []).length }, 'Found healthy deployments');

  return successResponse({
    deployments: data || [],
    count: (data || []).length,
  });
}

async function getServiceDetails(serviceId: string) {
  const supabase = await getSupabase();
  const { data: service, error } = await supabase
    .from('services')
    .select(`
      *,
      venture:ventures!services_venture_id_fkey(id, name, slug, owner_address, status)
    `)
    .eq('id', serviceId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return errorResponse('NOT_FOUND', `Service not found: ${serviceId}`);
    }
    return errorResponse('DATABASE_ERROR', error.message);
  }

  // Fetch deployments
  const { data: deployments } = await supabase
    .from('deployments')
    .select('*')
    .eq('service_id', serviceId)
    .order('deployed_at', { ascending: false });

  // Fetch interfaces
  const { data: interfaces } = await supabase
    .from('interfaces')
    .select('*')
    .eq('service_id', serviceId)
    .order('created_at', { ascending: false });

  // Fetch docs
  const { data: docs } = await supabase
    .from('service_docs')
    .select('id, title, slug, doc_type, status')
    .eq('service_id', serviceId)
    .eq('status', 'published')
    .order('sort_order', { ascending: true });

  mcpLogger.info({ serviceId }, 'Retrieved service details');

  return successResponse({
    service: {
      ...service,
      deployments: deployments || [],
      interfaces: interfaces || [],
      docs: docs || [],
    },
  });
}

// ============================================================================
// Response Helpers
// ============================================================================

function successResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ data, meta: { ok: true } })
    }]
  };
}

function errorResponse(code: string, message: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ data: null, meta: { ok: false, code, message } })
    }]
  };
}
