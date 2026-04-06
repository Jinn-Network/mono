import { supabaseQuery, supabaseAdminQuery } from '@/lib/supabase';

export interface ScheduleEntry {
  id: string;
  templateId: string;
  cron: string;
  input?: Record<string, unknown>;
  label?: string;
  enabled?: boolean;
}

export interface Venture {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_address: string;
  blueprint: Record<string, unknown> | null;
  root_workstream_id: string | null;
  root_job_instance_id: string | null;
  dispatch_schedule: ScheduleEntry[];
  status: 'proposed' | 'bonding' | 'active' | 'paused' | 'archived';
  creator_type: 'human' | 'delegate';
  created_at: string;
  updated_at: string;
  token_address: string | null;
  token_symbol: string | null;
  token_name: string | null;
  staking_contract_address: string | null;
  token_launch_platform: string | null;
  token_metadata: Record<string, unknown> | null;
  governance_address: string | null;
  pool_address: string | null;
  venture_template_id: string | null;
  likes?: { count: number }[];
  comments?: { count: number }[];
  likes_count?: number;
  comments_count?: number;
}

function mapCounts(data: Venture[]): Venture[] {
  return data.map(v => ({
    ...v,
    likes_count: v.likes?.[0]?.count || 0,
    comments_count: v.comments?.[0]?.count || 0
  }));
}

/** Fetch all ventures, sorted by newest first */
export async function getVentures(limit: number = 50): Promise<Venture[]> {
  const params: Record<string, string> = {
    select: '*,likes(count),comments(count)',
    order: 'created_at.desc',
  };
  if (limit > 0) {
    params.limit = limit.toString();
  }
  const data = await supabaseAdminQuery<Venture>('ventures', params);
  return mapCounts(data);
}

/** Fetch ventures currently in bonding phase */
export async function getBondingVentures(): Promise<Venture[]> {
  const data = await supabaseAdminQuery<Venture>('ventures', {
    select: '*,likes(count),comments(count)',
    status: 'eq.bonding',
    order: 'created_at.desc',
  });
  return mapCounts(data);
}

/** Fetch graduated (active) ventures with tokens */
export async function getGraduatedVentures(): Promise<Venture[]> {
  const data = await supabaseAdminQuery<Venture>('ventures', {
    select: '*,likes(count),comments(count)',
    status: 'eq.active',
    token_address: 'not.is.null',
    order: 'created_at.desc',
  });
  return mapCounts(data);
}

/** Fetch a single venture by slug */
export async function getVentureBySlug(slug: string): Promise<Venture | null> {
  const data = await supabaseAdminQuery<Venture>('ventures', {
    select: '*,likes(count),comments(count)',
    slug: `eq.${slug}`,
    limit: '1',
  });

  const ventures = mapCounts(data);
  return ventures[0] || null;
}
