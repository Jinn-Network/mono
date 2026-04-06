import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { createTemplate, type CreateTemplateArgs } from '../../../scripts/templates/crud.js';

/**
 * Input schema for creating a template.
 */
export const templateCreateParams = z.object({
  name: z.string().min(1).describe('Template name'),
  slug: z.string().optional().describe('URL-friendly slug (auto-generated if not provided)'),
  description: z.string().optional().describe('Template description'),
  version: z.string().optional().describe('Version string (default: 0.1.0)'),
  blueprint: z.string().describe('Blueprint JSON string with invariants array'),
  inputSchema: z.string().optional().describe('Input JSON Schema string'),
  outputSpec: z.string().optional().describe('Output spec JSON string'),
  enabledTools: z.array(z.string()).optional().describe('Tool policy array'),
  tags: z.array(z.string()).optional().describe('Searchable tags for discovery'),
  priceWei: z.string().optional().describe('Price in wei (string for bigint compat)'),
  priceUsd: z.string().optional().describe('Human-readable price (e.g., "$0.05")'),
  safetyTier: z.enum(['public', 'private', 'restricted']).optional().describe('Safety tier (default: public)'),
  defaultCyclic: z.boolean().optional().describe('Whether template runs cyclically'),
  ventureId: z.string().uuid().optional().describe('Associated venture ID'),
  status: z.enum(['draft', 'published', 'archived']).optional().default('draft').describe('Template status'),
});

export type TemplateCreateParams = z.infer<typeof templateCreateParams>;

export const templateCreateSchema = {
  description: `Create a new reusable template definition in the Jinn registry.

A template is a static, reusable blueprint that defines a job type with:
- A blueprint containing invariants (success criteria)
- Input schema for parameterization
- Output spec for result extraction
- Tool requirements and pricing

Templates are stored in Supabase and created with status='draft' by default.
Publish with template_update to make them available in the marketplace.

PREREQUISITES:
- Have a valid blueprint with invariants array

Parameters:
- name: Template name (required)
- blueprint: JSON string with invariants array (required)
- slug: URL-friendly identifier (auto-generated from name if not provided)
- description: Template description
- version: Version string (default: 0.1.0)
- inputSchema: JSON Schema string for input validation
- outputSpec: Output contract JSON string
- enabledTools: Array of tool names
- tags: Discovery tags
- priceWei: Price in wei
- priceUsd: Human-readable price
- safetyTier: 'public', 'private', or 'restricted'
- defaultCyclic: Whether template runs cyclically
- ventureId: Associated venture UUID
- status: 'draft', 'published', or 'archived'

Returns: { template: { id, name, slug, ... } }`,
  inputSchema: templateCreateParams.shape,
};

/**
 * Create a new template.
 * Delegates to the script function which handles all Supabase operations.
 */
export async function templateCreate(args: unknown) {
  try {
    const parsed = templateCreateParams.safeParse(args);
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
      name, slug, description, version, blueprint,
      inputSchema, outputSpec, enabledTools, tags,
      priceWei, priceUsd, safetyTier, defaultCyclic,
      ventureId, status,
    } = parsed.data;

    const scriptArgs: CreateTemplateArgs = {
      name,
      slug,
      description,
      version,
      blueprint,
      inputSchema: inputSchema ? JSON.parse(inputSchema) : undefined,
      outputSpec: outputSpec ? JSON.parse(outputSpec) : undefined,
      enabledTools,
      tags,
      priceWei,
      priceUsd,
      safetyTier,
      defaultCyclic,
      ventureId,
      status,
    };

    const template = await createTemplate(scriptArgs);

    mcpLogger.info({ templateId: template.id, name }, 'Created new template');

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
    mcpLogger.error({ error: message }, 'template_create failed');
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
