import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { getSupabase } from './shared/supabase.js';

export const readDispatchScheduleParams = z.object({
  ventureId: z.string().uuid().describe('Venture ID to read schedule for'),
});

export type ReadDispatchScheduleParams = z.infer<typeof readDispatchScheduleParams>;

export const readDispatchScheduleSchema = {
  description: `Read a venture's dispatch schedule and invariants.

Returns the venture's cron-triggered dispatch schedule entries and its blueprint invariants.
Each schedule entry defines a template to dispatch on a cron cadence.

Parameters:
- ventureId: Venture UUID (required)

Returns: { schedule: ScheduleEntry[], ventureInvariants: Invariant[] }`,
  inputSchema: readDispatchScheduleParams.shape,
};

export async function readDispatchSchedule(args: unknown) {
  try {
    const parsed = readDispatchScheduleParams.safeParse(args);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', parsed.error.message);
    }

    const { ventureId } = parsed.data;

    // Use credential bridge supabase (worker-side client is null in agent context)
    const supabase = await getSupabase();
    const { data: venture, error } = await supabase
      .from('ventures')
      .select('*')
      .eq('id', ventureId)
      .single();

    if (error || !venture) {
      return errorResponse('NOT_FOUND', `Venture not found: ${ventureId}`);
    }

    const schedule = venture.dispatch_schedule || [];
    const blueprint = venture.blueprint as any;
    const ventureInvariants = Array.isArray(blueprint?.invariants)
      ? blueprint.invariants
      : [];

    mcpLogger.info({ ventureId, scheduleCount: schedule.length }, 'Read dispatch schedule');
    return successResponse({ schedule, ventureInvariants });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'read_dispatch_schedule failed');
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
