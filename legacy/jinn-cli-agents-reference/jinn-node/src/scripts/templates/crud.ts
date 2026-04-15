import { supabase } from '../../data/supabase.js';

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
  tags?: string[];
  priceWei?: string;
  priceUsd?: string;
  safetyTier?: 'public' | 'private' | 'restricted';
  defaultCyclic?: boolean;
  ventureId?: string;
  status?: 'draft' | 'published' | 'archived';
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
  priceUsd?: string;
  safetyTier?: 'public' | 'private' | 'restricted';
  defaultCyclic?: boolean;
  ventureId?: string | null;
  status?: 'draft' | 'published' | 'archived';
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseBlueprint(blueprint: string | object): object {
  const parsed = typeof blueprint === 'string' ? JSON.parse(blueprint) : blueprint;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).invariants)) {
    throw new Error('Blueprint must contain an "invariants" array');
  }
  return parsed;
}

export async function createTemplate(args: CreateTemplateArgs): Promise<Template> {
  const blueprint = parseBlueprint(args.blueprint);
  const slug = args.slug || generateSlug(args.name);

  const record: Record<string, unknown> = {
    name: args.name,
    slug,
    description: args.description || null,
    version: args.version || '0.1.0',
    blueprint,
    input_schema: args.inputSchema || {},
    output_spec: args.outputSpec || {},
    enabled_tools: args.enabledTools || [],
    tags: args.tags || [],
    price_wei: args.priceWei || null,
    price_usd: args.priceUsd || null,
    safety_tier: args.safetyTier || 'public',
    default_cyclic: args.defaultCyclic || false,
    venture_id: args.ventureId || null,
    status: args.status || 'draft',
  };

  const { data, error } = await supabase.from('templates').insert(record).select().single();
  if (error) throw new Error(`Failed to create template: ${error.message}`);
  return data as Template;
}

export async function getTemplate(id: string): Promise<Template | null> {
  const { data, error } = await supabase.from('templates').select('*').eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get template: ${error.message}`);
  }
  return data as Template;
}

export async function getTemplateBySlug(slug: string): Promise<Template | null> {
  const { data, error } = await supabase.from('templates').select('*').eq('slug', slug).single();
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
  let query = supabase.from('templates').select('*').order('created_at', { ascending: false });

  if (options.status) query = query.eq('status', options.status);
  if (options.ventureId) query = query.eq('venture_id', options.ventureId);
  if (options.tags && options.tags.length > 0) query = query.overlaps('tags', options.tags);
  if (options.search) {
    query = query.or(`name.ilike.%${options.search}%,description.ilike.%${options.search}%`);
  }
  if (options.limit) query = query.limit(options.limit);
  if (options.offset) query = query.range(options.offset, options.offset + (options.limit || 50) - 1);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list templates: ${error.message}`);
  return data as Template[];
}

export async function updateTemplate(args: UpdateTemplateArgs): Promise<Template> {
  const { id, ...updates } = args;
  const record: Record<string, unknown> = {};

  if (updates.name !== undefined) record.name = updates.name;
  if (updates.slug !== undefined) record.slug = updates.slug;
  if (updates.description !== undefined) record.description = updates.description;
  if (updates.version !== undefined) record.version = updates.version;
  if (updates.inputSchema !== undefined) record.input_schema = updates.inputSchema;
  if (updates.outputSpec !== undefined) record.output_spec = updates.outputSpec;
  if (updates.enabledTools !== undefined) record.enabled_tools = updates.enabledTools;
  if (updates.tags !== undefined) record.tags = updates.tags;
  if (updates.priceWei !== undefined) record.price_wei = updates.priceWei;
  if (updates.priceUsd !== undefined) record.price_usd = updates.priceUsd;
  if (updates.safetyTier !== undefined) record.safety_tier = updates.safetyTier;
  if (updates.defaultCyclic !== undefined) record.default_cyclic = updates.defaultCyclic;
  if (updates.ventureId !== undefined) record.venture_id = updates.ventureId;
  if (updates.status !== undefined) record.status = updates.status;
  if (updates.blueprint !== undefined) record.blueprint = parseBlueprint(updates.blueprint);

  if (Object.keys(record).length === 0) throw new Error('No fields to update');

  const { data, error } = await supabase.from('templates').update(record).eq('id', id).select().single();
  if (error) throw new Error(`Failed to update template: ${error.message}`);
  if (!data) throw new Error(`Template not found: ${id}`);
  return data as Template;
}

export async function archiveTemplate(id: string): Promise<Template> {
  return updateTemplate({ id, status: 'archived' });
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase.from('templates').delete().eq('id', id);
  if (error) throw new Error(`Failed to delete template: ${error.message}`);
}
