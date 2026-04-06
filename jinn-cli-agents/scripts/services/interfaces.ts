#!/usr/bin/env tsx
/**
 * Service Interfaces CRUD operations
 * Usage: yarn tsx scripts/services/interfaces.ts <action> [options]
 * Actions: create, get, list, update, delete
 */

import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

// ============================================================================
// Types
// ============================================================================

export type InterfaceType = 'mcp_tool' | 'rest_endpoint' | 'graphql' | 'grpc' | 'websocket' | 'webhook' | 'other';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export type AuthType = 'bearer' | 'api_key' | 'oauth' | 'x402' | 'none';
export type InterfaceStatus = 'active' | 'deprecated' | 'removed';

export interface CreateInterfaceArgs {
  serviceId: string;
  name: string;
  interfaceType: InterfaceType;
  description?: string;
  mcpSchema?: object;
  httpMethod?: HttpMethod;
  httpPath?: string;
  inputSchema?: object;
  outputSchema?: object;
  authRequired?: boolean;
  authType?: AuthType;
  rateLimit?: object;
  x402Price?: number;
  config?: object;
  tags?: string[];
  status?: InterfaceStatus;
}

export interface UpdateInterfaceArgs {
  id: string;
  name?: string;
  interfaceType?: InterfaceType;
  description?: string;
  mcpSchema?: object;
  httpMethod?: HttpMethod;
  httpPath?: string;
  inputSchema?: object;
  outputSchema?: object;
  authRequired?: boolean;
  authType?: AuthType;
  rateLimit?: object;
  x402Price?: number;
  config?: object;
  tags?: string[];
  status?: InterfaceStatus;
}

export interface Interface {
  id: string;
  service_id: string;
  name: string;
  interface_type: InterfaceType;
  description: string | null;
  mcp_schema: object | null;
  http_method: HttpMethod | null;
  http_path: string | null;
  input_schema: object | null;
  output_schema: object | null;
  auth_required: boolean;
  auth_type: AuthType | null;
  rate_limit: object | null;
  x402_price: number;
  config: object;
  tags: string[];
  status: InterfaceStatus;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Exported Functions (for MCP tool usage)
// ============================================================================

/**
 * Create a new interface
 */
export async function createInterface(args: CreateInterfaceArgs): Promise<Interface> {
  const record = {
    service_id: args.serviceId,
    name: args.name,
    interface_type: args.interfaceType,
    description: args.description || null,
    mcp_schema: args.mcpSchema || null,
    http_method: args.httpMethod || null,
    http_path: args.httpPath || null,
    input_schema: args.inputSchema || null,
    output_schema: args.outputSchema || null,
    auth_required: args.authRequired || false,
    auth_type: args.authType || null,
    rate_limit: args.rateLimit || null,
    x402_price: args.x402Price || 0,
    config: args.config || {},
    tags: args.tags || [],
    status: args.status || 'active',
  };

  const { data, error } = await supabase
    .from('interfaces')
    .insert(record)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create interface: ${error.message}`);
  }

  return data as Interface;
}

/**
 * Get an interface by ID
 */
export async function getInterface(id: string): Promise<Interface | null> {
  const { data, error } = await supabase
    .from('interfaces')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get interface: ${error.message}`);
  }

  return data as Interface;
}

/**
 * Get an interface by service ID and name
 */
export async function getInterfaceByName(serviceId: string, name: string): Promise<Interface | null> {
  const { data, error } = await supabase
    .from('interfaces')
    .select('*')
    .eq('service_id', serviceId)
    .eq('name', name)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get interface by name: ${error.message}`);
  }

  return data as Interface;
}

/**
 * List interfaces with optional filters
 */
export async function listInterfaces(options: {
  serviceId?: string;
  interfaceType?: InterfaceType;
  authType?: AuthType;
  status?: InterfaceStatus;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Interface[]> {
  let query = supabase
    .from('interfaces')
    .select('*')
    .order('created_at', { ascending: false });

  if (options.serviceId) {
    query = query.eq('service_id', options.serviceId);
  }
  if (options.interfaceType) {
    query = query.eq('interface_type', options.interfaceType);
  }
  if (options.authType) {
    query = query.eq('auth_type', options.authType);
  }
  if (options.status) {
    query = query.eq('status', options.status);
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
    throw new Error(`Failed to list interfaces: ${error.message}`);
  }

  return data as Interface[];
}

/**
 * Update an interface
 */
export async function updateInterface(args: UpdateInterfaceArgs): Promise<Interface> {
  const { id, ...updates } = args;

  const record: Record<string, any> = {};
  if (updates.name !== undefined) record.name = updates.name;
  if (updates.interfaceType !== undefined) record.interface_type = updates.interfaceType;
  if (updates.description !== undefined) record.description = updates.description;
  if (updates.mcpSchema !== undefined) record.mcp_schema = updates.mcpSchema;
  if (updates.httpMethod !== undefined) record.http_method = updates.httpMethod;
  if (updates.httpPath !== undefined) record.http_path = updates.httpPath;
  if (updates.inputSchema !== undefined) record.input_schema = updates.inputSchema;
  if (updates.outputSchema !== undefined) record.output_schema = updates.outputSchema;
  if (updates.authRequired !== undefined) record.auth_required = updates.authRequired;
  if (updates.authType !== undefined) record.auth_type = updates.authType;
  if (updates.rateLimit !== undefined) record.rate_limit = updates.rateLimit;
  if (updates.x402Price !== undefined) record.x402_price = updates.x402Price;
  if (updates.config !== undefined) record.config = updates.config;
  if (updates.tags !== undefined) record.tags = updates.tags;
  if (updates.status !== undefined) record.status = updates.status;

  if (Object.keys(record).length === 0) {
    throw new Error('No fields to update');
  }

  const { data, error } = await supabase
    .from('interfaces')
    .update(record)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update interface: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Interface not found: ${id}`);
  }

  return data as Interface;
}

/**
 * Delete an interface
 */
export async function deleteInterface(id: string): Promise<void> {
  const { error } = await supabase
    .from('interfaces')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete interface: ${error.message}`);
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/services/interfaces.ts <action> [options]

Actions:
  create    Create a new interface
  get       Get an interface by ID
  list      List interfaces with optional filters
  update    Update an interface
  delete    Delete an interface

Create options:
  --serviceId <uuid>           Service ID (required)
  --name <name>                Interface name (required)
  --interfaceType <type>       Type: mcp_tool, rest_endpoint, graphql, grpc, websocket, webhook, other (required)
  --description <text>         Interface description
  --mcpSchema <json>           MCP tool schema (for mcp_tool type)
  --httpMethod <method>        HTTP method: GET, POST, PUT, DELETE, PATCH
  --httpPath <path>            HTTP path pattern
  --inputSchema <json>         Input JSON Schema
  --outputSchema <json>        Output JSON Schema
  --authRequired <true|false>  Whether auth is required
  --authType <type>            Auth type: bearer, api_key, oauth, x402, none
  --rateLimit <json>           Rate limit config as JSON
  --x402Price <wei>            Price in wei for x402
  --config <json>              Config as JSON
  --tags <tag1,tag2>           Comma-separated tags
  --status <status>            Status: active, deprecated, removed

Get options:
  --id <uuid>                  Interface ID

List options:
  --serviceId <uuid>           Filter by service
  --interfaceType <type>       Filter by type
  --authType <type>            Filter by auth type
  --status <status>            Filter by status
  --search <query>             Search in name/description
  --limit <n>                  Limit results
  --offset <n>                 Offset for pagination

Examples:
  yarn tsx scripts/services/interfaces.ts create \\
    --serviceId "123..." --name "get_user" --interfaceType "mcp_tool" \\
    --mcpSchema '{"type":"object","properties":{"userId":{"type":"string"}}}'

  yarn tsx scripts/services/interfaces.ts list --serviceId "123..." --interfaceType "rest_endpoint"
`);
}

function parseCreateArgs(args: string[]): CreateInterfaceArgs {
  const result: Partial<CreateInterfaceArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--serviceId': result.serviceId = next; i++; break;
      case '--name': result.name = next; i++; break;
      case '--interfaceType': result.interfaceType = next as InterfaceType; i++; break;
      case '--description': result.description = next; i++; break;
      case '--mcpSchema': result.mcpSchema = JSON.parse(next); i++; break;
      case '--httpMethod': result.httpMethod = next as HttpMethod; i++; break;
      case '--httpPath': result.httpPath = next; i++; break;
      case '--inputSchema': result.inputSchema = JSON.parse(next); i++; break;
      case '--outputSchema': result.outputSchema = JSON.parse(next); i++; break;
      case '--authRequired': result.authRequired = next === 'true'; i++; break;
      case '--authType': result.authType = next as AuthType; i++; break;
      case '--rateLimit': result.rateLimit = JSON.parse(next); i++; break;
      case '--x402Price': result.x402Price = parseInt(next, 10); i++; break;
      case '--config': result.config = JSON.parse(next); i++; break;
      case '--tags': result.tags = next.split(',').map(t => t.trim()); i++; break;
      case '--status': result.status = next as InterfaceStatus; i++; break;
    }
  }

  if (!result.serviceId || !result.name || !result.interfaceType) {
    console.error('Error: --serviceId, --name, and --interfaceType are required');
    process.exit(1);
  }

  return result as CreateInterfaceArgs;
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
        const iface = await createInterface(createArgs);
        console.log(JSON.stringify({ ok: true, data: iface }, null, 2));
        break;
      }
      case 'get': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for get action');
          process.exit(1);
        }
        const iface = await getInterface(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, data: iface }, null, 2));
        break;
      }
      case 'list': {
        const options: Parameters<typeof listInterfaces>[0] = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--serviceId': options.serviceId = next; i++; break;
            case '--interfaceType': options.interfaceType = next as InterfaceType; i++; break;
            case '--authType': options.authType = next as AuthType; i++; break;
            case '--status': options.status = next as InterfaceStatus; i++; break;
            case '--search': options.search = next; i++; break;
            case '--limit': options.limit = parseInt(next, 10); i++; break;
            case '--offset': options.offset = parseInt(next, 10); i++; break;
          }
        }
        const interfaces = await listInterfaces(options);
        console.log(JSON.stringify({ ok: true, data: interfaces }, null, 2));
        break;
      }
      case 'update': {
        const updateArgs: Partial<UpdateInterfaceArgs> = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--id': updateArgs.id = next; i++; break;
            case '--name': updateArgs.name = next; i++; break;
            case '--interfaceType': updateArgs.interfaceType = next as InterfaceType; i++; break;
            case '--description': updateArgs.description = next; i++; break;
            case '--mcpSchema': updateArgs.mcpSchema = JSON.parse(next); i++; break;
            case '--httpMethod': updateArgs.httpMethod = next as HttpMethod; i++; break;
            case '--httpPath': updateArgs.httpPath = next; i++; break;
            case '--inputSchema': updateArgs.inputSchema = JSON.parse(next); i++; break;
            case '--outputSchema': updateArgs.outputSchema = JSON.parse(next); i++; break;
            case '--authRequired': updateArgs.authRequired = next === 'true'; i++; break;
            case '--authType': updateArgs.authType = next as AuthType; i++; break;
            case '--rateLimit': updateArgs.rateLimit = JSON.parse(next); i++; break;
            case '--x402Price': updateArgs.x402Price = parseInt(next, 10); i++; break;
            case '--config': updateArgs.config = JSON.parse(next); i++; break;
            case '--tags': updateArgs.tags = next.split(',').map(t => t.trim()); i++; break;
            case '--status': updateArgs.status = next as InterfaceStatus; i++; break;
          }
        }
        if (!updateArgs.id) {
          console.error('Error: --id is required for update action');
          process.exit(1);
        }
        const iface = await updateInterface(updateArgs as UpdateInterfaceArgs);
        console.log(JSON.stringify({ ok: true, data: iface }, null, 2));
        break;
      }
      case 'delete': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for delete action');
          process.exit(1);
        }
        await deleteInterface(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, message: 'Interface deleted' }));
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
