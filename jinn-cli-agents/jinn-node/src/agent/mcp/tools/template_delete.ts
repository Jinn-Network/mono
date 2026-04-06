import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { archiveTemplate, deleteTemplate } from '../../../scripts/templates/crud.js';

/**
 * Input schema for deleting a template.
 */
export const templateDeleteParams = z.object({
  id: z.string().uuid().describe('Template ID to delete'),
  mode: z.enum(['soft', 'hard']).default('soft').describe('Delete mode: soft (archive) or hard (permanent)'),
  confirm: z.boolean().optional().describe('Required for hard delete'),
});

export type TemplateDeleteParams = z.infer<typeof templateDeleteParams>;

export const templateDeleteSchema = {
  description: `Delete or archive a template.

MODES:
- soft (default): Sets status to 'archived' - template can be restored later
- hard: Permanently deletes the template - CANNOT BE UNDONE

PREREQUISITES:
- Know the template ID
- For hard delete: set confirm: true

Parameters:
- id: Template UUID (required)
- mode: 'soft' (archive) or 'hard' (permanent) - default: soft
- confirm: Must be true for hard delete

EXAMPLE:
1. Archive: { id: "<uuid>", mode: "soft" }
2. Delete: { id: "<uuid>", mode: "hard", confirm: true }

Returns: { template } for soft delete, { deleted: true } for hard delete`,
  inputSchema: templateDeleteParams.shape,
};

/**
 * Delete or archive a template.
 */
export async function templateDelete(args: unknown) {
  try {
    const parsed = templateDeleteParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message }
          })
        }]
      };
    }

    const { id, mode, confirm } = parsed.data;

    if (mode === 'hard') {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Hard delete requires confirm: true' }
            })
          }]
        };
      }

      await deleteTemplate(id);

      mcpLogger.info({ templateId: id }, 'Hard deleted template');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: { deleted: true, id },
            meta: { ok: true }
          })
        }]
      };
    }

    // Soft delete (archive)
    const template = await archiveTemplate(id);

    mcpLogger.info({ templateId: id }, 'Archived template');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: { template },
          meta: { ok: true }
        })
      }]
    };

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'template_delete failed');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message }
        })
      }]
    };
  }
}
