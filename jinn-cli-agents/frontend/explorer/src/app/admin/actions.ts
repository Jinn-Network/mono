'use server';

import { revalidatePath } from 'next/cache';

// ============================================================================
// Supabase REST helper
// ============================================================================
// TODO: Migrate to shared @jinn/ventures-client package to use same code as
// MCP tools and CLI scripts. See docs/planning/VSR-VERIFICATION.md Section 7.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

type HttpMethod = 'POST' | 'PATCH' | 'DELETE';

interface MutationResult<T> {
  data?: T;
  error?: string;
}

async function supabaseMutate<T>(
  table: string,
  method: HttpMethod,
  data?: object,
  id?: string
): Promise<MutationResult<T>> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { error: 'Supabase not configured' };
  }

  const url = id
    ? `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`
    : `${SUPABASE_URL}/rest/v1/${table}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase ${method} failed:`, response.status, errorText);
      return { error: `Database error: ${response.status}` };
    }

    if (method === 'DELETE') {
      return { data: undefined as T };
    }

    const result = await response.json();
    return { data: Array.isArray(result) ? result[0] : result };
  } catch (e) {
    console.error(`Supabase ${method} error:`, e);
    return { error: 'Network error' };
  }
}

// ============================================================================
// VENTURES
// ============================================================================

export interface VentureInput {
  name: string;
  slug: string;
  description?: string;
  owner_address: string;
  blueprint: Record<string, unknown>;
  root_workstream_id?: string;
  root_job_instance_id?: string;
  status?: 'active' | 'paused' | 'archived';
}

export async function createVenture(input: VentureInput): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('ventures', 'POST', {
    ...input,
    status: input.status || 'active',
  });

  if (result.data) {
    revalidatePath('/admin/ventures');
    revalidatePath('/ventures');
  }

  return result;
}

export async function updateVenture(id: string, input: Partial<VentureInput>): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('ventures', 'PATCH', input, id);

  if (result.data) {
    revalidatePath('/admin/ventures');
    revalidatePath(`/admin/ventures/${id}`);
    revalidatePath('/ventures');
    revalidatePath(`/ventures/${id}`);
  }

  return result;
}

export async function deleteVenture(id: string): Promise<MutationResult<void>> {
  const result = await supabaseMutate<void>('ventures', 'DELETE', undefined, id);

  if (!result.error) {
    revalidatePath('/admin/ventures');
    revalidatePath('/ventures');
  }

  return result;
}

// ============================================================================
// SERVICES
// ============================================================================

export interface ServiceInput {
  venture_id: string;
  name: string;
  slug: string;
  description?: string;
  repository_url?: string;
}

export async function createService(input: ServiceInput): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('services', 'POST', input);

  if (result.data) {
    revalidatePath('/admin/services');
    revalidatePath('/services');
  }

  return result;
}

export async function updateService(id: string, input: Partial<ServiceInput>): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('services', 'PATCH', input, id);

  if (result.data) {
    revalidatePath('/admin/services');
    revalidatePath(`/admin/services/${id}`);
    revalidatePath('/services');
    revalidatePath(`/services/${id}`);
  }

  return result;
}

export async function deleteService(id: string): Promise<MutationResult<void>> {
  const result = await supabaseMutate<void>('services', 'DELETE', undefined, id);

  if (!result.error) {
    revalidatePath('/admin/services');
    revalidatePath('/services');
  }

  return result;
}

// ============================================================================
// DEPLOYMENTS
// ============================================================================

export interface DeploymentInput {
  service_id: string;
  environment: 'production' | 'staging' | 'development' | 'preview';
  provider: 'railway' | 'vercel' | 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'self-hosted' | 'other';
  provider_project_id?: string;
  provider_service_id?: string;
  url?: string;
  urls?: string[];
  version?: string;
  config?: Record<string, unknown>;
  health_check_url?: string;
  status?: 'active' | 'stopped' | 'failed' | 'deploying';
}

export async function createDeployment(input: DeploymentInput): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('deployments', 'POST', {
    ...input,
    urls: input.urls || [],
    config: input.config || {},
    status: input.status || 'active',
    deployed_at: new Date().toISOString(),
  });

  if (result.data) {
    revalidatePath(`/admin/services/${input.service_id}`);
    revalidatePath(`/services/${input.service_id}`);
  }

  return result;
}

export async function updateDeployment(id: string, serviceId: string, input: Partial<DeploymentInput>): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('deployments', 'PATCH', input, id);

  if (result.data) {
    revalidatePath(`/admin/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}`);
  }

  return result;
}

export async function deleteDeployment(id: string, serviceId: string): Promise<MutationResult<void>> {
  const result = await supabaseMutate<void>('deployments', 'DELETE', undefined, id);

  if (!result.error) {
    revalidatePath(`/admin/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}`);
  }

  return result;
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface InterfaceInput {
  service_id: string;
  name: string;
  interface_type: 'mcp_tool' | 'rest_endpoint' | 'graphql' | 'grpc' | 'websocket' | 'webhook' | 'other';
  description?: string;
  mcp_schema?: Record<string, unknown>;
  http_method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  http_path?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  auth_required?: boolean;
  auth_type?: 'bearer' | 'api_key' | 'oauth' | 'x402' | 'none';
  rate_limit?: Record<string, unknown>;
  x402_price?: number;
  config?: Record<string, unknown>;
  tags?: string[];
  status?: 'active' | 'deprecated' | 'removed';
}

export async function createInterface(input: InterfaceInput): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('interfaces', 'POST', {
    ...input,
    config: input.config || {},
    tags: input.tags || [],
    auth_required: input.auth_required ?? false,
    x402_price: input.x402_price ?? 0,
    status: input.status || 'active',
  });

  if (result.data) {
    revalidatePath(`/admin/services/${input.service_id}`);
    revalidatePath(`/services/${input.service_id}`);
  }

  return result;
}

export async function updateInterface(id: string, serviceId: string, input: Partial<InterfaceInput>): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('interfaces', 'PATCH', input, id);

  if (result.data) {
    revalidatePath(`/admin/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}`);
  }

  return result;
}

export async function deleteInterface(id: string, serviceId: string): Promise<MutationResult<void>> {
  const result = await supabaseMutate<void>('interfaces', 'DELETE', undefined, id);

  if (!result.error) {
    revalidatePath(`/admin/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}`);
  }

  return result;
}

// ============================================================================
// SERVICE DOCS
// ============================================================================

export interface ServiceDocInput {
  service_id: string;
  title: string;
  slug: string;
  doc_type: 'readme' | 'guide' | 'reference' | 'tutorial' | 'changelog' | 'api' | 'architecture' | 'runbook' | 'other';
  content: string;
  content_format?: 'markdown' | 'html' | 'plaintext';
  parent_id?: string;
  sort_order?: number;
  author?: string;
  version?: string;
  external_url?: string;
  config?: Record<string, unknown>;
  tags?: string[];
  status?: 'draft' | 'published' | 'archived';
}

export async function createServiceDoc(input: ServiceDocInput): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('service_docs', 'POST', {
    ...input,
    content_format: input.content_format || 'markdown',
    sort_order: input.sort_order ?? 0,
    config: input.config || {},
    tags: input.tags || [],
    status: input.status || 'draft',
  });

  if (result.data) {
    revalidatePath(`/admin/services/${input.service_id}`);
    revalidatePath(`/services/${input.service_id}`);
  }

  return result;
}

export async function updateServiceDoc(id: string, serviceId: string, input: Partial<ServiceDocInput>): Promise<MutationResult<{ id: string }>> {
  const result = await supabaseMutate<{ id: string }>('service_docs', 'PATCH', input, id);

  if (result.data) {
    revalidatePath(`/admin/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}`);
  }

  return result;
}

export async function deleteServiceDoc(id: string, serviceId: string): Promise<MutationResult<void>> {
  const result = await supabaseMutate<void>('service_docs', 'DELETE', undefined, id);

  if (!result.error) {
    revalidatePath(`/admin/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}`);
  }

  return result;
}
