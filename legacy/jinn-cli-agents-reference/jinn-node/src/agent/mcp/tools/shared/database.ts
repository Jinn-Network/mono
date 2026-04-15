import { getSupabase } from './supabase.js';

export interface ReadRecordsParams {
  table_name: string;
  filter?: Record<string, any>;
  limit?: number;
  offset?: number;
}

export interface CreateRecordParams {
  table_name: string;
  data: Record<string, any>;
}

export async function readRecords(params: ReadRecordsParams) {
  const { table_name, filter = {}, limit, offset } = params;
  const supabase = await getSupabase();

  let query = supabase.from(table_name).select('*');
  
  // Apply filters
  Object.entries(filter).forEach(([key, value]) => {
    query = query.eq(key, value);
  });
  
  // Apply pagination
  if (limit !== undefined) {
    query = query.limit(limit);
  }
  if (offset !== undefined) {
    query = query.range(offset, offset + (limit || 1000) - 1);
  }
  
  const { data, error } = await query;
  
  if (error) {
    throw new Error(`Database read error: ${error.message}`);
  }
  
  return { data, meta: { ok: true } };
}

export async function createRecord(params: CreateRecordParams) {
  const { table_name, data } = params;
  const supabase = await getSupabase();

  const { data: result, error } = await supabase
    .from(table_name)
    .insert(data)
    .select()
    .single();
  
  if (error) {
    throw new Error(`Database create error: ${error.message}`);
  }
  
  return { data: result, meta: { ok: true } };
}
