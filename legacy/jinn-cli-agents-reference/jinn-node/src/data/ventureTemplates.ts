/**
 * Venture template data operations (Supabase CRUD)
 *
 * Venture templates live in a dedicated `venture_templates` table,
 * separate from workstream/agent templates.
 */

import { getSupabase } from '../agent/mcp/tools/shared/supabase.js';

export interface VentureTemplate {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  version: string;
  blueprint: object;
  input_schema: object;
  output_spec: object;
  enabled_tools: string[];
  model: string;
  safety_tier: 'public' | 'private' | 'restricted';
  venture_id: string | null;
  olas_agent_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Get a venture template by ID.
 */
export async function getVentureTemplate(id: string): Promise<VentureTemplate | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('venture_templates')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return null;
  return data as VentureTemplate;
}

/**
 * Get a venture template by slug.
 */
export async function getVentureTemplateBySlug(slug: string): Promise<VentureTemplate | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('venture_templates')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) return null;
  return data as VentureTemplate;
}

/**
 * List venture templates, optionally filtered by status or venture.
 */
export async function listVentureTemplates(filters?: {
  status?: string;
  ventureId?: string;
}): Promise<VentureTemplate[]> {
  const supabase = await getSupabase();
  let query = supabase.from('venture_templates').select('*');

  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.ventureId) query = query.eq('venture_id', filters.ventureId);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as VentureTemplate[];
}
