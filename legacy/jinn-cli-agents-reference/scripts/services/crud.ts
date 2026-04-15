#!/usr/bin/env tsx
/**
 * Services CRUD operations
 * Usage: yarn tsx scripts/services/crud.ts <action> [options]
 * Actions: create, get, list, update, delete
 */

import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateServiceArgs {
  ventureId: string;
  name: string;
  slug?: string;
  description?: string;
  repositoryUrl?: string;
}

export interface UpdateServiceArgs {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  repositoryUrl?: string;
}

export interface Service {
  id: string;
  venture_id: string;
  name: string;
  slug: string;
  description: string | null;
  repository_url: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Exported Functions (for MCP tool usage)
// ============================================================================

/**
 * Generate a URL-friendly slug from a name
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Create a new service
 */
export async function createService(args: CreateServiceArgs): Promise<Service> {
  const slug = args.slug || generateSlug(args.name);

  const record = {
    venture_id: args.ventureId,
    name: args.name,
    slug,
    description: args.description || null,
    repository_url: args.repositoryUrl || null,
  };

  const { data, error } = await supabase
    .from('services')
    .insert(record)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create service: ${error.message}`);
  }

  return data as Service;
}

/**
 * Get a service by ID
 */
export async function getService(id: string): Promise<Service | null> {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get service: ${error.message}`);
  }

  return data as Service;
}

/**
 * Get a service by venture ID and slug
 */
export async function getServiceBySlug(ventureId: string, slug: string): Promise<Service | null> {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('venture_id', ventureId)
    .eq('slug', slug)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get service by slug: ${error.message}`);
  }

  return data as Service;
}

/**
 * List services with optional filters
 */
export async function listServices(options: {
  ventureId?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Service[]> {
  let query = supabase
    .from('services')
    .select('*')
    .order('created_at', { ascending: false });

  if (options.ventureId) {
    query = query.eq('venture_id', options.ventureId);
  }
  if (options.search) {
    query = query.or(`name.ilike.%${options.search}%,description.ilike.%${options.search}%`);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list services: ${error.message}`);
  }

  return data as Service[];
}

/**
 * Update a service
 */
export async function updateService(args: UpdateServiceArgs): Promise<Service> {
  const { id, ...updates } = args;

  const record: Record<string, any> = {};
  if (updates.name !== undefined) record.name = updates.name;
  if (updates.slug !== undefined) record.slug = updates.slug;
  if (updates.description !== undefined) record.description = updates.description;
  if (updates.repositoryUrl !== undefined) record.repository_url = updates.repositoryUrl;

  if (Object.keys(record).length === 0) {
    throw new Error('No fields to update');
  }

  const { data, error } = await supabase
    .from('services')
    .update(record)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update service: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Service not found: ${id}`);
  }

  return data as Service;
}

/**
 * Delete a service
 */
export async function deleteService(id: string): Promise<void> {
  const { error } = await supabase
    .from('services')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete service: ${error.message}`);
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/services/crud.ts <action> [options]

Actions:
  create    Create a new service
  get       Get a service by ID
  list      List services with optional filters
  update    Update a service
  delete    Delete a service

Create options:
  --ventureId <uuid>         Venture ID (required)
  --name <name>              Service name (required)
  --slug <slug>              URL-friendly slug
  --description <text>       Service description
  --repositoryUrl <url>      Git repository URL

Get options:
  --id <uuid>                Service ID

List options:
  --ventureId <uuid>         Filter by venture
  --search <query>           Search in name/description
  --limit <n>                Limit results
  --offset <n>               Offset for pagination

Update options:
  --id <uuid>                Service ID (required)
  (same as create options for fields to update)

Delete options:
  --id <uuid>                Service ID (required)

Examples:
  yarn tsx scripts/services/crud.ts create \\
    --ventureId "123..." --name "My Service"

  yarn tsx scripts/services/crud.ts list --ventureId "123..."

  yarn tsx scripts/services/crud.ts update --id "456..." --description "Updated description"
`);
}

function parseCreateArgs(args: string[]): CreateServiceArgs {
  const result: Partial<CreateServiceArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--ventureId':
        result.ventureId = next;
        i++;
        break;
      case '--name':
        result.name = next;
        i++;
        break;
      case '--slug':
        result.slug = next;
        i++;
        break;
      case '--description':
        result.description = next;
        i++;
        break;
      case '--repositoryUrl':
        result.repositoryUrl = next;
        i++;
        break;
    }
  }

  if (!result.ventureId || !result.name) {
    console.error('Error: --ventureId and --name are required');
    process.exit(1);
  }

  return result as CreateServiceArgs;
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
        const service = await createService(createArgs);
        console.log(JSON.stringify({ ok: true, data: service }, null, 2));
        break;
      }
      case 'get': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for get action');
          process.exit(1);
        }
        const service = await getService(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, data: service }, null, 2));
        break;
      }
      case 'list': {
        const options: Parameters<typeof listServices>[0] = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--ventureId': options.ventureId = next; i++; break;
            case '--search': options.search = next; i++; break;
            case '--limit': options.limit = parseInt(next, 10); i++; break;
            case '--offset': options.offset = parseInt(next, 10); i++; break;
          }
        }
        const services = await listServices(options);
        console.log(JSON.stringify({ ok: true, data: services }, null, 2));
        break;
      }
      case 'update': {
        const updateArgs: Partial<UpdateServiceArgs> = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--id': updateArgs.id = next; i++; break;
            case '--name': updateArgs.name = next; i++; break;
            case '--slug': updateArgs.slug = next; i++; break;
            case '--description': updateArgs.description = next; i++; break;
            case '--repositoryUrl': updateArgs.repositoryUrl = next; i++; break;
          }
        }
        if (!updateArgs.id) {
          console.error('Error: --id is required for update action');
          process.exit(1);
        }
        const service = await updateService(updateArgs as UpdateServiceArgs);
        console.log(JSON.stringify({ ok: true, data: service }, null, 2));
        break;
      }
      case 'delete': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for delete action');
          process.exit(1);
        }
        await deleteService(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, message: 'Service deleted' }));
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
