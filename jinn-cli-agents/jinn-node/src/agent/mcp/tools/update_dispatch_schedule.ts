import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { getSupabase } from './shared/supabase.js';
import type { ScheduleEntry } from '../../../data/types/scheduleEntry.js';

const scheduleEntrySchema = z.object({
  id: z.string().describe('Unique entry ID (UUID)'),
  templateId: z.string().describe('Template UUID from Supabase templates table'),
  cron: z.string().describe('Cron expression, e.g. "0 6 * * 1"'),
  input: z.record(z.any()).optional().describe('Static input data merged with template defaults'),
  label: z.string().optional().describe('Human-readable label'),
  enabled: z.boolean().optional().describe('Whether entry is active (default true)'),
});

const scheduleEntryPatchSchema = z.object({
  id: z.string().describe('Entry ID to update'),
  templateId: z.string().optional().describe('Updated template UUID'),
  cron: z.string().optional().describe('Updated cron expression'),
  input: z.record(z.any()).optional().describe('Updated input data'),
  label: z.string().optional().describe('Updated label'),
  enabled: z.boolean().optional().describe('Updated enabled state'),
});

export const updateDispatchScheduleParams = z.object({
  ventureId: z.string().uuid().describe('Venture ID to update schedule for'),
  schedule: z.array(scheduleEntrySchema).optional().describe('Full replacement schedule (if provided, replaces entire schedule)'),
  add: z.array(scheduleEntrySchema).optional().describe('Entries to add to existing schedule'),
  remove: z.array(z.string()).optional().describe('Entry IDs to remove from schedule'),
  update: z.array(scheduleEntryPatchSchema).optional().describe('Partial updates to existing entries (matched by id)'),
});

export type UpdateDispatchScheduleParams = z.infer<typeof updateDispatchScheduleParams>;

export const updateDispatchScheduleSchema = {
  description: `Update a venture's dispatch schedule.

Supports full replacement or incremental operations:
- schedule: Replace entire schedule with this array
- add: Append entries to existing schedule
- remove: Remove entries by ID
- update: Partial update of entries (matched by id)

If 'schedule' is provided, it takes precedence (full replacement).
Otherwise, add/remove/update are applied incrementally.

Parameters:
- ventureId: Venture UUID (required)
- schedule: Full replacement array (optional)
- add: Entries to add (optional)
- remove: Entry IDs to remove (optional)
- update: Partial entry updates (optional)

Returns: { schedule: ScheduleEntry[] }`,
  inputSchema: updateDispatchScheduleParams.shape,
};

export async function updateDispatchSchedule(args: unknown) {
  try {
    const parsed = updateDispatchScheduleParams.safeParse(args);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', parsed.error.message);
    }

    const { ventureId, schedule: fullSchedule, add, remove, update: updates } = parsed.data;

    // Use credential bridge supabase (worker-side client is null in agent context)
    const supabase = await getSupabase();
    const { data: venture, error: fetchErr } = await supabase
      .from('ventures')
      .select('*')
      .eq('id', ventureId)
      .single();
    if (fetchErr || !venture) {
      return errorResponse('NOT_FOUND', `Venture not found: ${ventureId}`);
    }

    let newSchedule: ScheduleEntry[];

    if (fullSchedule !== undefined) {
      // Full replacement — Zod guarantees all required fields are present
      newSchedule = fullSchedule as ScheduleEntry[];
    } else {
      // Incremental operations
      newSchedule = [...(venture.dispatch_schedule || [])];

      // Remove entries
      if (remove && remove.length > 0) {
        const removeSet = new Set(remove);
        newSchedule = newSchedule.filter(e => !removeSet.has(e.id));
      }

      // Update existing entries
      if (updates && updates.length > 0) {
        for (const patch of updates) {
          const idx = newSchedule.findIndex(e => e.id === patch.id);
          if (idx >= 0) {
            newSchedule[idx] = { ...newSchedule[idx], ...patch } as ScheduleEntry;
          }
        }
      }

      // Add new entries
      if (add && add.length > 0) {
        // Check for duplicate IDs
        const existingIds = new Set(newSchedule.map(e => e.id));
        for (const entry of add) {
          if (existingIds.has(entry.id)) {
            return errorResponse('DUPLICATE_ID', `Schedule entry ID already exists: ${entry.id}`);
          }
        }
        newSchedule.push(...(add as ScheduleEntry[]));
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from('ventures')
      .update({ dispatch_schedule: newSchedule })
      .eq('id', ventureId)
      .select()
      .single();
    if (updateErr) throw new Error(`Failed to update schedule: ${updateErr.message}`);

    mcpLogger.info({ ventureId, scheduleCount: newSchedule.length }, 'Updated dispatch schedule');
    return successResponse({ schedule: updated.dispatch_schedule });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'update_dispatch_schedule failed');
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
