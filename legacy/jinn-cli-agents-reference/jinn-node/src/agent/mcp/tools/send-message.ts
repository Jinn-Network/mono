import { z } from 'zod';
import { getSupabase } from './shared/supabase.js';
import { getCurrentJobContext } from './shared/context.js';

export const sendMessageParams = z.object({
  to_job_definition_id: z.string().uuid().describe('Target job definition ID (required).'),
  content: z
    .string()
    .min(1)
    .describe('Message body. Keep concise; large payloads should be artifacts.'),
});

export const sendMessageSchema = {
  description: 'Sends a message to another job definition. Use this to escalate, request clarification, or hand off. To send a message to a human supervisor, set `to_job_definition_id` to "eb462084-3fc4-49da-b92d-a050fad82d63". Writes to the messages table via DB RPC with lineage injection.',
  inputSchema: sendMessageParams.shape,
};

export async function sendMessage(params: z.infer<typeof sendMessageParams>) {
  try {
    const parseResult = sendMessageParams.safeParse(params);
    if (!parseResult.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ data: null, meta: { ok: false, code: 'VALIDATION_ERROR', message: `Invalid parameters: ${parseResult.error.message}`, details: parseResult.error.flatten?.() ?? undefined } })
        }]
      };
    }

    const { to_job_definition_id, content } = parseResult.data;
    const { jobId, jobDefinitionId, projectRunId, sourceEventId } = getCurrentJobContext();

    // Enforce: parent_job_definition_id must be present in the current context
    if (!jobDefinitionId) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'NO_JOB_DEFINITION_CONTEXT',
              message: 'Cannot send message: missing parent job definition in context. Ensure the worker passes JINN_CTX_JOB_DEFINITION_ID.'
            }
          })
        }]
      };
    }

    const payload: Record<string, any> = {
      // addressing
      to_job_definition_id: to_job_definition_id ?? null,
      content,
      // lineage (source)
      job_id: jobId ?? null,
      parent_job_definition_id: jobDefinitionId,
      project_run_id: projectRunId ?? null,
      source_event_id: sourceEventId ?? null,
      project_definition_id: null,
    };

    // If context carries project definition, include it
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (process.env.JINN_CTX_PROJECT_DEFINITION_ID) {
      payload.project_definition_id = process.env.JINN_CTX_PROJECT_DEFINITION_ID;
    }

    // Enforce DB-function-only write path
    const supabase = await getSupabase();
    const { data: newId, error } = await supabase.rpc('create_record', {
      p_table_name: 'messages',
      p_data: payload,
    });
    if (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ 
            data: null, 
            meta: { 
              ok: false, 
              code: 'DB_ERROR', 
              message: `Error sending message: ${error.message}` 
            } 
          }, null, 2)
        }]
      };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ data: { id: newId }, meta: { ok: true } }) }] };
  } catch (e: any) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'DB_ERROR', message: `Error sending message: ${e.message}` } }) },
      ],
    };
  }
}


