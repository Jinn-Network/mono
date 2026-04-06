#!/usr/bin/env tsx
/**
 * Template CRUD operations
 * Usage: yarn tsx scripts/templates/crud.ts <command> [options]
 *
 * Commands:
 *   create  --name "My Template" --blueprint '{...}'
 *   get     --id <uuid>
 *   list    [--status draft|published|archived] [--limit 20]
 *   update  --id <uuid> [--name "New Name"] [--status published]
 *   archive --id <uuid>
 *   delete  --id <uuid> --confirm
 */

import "dotenv/config";
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ============================================================================
// Types
// ============================================================================

export interface Template {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  version: string;
  blueprint: object;
  input_schema: object;
  output_spec: object;
  enabled_tools: string[];
  tags: string[];
  price_wei: string | null;
  price_usd: string | null;
  safety_tier: string;
  default_cyclic: boolean;
  venture_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateArgs {
  name: string;
  slug?: string;
  description?: string;
  version?: string;
  blueprint: string | object;
  inputSchema?: object;
  outputSpec?: object;
  enabledTools?: string[];
  type?: 'venture' | 'agent';
  tags?: string[];
  priceWei?: string;
  priceUsd?: string;
  safetyTier?: 'public' | 'private' | 'restricted';
  defaultCyclic?: boolean;
  ventureId?: string;
  status?: 'draft' | 'published' | 'archived';
  type?: 'venture' | 'agent';
}

export interface UpdateTemplateArgs {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  version?: string;
  blueprint?: string | object;
  inputSchema?: object;
  outputSpec?: object;
  enabledTools?: string[];
  tags?: string[];
  priceWei?: string;
  type?: 'venture' | 'agent';
  priceUsd?: string;
  safetyTier?: 'public' | 'private' | 'restricted';
  defaultCyclic?: boolean;
  ventureId?: string | null;
  status?: 'draft' | 'published' | 'archived';
  olasAgentId?: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseBlueprint(blueprint: string | object): object {
  const parsed = typeof blueprint === 'string' ? JSON.parse(blueprint) : blueprint;
  if (!parsed.invariants || !Array.isArray(parsed.invariants)) {
    throw new Error('Blueprint must contain an "invariants" array');
  }
  return parsed;
}

// ============================================================================
// CRUD Functions
// ============================================================================

export async function createTemplate(args: CreateTemplateArgs): Promise<Template> {
  const blueprint = parseBlueprint(args.blueprint);
  const slug = args.slug || generateSlug(args.name);

  const record: Record<string, any> = {
    name: args.name,
    slug,
    description: args.description || null,
    version: args.version || '0.1.0',
    blueprint,
    input_schema: args.inputSchema || {},
    output_spec: args.outputSpec || {},
    enabled_tools: args.enabledTools || [],
    price_wei: args.priceWei || null,
    price_usd: args.priceUsd || null,
    safety_tier: args.safetyTier || 'public',
    default_cyclic: args.defaultCyclic || false,
    venture_id: args.ventureId || null,
    status: args.status || 'draft',
  };

  const { data, error } = await supabase
    .from('templates')
    .insert(record)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create template: ${error.message}`);
  }

  return data as Template;
}

export async function getTemplate(id: string): Promise<Template | null> {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get template: ${error.message}`);
  }

  return data as Template;
}

export async function getTemplateBySlug(slug: string): Promise<Template | null> {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get template by slug: ${error.message}`);
  }

  return data as Template;
}

export async function listTemplates(options: {
  status?: string;
  ventureId?: string;
  tags?: string[];
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Template[]> {
  let query = supabase
    .from('templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (options.status) {
    query = query.eq('status', options.status);
  }
  if (options.ventureId) {
    query = query.eq('venture_id', options.ventureId);
  }
  if (options.tags && options.tags.length > 0) {
    query = query.overlaps('tags', options.tags);
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
    throw new Error(`Failed to list templates: ${error.message}`);
  }

  return data as Template[];
}

export async function updateTemplate(args: UpdateTemplateArgs): Promise<Template> {
  const { id, ...updates } = args;
  const record: Record<string, any> = {};

  if (updates.name !== undefined) record.name = updates.name;
  if (updates.slug !== undefined) record.slug = updates.slug;
  if (updates.description !== undefined) record.description = updates.description;
  if (updates.version !== undefined) record.version = updates.version;
  if (updates.inputSchema !== undefined) record.input_schema = updates.inputSchema;
  if (updates.outputSpec !== undefined) record.output_spec = updates.outputSpec;
  if (updates.enabledTools !== undefined) record.enabled_tools = updates.enabledTools;
  if (updates.priceWei !== undefined) record.price_wei = updates.priceWei;
  if (updates.priceUsd !== undefined) record.price_usd = updates.priceUsd;
  if (updates.safetyTier !== undefined) record.safety_tier = updates.safetyTier;
  if (updates.defaultCyclic !== undefined) record.default_cyclic = updates.defaultCyclic;
  if (updates.ventureId !== undefined) record.venture_id = updates.ventureId;
  if (updates.status !== undefined) record.status = updates.status;
  if (updates.olasAgentId !== undefined) record.olas_agent_id = updates.olasAgentId;

  if (updates.blueprint !== undefined) {
    record.blueprint = parseBlueprint(updates.blueprint);
  }

  if (Object.keys(record).length === 0) {
    throw new Error('No fields to update');
  }

  const { data, error } = await supabase
    .from('templates')
    .update(record)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update template: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Template not found: ${id}`);
  }

  return data as Template;
}

export async function archiveTemplate(id: string): Promise<Template> {
  return updateTemplate({ id, status: 'archived' });
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('templates')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`);
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/templates/crud.ts <command> [options]

Commands:
  create   Create a new template
  get      Get a template by ID
  list     List templates
  update   Update a template
  archive  Archive a template (soft delete)
  delete   Permanently delete a template

Create options:
  --name <name>              Template name (required)
  --blueprint <json>         Blueprint JSON with invariants array (required)
  --slug <slug>              URL-friendly slug (auto-generated)
  --description <text>       Template description
  --version <ver>            Version string (default: 0.1.0)
  --tags <t1,t2>             Comma-separated tags
  --priceWei <wei>           Price in wei
  --priceUsd <usd>           Price in USD
  --safetyTier <tier>        public, private, or restricted
  --defaultCyclic            Mark as cyclic
  --ventureId <uuid>         Associated venture ID
  --status <status>          draft, published, or archived

Get options:
  --id <uuid>                Template ID

List options:
  --status <status>          Filter by status
  --search <text>            Search name/description
  --tags <t1,t2>             Filter by tags
  --limit <n>                Max results (default: 20)
  --offset <n>               Pagination offset

Update options:
  --id <uuid>                Template ID (required)
  (any create option except --blueprint can be used)

Archive options:
  --id <uuid>                Template ID

Delete options:
  --id <uuid>                Template ID
  --confirm                  Required for permanent deletion
`);
}

function parseCliArgs(): { command: string; args: Record<string, any> } {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args: Record<string, any> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--confirm') {
      args.confirm = true;
      continue;
    }
    if (arg === '--defaultCyclic') {
      args.defaultCyclic = true;
      continue;
    }

    if (arg.startsWith('--') && next && !next.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'tags') {
        args[key] = next.split(',').map((t: string) => t.trim());
      } else {
        args[key] = next;
      }
      i++;
    }
  }

  return { command, args };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length < 3) {
    printUsage();
    process.exit(0);
  }

  const { command, args } = parseCliArgs();

  try {
    switch (command) {
      case 'create': {
        if (!args.name || !args.blueprint) {
          console.error('Error: --name and --blueprint are required for create');
          process.exit(1);
        }
        const template = await createTemplate(args as CreateTemplateArgs);
        console.log(JSON.stringify({ ok: true, data: template }, null, 2));
        break;
      }
      case 'get': {
        if (!args.id) {
          console.error('Error: --id is required for get');
          process.exit(1);
        }
        const template = await getTemplate(args.id);
        console.log(JSON.stringify({ ok: true, data: template }, null, 2));
        break;
      }
      case 'list': {
        const templates = await listTemplates({
          status: args.status,
          search: args.search,
          tags: args.tags,
          limit: args.limit ? parseInt(args.limit) : 20,
          offset: args.offset ? parseInt(args.offset) : 0,
        });
        console.log(JSON.stringify({ ok: true, data: templates, total: templates.length }, null, 2));
        break;
      }
      case 'update': {
        if (!args.id) {
          console.error('Error: --id is required for update');
          process.exit(1);
        }
        const template = await updateTemplate(args as UpdateTemplateArgs);
        console.log(JSON.stringify({ ok: true, data: template }, null, 2));
        break;
      }
      case 'archive': {
        if (!args.id) {
          console.error('Error: --id is required for archive');
          process.exit(1);
        }
        const template = await archiveTemplate(args.id);
        console.log(JSON.stringify({ ok: true, data: template }, null, 2));
        break;
      }
      case 'delete': {
        if (!args.id) {
          console.error('Error: --id is required for delete');
          process.exit(1);
        }
        if (!args.confirm) {
          console.error('Error: --confirm is required for permanent deletion');
          process.exit(1);
        }
        await deleteTemplate(args.id);
        console.log(JSON.stringify({ ok: true, deleted: true, id: args.id }, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith('/crud.ts') || process.argv[1]?.endsWith('/crud.js') || process.argv[1]?.endsWith('\\crud.ts') || process.argv[1]?.endsWith('\\crud.js');
if (isDirectRun) {
  main();
}
