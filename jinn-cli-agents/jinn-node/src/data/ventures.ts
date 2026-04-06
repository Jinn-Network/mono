/**
 * Venture data operations (Supabase CRUD)
 *
 * This module provides the core venture operations used by both
 * the MCP tools and CLI scripts.
 */

import { supabase } from './supabase.js';
import type { ScheduleEntry } from './types/scheduleEntry.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateVentureArgs {
  name: string;
  slug?: string;
  description?: string;
  ownerAddress: string;
  blueprint: string | object;
  rootWorkstreamId?: string;
  rootJobInstanceId?: string;
  status?: 'active' | 'paused' | 'archived';
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  stakingContractAddress?: string;
  tokenLaunchPlatform?: string;
  tokenMetadata?: object;
  governanceAddress?: string;
  poolAddress?: string;
}

export interface UpdateVentureArgs {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  ownerAddress?: string;
  blueprint?: string | object;
  rootWorkstreamId?: string | null;
  rootJobInstanceId?: string | null;
  status?: 'active' | 'paused' | 'archived';
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  stakingContractAddress?: string;
  tokenLaunchPlatform?: string;
  tokenMetadata?: object;
  governanceAddress?: string;
  poolAddress?: string;
  dispatchSchedule?: ScheduleEntry[];
}

export interface Venture {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_address: string;
  blueprint: object;
  root_workstream_id: string | null;
  root_job_instance_id: string | null;
  status: string;
  dispatch_schedule: ScheduleEntry[];
  created_at: string;
  updated_at: string;
}

export interface ListVenturesOptions {
  status?: string;
  ownerAddress?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Helper Functions
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

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new venture
 */
export async function createVenture(args: CreateVentureArgs): Promise<Venture> {
  // Parse blueprint if it's a string
  const blueprint = typeof args.blueprint === 'string'
    ? JSON.parse(args.blueprint)
    : args.blueprint;

  // Validate blueprint has invariants array
  if (!blueprint.invariants || !Array.isArray(blueprint.invariants)) {
    throw new Error('Blueprint must contain an "invariants" array');
  }

  // Generate slug if not provided
  const slug = args.slug || generateSlug(args.name);

  const record = {
    name: args.name,
    slug,
    description: args.description || null,
    owner_address: args.ownerAddress,
    blueprint,
    root_workstream_id: args.rootWorkstreamId || null,
    root_job_instance_id: args.rootJobInstanceId || null,
    status: args.status || 'active',
  };

  const { data, error } = await supabase
    .from('ventures')
    .insert(record)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create venture: ${error.message}`);
  }

  return data as Venture;
}

/**
 * Get a venture by ID
 */
export async function getVenture(id: string): Promise<Venture | null> {
  const { data, error } = await supabase
    .from('ventures')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw new Error(`Failed to get venture: ${error.message}`);
  }

  return data as Venture;
}

/**
 * Get a venture by slug
 */
export async function getVentureBySlug(slug: string): Promise<Venture | null> {
  const { data, error } = await supabase
    .from('ventures')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw new Error(`Failed to get venture by slug: ${error.message}`);
  }

  return data as Venture;
}

/**
 * List ventures with optional filters
 */
export async function listVentures(options: ListVenturesOptions = {}): Promise<Venture[]> {
  let query = supabase
    .from('ventures')
    .select('*')
    .order('created_at', { ascending: false });

  if (options.status) {
    query = query.eq('status', options.status);
  }
  if (options.ownerAddress) {
    query = query.eq('owner_address', options.ownerAddress);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list ventures: ${error.message}`);
  }

  return data as Venture[];
}

/**
 * Update an existing venture
 */
export async function updateVenture(args: UpdateVentureArgs): Promise<Venture> {
  const { id, ...updates } = args;

  // Build the update object, only including provided fields
  const record: Record<string, any> = {};

  if (updates.name !== undefined) record.name = updates.name;
  if (updates.slug !== undefined) record.slug = updates.slug;
  if (updates.description !== undefined) record.description = updates.description;
  if (updates.ownerAddress !== undefined) record.owner_address = updates.ownerAddress;
  if (updates.rootWorkstreamId !== undefined) record.root_workstream_id = updates.rootWorkstreamId;
  if (updates.rootJobInstanceId !== undefined) record.root_job_instance_id = updates.rootJobInstanceId;
  if (updates.status !== undefined) record.status = updates.status;

  if (updates.blueprint !== undefined) {
    const blueprint = typeof updates.blueprint === 'string'
      ? JSON.parse(updates.blueprint)
      : updates.blueprint;

    // Validate blueprint has invariants array
    if (!blueprint.invariants || !Array.isArray(blueprint.invariants)) {
      throw new Error('Blueprint must contain an "invariants" array');
    }
    record.blueprint = blueprint;
  }

  if (updates.dispatchSchedule !== undefined) {
    record.dispatch_schedule = updates.dispatchSchedule;
  }

  if (Object.keys(record).length === 0) {
    throw new Error('No fields to update');
  }

  const { data, error } = await supabase
    .from('ventures')
    .update(record)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update venture: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Venture not found: ${id}`);
  }

  return data as Venture;
}

/**
 * Archive a venture (sets status to archived)
 */
export async function archiveVenture(id: string): Promise<Venture> {
  return updateVenture({ id, status: 'archived' });
}

/**
 * Permanently delete a venture
 */
export async function deleteVenture(id: string): Promise<void> {
  const { error } = await supabase
    .from('ventures')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete venture: ${error.message}`);
  }
}
