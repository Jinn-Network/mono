#!/usr/bin/env tsx
/**
 * Service Documentation CRUD operations
 * Usage: yarn tsx scripts/services/docs.ts <action> [options]
 * Actions: create, get, list, update, delete
 */

import { supabase } from 'jinn-node/agent/mcp/tools/shared/supabase.js';

// ============================================================================
// Types
// ============================================================================

export type DocType = 'readme' | 'guide' | 'reference' | 'tutorial' | 'changelog' | 'api' | 'architecture' | 'runbook' | 'other';
export type ContentFormat = 'markdown' | 'html' | 'plaintext';
export type DocStatus = 'draft' | 'published' | 'archived';

export interface CreateDocArgs {
  serviceId: string;
  title: string;
  slug?: string;
  docType: DocType;
  content: string;
  contentFormat?: ContentFormat;
  parentId?: string;
  sortOrder?: number;
  author?: string;
  version?: string;
  externalUrl?: string;
  config?: object;
  tags?: string[];
  status?: DocStatus;
}

export interface UpdateDocArgs {
  id: string;
  title?: string;
  slug?: string;
  docType?: DocType;
  content?: string;
  contentFormat?: ContentFormat;
  parentId?: string | null;
  sortOrder?: number;
  author?: string;
  version?: string;
  externalUrl?: string;
  config?: object;
  tags?: string[];
  status?: DocStatus;
}

export interface ServiceDoc {
  id: string;
  service_id: string;
  title: string;
  slug: string;
  doc_type: DocType;
  content: string;
  content_format: ContentFormat;
  parent_id: string | null;
  sort_order: number;
  author: string | null;
  version: string | null;
  external_url: string | null;
  config: object;
  tags: string[];
  status: DocStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Exported Functions (for MCP tool usage)
// ============================================================================

/**
 * Generate a URL-friendly slug from a title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Create a new service doc
 */
export async function createDoc(args: CreateDocArgs): Promise<ServiceDoc> {
  const slug = args.slug || generateSlug(args.title);

  const record = {
    service_id: args.serviceId,
    title: args.title,
    slug,
    doc_type: args.docType,
    content: args.content,
    content_format: args.contentFormat || 'markdown',
    parent_id: args.parentId || null,
    sort_order: args.sortOrder || 0,
    author: args.author || null,
    version: args.version || null,
    external_url: args.externalUrl || null,
    config: args.config || {},
    tags: args.tags || [],
    status: args.status || 'draft',
  };

  const { data, error } = await supabase
    .from('service_docs')
    .insert(record)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create doc: ${error.message}`);
  }

  return data as ServiceDoc;
}

/**
 * Get a doc by ID
 */
export async function getDoc(id: string): Promise<ServiceDoc | null> {
  const { data, error } = await supabase
    .from('service_docs')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get doc: ${error.message}`);
  }

  return data as ServiceDoc;
}

/**
 * Get a doc by service ID and slug
 */
export async function getDocBySlug(serviceId: string, slug: string): Promise<ServiceDoc | null> {
  const { data, error } = await supabase
    .from('service_docs')
    .select('*')
    .eq('service_id', serviceId)
    .eq('slug', slug)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get doc by slug: ${error.message}`);
  }

  return data as ServiceDoc;
}

/**
 * List docs with optional filters
 */
export async function listDocs(options: {
  serviceId?: string;
  docType?: DocType;
  parentId?: string | null;
  status?: DocStatus;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ServiceDoc[]> {
  let query = supabase
    .from('service_docs')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (options.serviceId) {
    query = query.eq('service_id', options.serviceId);
  }
  if (options.docType) {
    query = query.eq('doc_type', options.docType);
  }
  if (options.parentId !== undefined) {
    if (options.parentId === null) {
      query = query.is('parent_id', null);
    } else {
      query = query.eq('parent_id', options.parentId);
    }
  }
  if (options.status) {
    query = query.eq('status', options.status);
  }
  if (options.search) {
    query = query.or(`title.ilike.%${options.search}%,content.ilike.%${options.search}%`);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list docs: ${error.message}`);
  }

  return data as ServiceDoc[];
}

/**
 * Update a doc
 */
export async function updateDoc(args: UpdateDocArgs): Promise<ServiceDoc> {
  const { id, ...updates } = args;

  const record: Record<string, any> = {};
  if (updates.title !== undefined) record.title = updates.title;
  if (updates.slug !== undefined) record.slug = updates.slug;
  if (updates.docType !== undefined) record.doc_type = updates.docType;
  if (updates.content !== undefined) record.content = updates.content;
  if (updates.contentFormat !== undefined) record.content_format = updates.contentFormat;
  if (updates.parentId !== undefined) record.parent_id = updates.parentId;
  if (updates.sortOrder !== undefined) record.sort_order = updates.sortOrder;
  if (updates.author !== undefined) record.author = updates.author;
  if (updates.version !== undefined) record.version = updates.version;
  if (updates.externalUrl !== undefined) record.external_url = updates.externalUrl;
  if (updates.config !== undefined) record.config = updates.config;
  if (updates.tags !== undefined) record.tags = updates.tags;
  if (updates.status !== undefined) record.status = updates.status;

  if (Object.keys(record).length === 0) {
    throw new Error('No fields to update');
  }

  const { data, error } = await supabase
    .from('service_docs')
    .update(record)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update doc: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Doc not found: ${id}`);
  }

  return data as ServiceDoc;
}

/**
 * Delete a doc
 */
export async function deleteDoc(id: string): Promise<void> {
  const { error } = await supabase
    .from('service_docs')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete doc: ${error.message}`);
  }
}

/**
 * Publish a doc
 */
export async function publishDoc(id: string): Promise<ServiceDoc> {
  return updateDoc({ id, status: 'published' });
}

/**
 * Get doc tree for a service (hierarchical structure)
 */
export async function getDocTree(serviceId: string): Promise<ServiceDoc[]> {
  const docs = await listDocs({ serviceId, status: 'published' });

  // Build tree structure
  const byId = new Map<string, ServiceDoc & { children?: ServiceDoc[] }>();
  const roots: (ServiceDoc & { children?: ServiceDoc[] })[] = [];

  // First pass: index all docs
  for (const doc of docs) {
    byId.set(doc.id, { ...doc, children: [] });
  }

  // Second pass: build hierarchy
  for (const doc of docs) {
    const node = byId.get(doc.id)!;
    if (doc.parent_id && byId.has(doc.parent_id)) {
      byId.get(doc.parent_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by sort_order
  function sortChildren(nodes: (ServiceDoc & { children?: ServiceDoc[] })[]) {
    nodes.sort((a, b) => a.sort_order - b.sort_order);
    for (const node of nodes) {
      if (node.children?.length) {
        sortChildren(node.children);
      }
    }
  }

  sortChildren(roots);

  return roots;
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/services/docs.ts <action> [options]

Actions:
  create    Create a new doc
  get       Get a doc by ID
  list      List docs with optional filters
  update    Update a doc
  delete    Delete a doc
  publish   Publish a doc
  tree      Get doc tree for a service

Create options:
  --serviceId <uuid>           Service ID (required)
  --title <title>              Doc title (required)
  --docType <type>             Type: readme, guide, reference, tutorial, changelog, api, architecture, runbook, other (required)
  --content <text>             Content (required)
  --slug <slug>                URL-friendly slug
  --contentFormat <format>     Format: markdown, html, plaintext
  --parentId <uuid>            Parent doc ID for hierarchy
  --sortOrder <n>              Sort order
  --author <name>              Author name
  --version <version>          Doc version
  --externalUrl <url>          External documentation URL
  --config <json>              Config as JSON
  --tags <tag1,tag2>           Comma-separated tags
  --status <status>            Status: draft, published, archived

Get options:
  --id <uuid>                  Doc ID

List options:
  --serviceId <uuid>           Filter by service
  --docType <type>             Filter by type
  --parentId <uuid>            Filter by parent (use "null" for root docs)
  --status <status>            Filter by status
  --search <query>             Search in title/content
  --limit <n>                  Limit results
  --offset <n>                 Offset for pagination

Tree options:
  --serviceId <uuid>           Service ID (required)

Examples:
  yarn tsx scripts/services/docs.ts create \\
    --serviceId "123..." --title "Getting Started" --docType "guide" \\
    --content "# Getting Started\\n\\nWelcome to..."

  yarn tsx scripts/services/docs.ts list --serviceId "123..." --docType "guide"

  yarn tsx scripts/services/docs.ts tree --serviceId "123..."
`);
}

function parseCreateArgs(args: string[]): CreateDocArgs {
  const result: Partial<CreateDocArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--serviceId': result.serviceId = next; i++; break;
      case '--title': result.title = next; i++; break;
      case '--slug': result.slug = next; i++; break;
      case '--docType': result.docType = next as DocType; i++; break;
      case '--content': result.content = next; i++; break;
      case '--contentFormat': result.contentFormat = next as ContentFormat; i++; break;
      case '--parentId': result.parentId = next; i++; break;
      case '--sortOrder': result.sortOrder = parseInt(next, 10); i++; break;
      case '--author': result.author = next; i++; break;
      case '--version': result.version = next; i++; break;
      case '--externalUrl': result.externalUrl = next; i++; break;
      case '--config': result.config = JSON.parse(next); i++; break;
      case '--tags': result.tags = next.split(',').map(t => t.trim()); i++; break;
      case '--status': result.status = next as DocStatus; i++; break;
    }
  }

  if (!result.serviceId || !result.title || !result.docType || !result.content) {
    console.error('Error: --serviceId, --title, --docType, and --content are required');
    process.exit(1);
  }

  return result as CreateDocArgs;
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
        const doc = await createDoc(createArgs);
        console.log(JSON.stringify({ ok: true, data: doc }, null, 2));
        break;
      }
      case 'get': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for get action');
          process.exit(1);
        }
        const doc = await getDoc(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, data: doc }, null, 2));
        break;
      }
      case 'list': {
        const options: Parameters<typeof listDocs>[0] = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--serviceId': options.serviceId = next; i++; break;
            case '--docType': options.docType = next as DocType; i++; break;
            case '--parentId': options.parentId = next === 'null' ? null : next; i++; break;
            case '--status': options.status = next as DocStatus; i++; break;
            case '--search': options.search = next; i++; break;
            case '--limit': options.limit = parseInt(next, 10); i++; break;
            case '--offset': options.offset = parseInt(next, 10); i++; break;
          }
        }
        const docs = await listDocs(options);
        console.log(JSON.stringify({ ok: true, data: docs }, null, 2));
        break;
      }
      case 'update': {
        const updateArgs: Partial<UpdateDocArgs> = {};
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const next = args[i + 1];
          switch (arg) {
            case '--id': updateArgs.id = next; i++; break;
            case '--title': updateArgs.title = next; i++; break;
            case '--slug': updateArgs.slug = next; i++; break;
            case '--docType': updateArgs.docType = next as DocType; i++; break;
            case '--content': updateArgs.content = next; i++; break;
            case '--contentFormat': updateArgs.contentFormat = next as ContentFormat; i++; break;
            case '--parentId': updateArgs.parentId = next === 'null' ? null : next; i++; break;
            case '--sortOrder': updateArgs.sortOrder = parseInt(next, 10); i++; break;
            case '--author': updateArgs.author = next; i++; break;
            case '--version': updateArgs.version = next; i++; break;
            case '--externalUrl': updateArgs.externalUrl = next; i++; break;
            case '--config': updateArgs.config = JSON.parse(next); i++; break;
            case '--tags': updateArgs.tags = next.split(',').map(t => t.trim()); i++; break;
            case '--status': updateArgs.status = next as DocStatus; i++; break;
          }
        }
        if (!updateArgs.id) {
          console.error('Error: --id is required for update action');
          process.exit(1);
        }
        const doc = await updateDoc(updateArgs as UpdateDocArgs);
        console.log(JSON.stringify({ ok: true, data: doc }, null, 2));
        break;
      }
      case 'delete': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for delete action');
          process.exit(1);
        }
        await deleteDoc(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, message: 'Doc deleted' }));
        break;
      }
      case 'publish': {
        const idIndex = args.indexOf('--id');
        if (idIndex === -1) {
          console.error('Error: --id is required for publish action');
          process.exit(1);
        }
        const doc = await publishDoc(args[idIndex + 1]);
        console.log(JSON.stringify({ ok: true, data: doc }, null, 2));
        break;
      }
      case 'tree': {
        const serviceIdIndex = args.indexOf('--serviceId');
        if (serviceIdIndex === -1) {
          console.error('Error: --serviceId is required for tree action');
          process.exit(1);
        }
        const tree = await getDocTree(args[serviceIdIndex + 1]);
        console.log(JSON.stringify({ ok: true, data: tree }, null, 2));
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
