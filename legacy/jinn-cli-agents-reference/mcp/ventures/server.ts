#!/usr/bin/env npx tsx
/**
 * Ventures MCP Server
 *
 * Exposes ventures CRUD operations as MCP tools.
 * This server wraps the local script functions from scripts/ventures/*.ts
 *
 * Usage:
 *   npx tsx mcp/ventures/server.ts
 *
 * MCP Tools Exposed:
 *   - venture_create: Create a new venture
 *   - venture_get: Get a venture by ID or slug
 *   - venture_list: List ventures with filters
 *   - venture_update: Update venture fields
 *   - venture_delete: Delete or archive a venture
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Import venture functions from jinn-node package
import {
  createVenture,
  getVenture,
  getVentureBySlug,
  listVentures,
  updateVenture,
  archiveVenture,
  deleteVenture,
  type CreateVentureArgs,
  type UpdateVentureArgs,
  type Venture,
} from 'jinn-node/data/ventures.js';

// ============================================================================
// Tool Schemas
// ============================================================================

const ventureCreateParams = z.object({
  name: z.string().min(1).describe('Venture name'),
  slug: z.string().optional().describe('URL-friendly slug (auto-generated if not provided)'),
  description: z.string().optional().describe('Venture description'),
  ownerAddress: z.string().min(1).describe('Ethereum address of the venture owner'),
  blueprint: z.string().describe('Blueprint JSON string with invariants array'),
  rootWorkstreamId: z.string().optional().describe('Workstream ID for the venture'),
  rootJobInstanceId: z.string().optional().describe('Optional root job instance ID'),
  status: z.enum(['active', 'paused', 'archived']).optional().describe('Venture status'),
});

const ventureCreateSchema = {
  description: `Create a new venture in the registry.

A venture is a project entity that owns workstreams and services. Each venture has:
- A blueprint containing invariants (success criteria)
- An owner address (Ethereum address)
- Optional workstream and job instance associations

Parameters:
- name (required): Venture display name
- ownerAddress (required): Ethereum address of the owner
- blueprint (required): JSON string with invariants array, e.g. {"invariants":[{"id":"INV-001","description":"..."}]}
- slug: URL-friendly identifier (auto-generated from name if not provided)
- description: Venture description
- rootWorkstreamId: Associated workstream UUID
- rootJobInstanceId: Associated root job instance UUID
- status: 'active', 'paused', or 'archived' (default: active)

Returns the created venture object with id, timestamps, and all fields.`,
  inputSchema: ventureCreateParams.shape,
};

const ventureGetParams = z.object({
  id: z.string().uuid().optional().describe('Venture UUID'),
  slug: z.string().optional().describe('Venture slug'),
});

const ventureGetSchema = {
  description: `Get a venture by ID or slug.

Use this to retrieve full details of a specific venture including its blueprint,
status, timestamps, and all associated metadata.

Parameters:
- id: Venture UUID (use this OR slug, not both)
- slug: Venture slug (use this OR id, not both)

Returns the venture object or null if not found.`,
  inputSchema: ventureGetParams.shape,
};

const ventureListParams = z.object({
  status: z.enum(['active', 'paused', 'archived']).optional().describe('Filter by status'),
  ownerAddress: z.string().optional().describe('Filter by owner address'),
  limit: z.number().optional().describe('Maximum results'),
  offset: z.number().optional().describe('Pagination offset'),
});

const ventureListSchema = {
  description: `List ventures with optional filters.

Use this to discover ventures or get a filtered list.

Parameters:
- status: Filter by status ('active', 'paused', 'archived')
- ownerAddress: Filter by owner Ethereum address
- limit: Maximum results (default: 50)
- offset: Pagination offset

Returns array of venture objects sorted by created_at descending.`,
  inputSchema: ventureListParams.shape,
};

const ventureUpdateParams = z.object({
  id: z.string().uuid().describe('Venture ID to update'),
  name: z.string().min(1).optional().describe('New venture name'),
  slug: z.string().optional().describe('New URL-friendly slug'),
  description: z.string().optional().describe('New venture description'),
  blueprint: z.string().optional().describe('New blueprint JSON string with invariants array'),
  rootWorkstreamId: z.string().nullable().optional().describe('New workstream ID'),
  rootJobInstanceId: z.string().nullable().optional().describe('New root job instance ID'),
  status: z.enum(['active', 'paused', 'archived']).optional().describe('Venture status'),
});

const ventureUpdateSchema = {
  description: `Update an existing venture's properties.

Updates any combination of venture fields. Only provided fields are modified.
The blueprint field, if provided, must be a valid JSON string containing an invariants array.

Parameters:
- id (required): Venture UUID to update
- name: New venture name
- slug: New URL-friendly identifier
- description: New venture description
- blueprint: New JSON string with invariants array
- rootWorkstreamId: Associated workstream ID (use null to clear)
- rootJobInstanceId: Associated root job instance ID (use null to clear)
- status: 'active', 'paused', or 'archived'

Returns the updated venture object.`,
  inputSchema: ventureUpdateParams.shape,
};

const ventureDeleteParams = z.object({
  id: z.string().uuid().describe('Venture ID to delete'),
  mode: z.enum(['soft', 'hard']).optional().default('soft').describe('Delete mode'),
  confirm: z.boolean().optional().describe('Required for hard delete'),
});

const ventureDeleteSchema = {
  description: `Delete or archive a venture.

Modes:
- soft (default): Sets status to 'archived' - venture can be restored later
- hard: Permanently deletes the venture - CANNOT BE UNDONE

Hard delete requires confirm: true as a safety measure.
Prefer soft delete for most cases.

Parameters:
- id (required): Venture UUID to delete
- mode: 'soft' (archive) or 'hard' (permanent) - default: soft
- confirm: Must be true for hard delete

Returns success status.`,
  inputSchema: ventureDeleteParams.shape,
};

// ============================================================================
// Tool Handlers
// ============================================================================

function formatResponse(data: unknown, ok: boolean = true, error?: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(ok ? { ok: true, data } : { ok: false, error }),
    }],
  };
}

async function handleVentureCreate(params: z.infer<typeof ventureCreateParams>) {
  try {
    const args: CreateVentureArgs = {
      name: params.name,
      slug: params.slug,
      description: params.description,
      ownerAddress: params.ownerAddress,
      blueprint: params.blueprint,
      rootWorkstreamId: params.rootWorkstreamId,
      rootJobInstanceId: params.rootJobInstanceId,
      status: params.status,
    };
    const venture = await createVenture(args);
    return formatResponse({ venture });
  } catch (error) {
    return formatResponse(null, false, error instanceof Error ? error.message : String(error));
  }
}

async function handleVentureGet(params: z.infer<typeof ventureGetParams>) {
  try {
    if (!params.id && !params.slug) {
      return formatResponse(null, false, 'Either id or slug is required');
    }

    let venture: Venture | null = null;
    if (params.id) {
      venture = await getVenture(params.id);
    } else if (params.slug) {
      venture = await getVentureBySlug(params.slug);
    }

    if (!venture) {
      return formatResponse(null, false, 'Venture not found');
    }

    return formatResponse({ venture });
  } catch (error) {
    return formatResponse(null, false, error instanceof Error ? error.message : String(error));
  }
}

async function handleVentureList(params: z.infer<typeof ventureListParams>) {
  try {
    const ventures = await listVentures({
      status: params.status,
      ownerAddress: params.ownerAddress,
      limit: params.limit,
      offset: params.offset,
    });
    return formatResponse({ ventures, count: ventures.length });
  } catch (error) {
    return formatResponse(null, false, error instanceof Error ? error.message : String(error));
  }
}

async function handleVentureUpdate(params: z.infer<typeof ventureUpdateParams>) {
  try {
    const args: UpdateVentureArgs = {
      id: params.id,
      name: params.name,
      slug: params.slug,
      description: params.description,
      blueprint: params.blueprint,
      rootWorkstreamId: params.rootWorkstreamId,
      rootJobInstanceId: params.rootJobInstanceId,
      status: params.status,
    };
    const venture = await updateVenture(args);
    return formatResponse({ venture });
  } catch (error) {
    return formatResponse(null, false, error instanceof Error ? error.message : String(error));
  }
}

async function handleVentureDelete(params: z.infer<typeof ventureDeleteParams>) {
  try {
    if (params.mode === 'hard') {
      if (!params.confirm) {
        return formatResponse(null, false, 'Hard delete requires confirm: true');
      }
      await deleteVenture(params.id);
      return formatResponse({ deleted: true, mode: 'hard' });
    } else {
      const venture = await archiveVenture(params.id);
      return formatResponse({ venture, mode: 'soft' });
    }
  } catch (error) {
    return formatResponse(null, false, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// Server Setup
// ============================================================================

async function main() {
  const server = new McpServer({
    name: 'ventures-mcp',
    version: '1.0.0',
  });

  // Register tools
  server.registerTool('venture_create', ventureCreateSchema, handleVentureCreate);
  server.registerTool('venture_get', ventureGetSchema, handleVentureGet);
  server.registerTool('venture_list', ventureListSchema, handleVentureList);
  server.registerTool('venture_update', ventureUpdateSchema, handleVentureUpdate);
  server.registerTool('venture_delete', ventureDeleteSchema, handleVentureDelete);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Ventures MCP server started');
}

main().catch((error) => {
  console.error('Failed to start Ventures MCP server:', error);
  process.exit(1);
});
