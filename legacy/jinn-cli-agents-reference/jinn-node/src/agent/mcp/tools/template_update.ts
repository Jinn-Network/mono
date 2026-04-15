import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { updateTemplate, type UpdateTemplateArgs } from '../../../scripts/templates/crud.js';

/**
 * Input schema for updating a template.
 */
export const templateUpdateParams = z.object({
  id: z.string().uuid().describe('Template ID to update'),
  name: z.string().min(1).optional().describe('New template name'),
  slug: z.string().optional().describe('New URL-friendly slug'),
  description: z.string().optional().describe('New template description'),
  version: z.string().optional().describe('New version string'),
  blueprint: z.string().optional().describe('New blueprint JSON string with invariants array'),
  inputSchema: z.string().optional().describe('New input JSON Schema string'),
  outputSpec: z.string().optional().describe('New output spec JSON string'),
  enabledTools: z.array(z.string()).optional().describe('New tool policy array'),
  tags: z.array(z.string()).optional().describe('New tags'),
  priceWei: z.string().optional().describe('New price in wei'),
  priceUsd: z.string().optional().describe('New human-readable price'),
  safetyTier: z.enum(['public', 'private', 'restricted']).optional().describe('New safety tier'),
  defaultCyclic: z.boolean().optional().describe('Whether template runs cyclically'),
  ventureId: z.string().uuid().optional().describe('New associated venture ID'),
  status: z.enum(['draft', 'published', 'archived']).optional().describe('New status'),
});

export type TemplateUpdateParams = z.infer<typeof templateUpdateParams>;

export const templateUpdateSchema = {
  description: `Update an existing template's properties.

Updates any combination of template fields. The blueprint field, if provided, must be a valid JSON string containing an invariants array.

PREREQUISITES:
- Know the template ID to update

Parameters:
- id: Template UUID (required)
- name: New template name
- slug: New URL-friendly identifier
- description: New description
- version: New version string
- blueprint: New JSON string with invariants array
- inputSchema: New input JSON Schema string
- outputSpec: New output spec JSON string
- enabledTools: New tool policy array
- tags: New discovery tags
- priceWei: New price in wei
- priceUsd: New human-readable price
- safetyTier: 'public', 'private', or 'restricted'
- defaultCyclic: Whether template runs cyclically
- ventureId: Associated venture UUID
- status: 'draft', 'published', or 'archived'

Returns: { template: { id, name, slug, ... } }`,
  inputSchema: templateUpdateParams.shape,
};

/**
 * Update an existing template.
 */
export async function templateUpdate(args: unknown) {
  try {
    const parsed = templateUpdateParams.safeParse(args);
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

    const {
      id, name, slug, description, version, blueprint,
      inputSchema, outputSpec, enabledTools, tags,
      priceWei, priceUsd, safetyTier, defaultCyclic,
      ventureId, status,
    } = parsed.data;

    const scriptArgs: UpdateTemplateArgs = { id };
    if (name !== undefined) scriptArgs.name = name;
    if (slug !== undefined) scriptArgs.slug = slug;
    if (description !== undefined) scriptArgs.description = description;
    if (version !== undefined) scriptArgs.version = version;
    if (blueprint !== undefined) scriptArgs.blueprint = blueprint;
    if (inputSchema !== undefined) scriptArgs.inputSchema = JSON.parse(inputSchema);
    if (outputSpec !== undefined) scriptArgs.outputSpec = JSON.parse(outputSpec);
    if (enabledTools !== undefined) scriptArgs.enabledTools = enabledTools;
    if (tags !== undefined) scriptArgs.tags = tags;
    if (priceWei !== undefined) scriptArgs.priceWei = priceWei;
    if (priceUsd !== undefined) scriptArgs.priceUsd = priceUsd;
    if (safetyTier !== undefined) scriptArgs.safetyTier = safetyTier;
    if (defaultCyclic !== undefined) scriptArgs.defaultCyclic = defaultCyclic;
    if (ventureId !== undefined) scriptArgs.ventureId = ventureId;
    if (status !== undefined) scriptArgs.status = status;

    const template = await updateTemplate(scriptArgs);

    mcpLogger.info({ templateId: template.id, name: template.name }, 'Updated template');

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
    mcpLogger.error({ error: message }, 'template_update failed');
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
