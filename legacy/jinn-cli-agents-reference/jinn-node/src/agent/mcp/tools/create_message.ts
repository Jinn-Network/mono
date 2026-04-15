import { z } from 'zod';
import { getCurrentJobContext } from './shared/context.js';
import { createMessage as apiCreateMessage } from './shared/control_api.js';
import { workerLogger } from '../../../logging/index.js'; // Reusing worker logger for consistency

export const createMessageParams = z.object({
  content: z.string().describe('The content of the message.'),
  status: z.string().optional().describe('The status of the message (default: PENDING).'),
});

export const createMessageSchema = {
  description: 'Creates a message record for the current on-chain job via the Control API. Requires an active on-chain job context (JINN_CTX_REQUEST_ID).',
  inputSchema: createMessageParams.shape,
};

export async function createMessageTool(params: z.infer<typeof createMessageParams>) {
  try {
    const parseResult = createMessageParams.safeParse(params);
    if (!parseResult.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ data: null, meta: { ok: false, code: 'VALIDATION_ERROR', message: `Invalid parameters: ${parseResult.error.message}`, details: parseResult.error.flatten?.() ?? undefined } })
        }]
      };
    }

    const { content, status } = parseResult.data;
    const { requestId } = getCurrentJobContext();

    if (!requestId) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ data: null, meta: { ok: false, code: 'MISSING_REQUEST_ID', message: 'create_message requires an active on-chain job context (JINN_CTX_REQUEST_ID).' } })
        }]
      };
    }

    workerLogger.info({ requestId, content: content.substring(0, 100) + '...', status: status || 'PENDING' }, 'Calling Control API to create message');
    const newId = await apiCreateMessage(requestId, { content, status: status || 'PENDING' });

    return { content: [{ type: 'text' as const, text: JSON.stringify({ data: { id: newId }, meta: { ok: true, source: 'control_api' } }) }] };
  } catch (e: any) {
    workerLogger.error({ error: e?.message || String(e) }, 'Error in create_message tool');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ data: null, meta: { ok: false, code: 'CONTROL_API_ERROR', message: `Control API error: ${e.message}` } })
      }]
    };
  }
}
