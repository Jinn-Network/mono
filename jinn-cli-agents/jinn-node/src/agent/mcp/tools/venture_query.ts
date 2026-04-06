import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { getSupabase } from './shared/supabase.js';

/**
 * Input schema for querying ventures.
 */
export const ventureQueryParams = z.object({
  mode: z.enum(['get', 'list', 'by_slug', 'by_workstream']).default('list').describe('Query mode'),
  id: z.string().uuid().optional().describe('Venture ID (for get mode)'),
  slug: z.string().optional().describe('Venture slug (for by_slug mode)'),
  workstreamId: z.string().optional().describe('Workstream ID (for by_workstream mode)'),
  status: z.enum(['active', 'paused', 'archived']).optional().describe('Filter by status'),
  limit: z.number().optional().default(20).describe('Maximum results (for list mode)'),
  offset: z.number().optional().default(0).describe('Offset for pagination'),
});

export type VentureQueryParams = z.infer<typeof ventureQueryParams>;

export const ventureQuerySchema = {
  description: `Query ventures from the registry. Returns all venture fields including token data (token_address, token_symbol, token_name, staking_contract_address, token_launch_platform, token_metadata, governance_address, pool_address) via select('*').

MODES:
- get: Retrieve a single venture by ID
- list: List all ventures with optional filters
- by_slug: Find a venture by its slug
- by_workstream: Find a venture by its root workstream ID

EXAMPLES:
1. Get by ID: { mode: "get", id: "<uuid>" }
2. List active: { mode: "list", status: "active" }
3. Find by slug: { mode: "by_slug", slug: "my-venture" }
4. Find by workstream: { mode: "by_workstream", workstreamId: "<workstream-id>" }

Returns: { venture } for single queries, { ventures, total } for list`,
  inputSchema: ventureQueryParams.shape,
};

/**
 * Query ventures from the database.
 * Delegates to the script functions which handle all Supabase operations.
 */
export async function ventureQuery(args: unknown) {
  try {
    const parsed = ventureQueryParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message }
          })
        }]
      };
    }

    const { mode, id, slug, workstreamId, status, limit, offset } = parsed.data;
    const supabase = await getSupabase();

    switch (mode) {
      case 'get': {
        if (!id) {
          return errorResponse('VALIDATION_ERROR', 'get mode requires id');
        }

        const { data: venture, error } = await supabase
          .from('ventures').select('*').eq('id', id).single();

        if (error) {
          if (error.code === 'PGRST116') return errorResponse('NOT_FOUND', `Venture not found: ${id}`);
          throw new Error(`Failed to get venture: ${error.message}`);
        }

        mcpLogger.info({ ventureId: id }, 'Retrieved venture by ID');
        return successResponse({ venture });
      }

      case 'by_slug': {
        if (!slug) {
          return errorResponse('VALIDATION_ERROR', 'by_slug mode requires slug');
        }

        const { data: venture, error } = await supabase
          .from('ventures').select('*').eq('slug', slug).single();

        if (error) {
          if (error.code === 'PGRST116') return errorResponse('NOT_FOUND', `Venture not found with slug: ${slug}`);
          throw new Error(`Failed to get venture by slug: ${error.message}`);
        }

        mcpLogger.info({ slug }, 'Retrieved venture by slug');
        return successResponse({ venture });
      }

      case 'by_workstream': {
        if (!workstreamId) {
          return errorResponse('VALIDATION_ERROR', 'by_workstream mode requires workstreamId');
        }

        const { data: venture, error } = await supabase
          .from('ventures').select('*').eq('root_workstream_id', workstreamId).limit(1).single();

        if (error) {
          if (error.code === 'PGRST116') return errorResponse('NOT_FOUND', `Venture not found for workstream: ${workstreamId}`);
          throw new Error(`Failed to get venture by workstream: ${error.message}`);
        }

        mcpLogger.info({ workstreamId }, 'Retrieved venture by workstream');
        return successResponse({ venture });
      }

      case 'list':
      default: {
        let query = supabase
          .from('ventures').select('*')
          .order('created_at', { ascending: false });

        if (status) query = query.eq('status', status);
        if (limit) query = query.limit(limit);
        if (offset) query = query.range(offset, offset + (limit || 20) - 1);

        const { data: ventures, error } = await query;

        if (error) throw new Error(`Failed to list ventures: ${error.message}`);

        mcpLogger.info({ count: ventures?.length ?? 0 }, 'Listed ventures');
        return successResponse({
          ventures: ventures ?? [],
          total: ventures?.length ?? 0,
        });
      }
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'venture_query failed');
    return errorResponse('EXECUTION_ERROR', message);
  }
}

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
