/**
 * @deprecated Use template_create, template_query, template_update, template_delete instead.
 * This file writes directly to Ponder's PostgreSQL which is the wrong abstraction.
 * New template CRUD tools use Supabase's `templates` table via scripts/templates/crud.ts.
 * Kept for reference only — no longer registered in the MCP server.
 */
import { z } from 'zod';
// @ts-ignore - pg package exists but @types/pg not installed
import { Client } from 'pg';
import { mcpLogger } from '../../../logging/index.js';
import { parseAnnotatedTools } from '../../../shared/template-tools.js';

// .env is loaded automatically by the config system

const X402_GATEWAY_URL = (process.env.X402_GATEWAY_URL || 'https://x402-gateway-production-1b84.up.railway.app').replace(/\/+$/, '');

/**
 * Get the Ponder database URL for direct SQL access.
 * Falls back through multiple env vars for compatibility.
 */
function getPonderDatabaseUrl(): string | null {
    const candidates = [
        process.env.PONDER_DATABASE_URL,
        process.env.SUPABASE_POSTGRES_URL,
        process.env.DATABASE_URL,
    ];
    const result = candidates.find((url) => typeof url === 'string' && url.length > 0) || null;

    // Debug logging
    mcpLogger.info({
        ponderDbUrl: process.env.PONDER_DATABASE_URL ? `${process.env.PONDER_DATABASE_URL.substring(0, 40)}...` : 'undefined',
        supabaseUrl: process.env.SUPABASE_POSTGRES_URL ? `${process.env.SUPABASE_POSTGRES_URL.substring(0, 40)}...` : 'undefined',
        databaseUrl: process.env.DATABASE_URL ? `${process.env.DATABASE_URL.substring(0, 40)}...` : 'undefined',
        usingUrl: result ? `${result.substring(0, 40)}...` : 'null',
    }, 'register_template: database URL resolution');

    return result;
}

/**
 * Input schema for registering a template.

 * Maps to Ponder's jobTemplate table structure.
 */
export const registerTemplateParams = z.object({
    // Required identity
    name: z.string().min(1).describe('Template name (will be slugified for ID)'),
    description: z.string().min(10).describe('What this template does'),

    // Blueprint source
    blueprintCid: z.string().describe('IPFS CID of the blueprint.json artifact'),
    blueprint: z.string().optional().describe('Raw blueprint JSON content (optional, can be fetched from CID)'),

    // Template specs
    inputSchema: z.record(z.any()).optional().describe('JSON Schema for input validation'),
    outputSpec: z.record(z.any()).optional().describe('Output contract (schema + mapping)'),
    tools: z.array(z.union([
        z.string(),
        z.object({
            name: z.string(),
            required: z.boolean().optional(),
        })
    ])).describe('Tool policy list. Use { name, required } to mark required tools.'),
    tags: z.array(z.string()).optional().describe('Searchable tags for discovery'),

    // Pricing (empirical from test run)
    priceWei: z.string().describe('Price in wei derived from test execution cost'),
    priceUsd: z.string().optional().describe('Human-readable price (e.g., "$0.05")'),

    // Provenance
    canonicalJobDefinitionId: z.string().optional().describe('Job definition ID from test run'),

    // Visibility (default: hidden for approval)
    status: z.enum(['visible', 'hidden']).default('hidden').describe('Template visibility (default: hidden)'),
});

export type RegisterTemplateParams = z.infer<typeof registerTemplateParams>;

export const registerTemplateSchema = {
    description: `Register a venture as a template in the Jinn marketplace.

PREREQUISITES:
- Run the venture as a child workstream first to validate it works
- Extract execution cost from delivery telemetry for pricing
- Have blueprint.json uploaded to IPFS via create_artifact

WORKFLOW:
1. Dispatch venture as child job: dispatch_new_job({ ... })
2. Wait for delivery and extract telemetry.workerTelemetry.totalCost
3. Register template: register_template({ priceWei: observedCost * 1.2, ... })

The template will be created with status='hidden' by default, requiring approval before it becomes visible in the marketplace.

Parameters:
- name: Template name (required)
- description: What the template does (required)
- blueprintCid: IPFS CID from create_artifact for blueprint.json (required)
- priceWei: Price in wei from observed test run cost (required)
- inputSchema: JSON Schema for input validation
- outputSpec: Output contract for result extraction
- tools: Tool policy list (required)
- tags: Discovery tags
- canonicalJobDefinitionId: Job ID from test run
- status: 'visible' or 'hidden' (default: 'hidden')

Returns: { templateId, marketplaceUrl, status }`,
    inputSchema: registerTemplateParams.shape,
};

/**
 * Generate a URL-friendly slug from a template name.
 */
function generateTemplateId(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50) || 'unnamed-template';
}

/**
 * Compute a simple hash for blueprint deduplication.
 */
function computeBlueprintHash(blueprint: string): string {
    let hash = 0;
    for (let i = 0; i < blueprint.length; i++) {
        const char = blueprint.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'bph_' + Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Register a template in the Ponder jobTemplate table.
 * Uses direct PostgreSQL connection to Ponder's database.
 */
export async function registerTemplate(args: unknown) {
    const dbUrl = getPonderDatabaseUrl();
    if (!dbUrl) {
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'CONFIG_ERROR', message: 'PONDER_DATABASE_URL not configured' }
                })
            }]
        };
    }

    const client = new Client({ connectionString: dbUrl });
    // Suppress unhandled error events
    client.on('error', (err: Error) => {
        mcpLogger.warn({ err: err.message }, 'PG Client error (suppressed)');
    });

    try {
        const parsed = registerTemplateParams.safeParse(args);
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
            name,
            description,
            blueprintCid,
            blueprint,
            inputSchema,
            outputSpec,
            tools,
            tags,
            priceWei,
            priceUsd,
            canonicalJobDefinitionId,
            status,
        } = parsed.data;

        // Generate template ID from name
        const baseTemplateId = generateTemplateId(name);

        // Compute blueprint hash for deduplication (use CID as fallback)
        const blueprintHash = blueprint
            ? computeBlueprintHash(blueprint)
            : `cid_${blueprintCid.substring(0, 12)}`;

        // Final template ID includes hash suffix for uniqueness
        const templateId = `${baseTemplateId}-${blueprintHash.substring(4, 12)}`;

        const now = Math.floor(Date.now() / 1000);
        const toolPolicy = parseAnnotatedTools(tools);
        const templateAvailableTools = toolPolicy.availableTools;

        await client.connect();

        // Set search path if schema is configured (essential for Railway deployments)
        if (process.env.DATABASE_SCHEMA) {
            await client.query(`SET search_path TO "${process.env.DATABASE_SCHEMA}", public`);
        }

        // Check if template already exists
        const existingResult = await client.query(
            'SELECT id, status FROM job_template WHERE id = $1',
            [templateId]
        );

        if (existingResult.rows.length > 0) {
            const existing = existingResult.rows[0];
            // Update existing template (preserve run metrics)
            const finalStatus = existing.status === 'visible' ? 'visible' : status;

            await client.query(`
                UPDATE job_template SET
                    name = $1,
                    description = $2,
                    tags = $3,
                    enabled_tools = $4,
                    blueprint = $5,
                    input_schema = $6,
                    output_spec = $7,
                    price_wei = $8,
                    price_usd = $9,
                    status = $10
                WHERE id = $11
            `, [
                name,
                description,
                tags || [],
                templateAvailableTools,
                blueprint || null,
                inputSchema ? JSON.stringify(inputSchema) : null,
                outputSpec ? JSON.stringify(outputSpec) : null,
                priceWei,  // bigint stored as string in PG
                priceUsd || null,
                finalStatus,
                templateId,
            ]);

            const result = {
                templateId,
                action: 'updated',
                status: finalStatus,
                marketplaceUrl: `${X402_GATEWAY_URL}/templates/${templateId}`,
                explorerUrl: `https://explorer.jinn.network/templates/${templateId}`,
            };

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({ data: result, meta: { ok: true } })
                }]
            };
        }

        // Insert new template
        // Note: Ponder's onchainTable uses snake_case column names in PostgreSQL
        await client.query(`
            INSERT INTO job_template (
                id, name, description, tags, enabled_tools, blueprint_hash, blueprint,
                input_schema, output_spec, price_wei, price_usd, canonical_job_definition_id,
                run_count, success_count, avg_duration_seconds, avg_cost_wei,
                created_at, last_used_at, status
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12,
                $13, $14, $15, $16,
                $17, $18, $19
            )
        `, [
            templateId,
            name,
            description,
            tags || [],
            templateAvailableTools,
            blueprintHash,
            blueprint || null,
            inputSchema ? JSON.stringify(inputSchema) : null,
            outputSpec ? JSON.stringify(outputSpec) : null,
            priceWei,  // bigint as string
            priceUsd || null,
            canonicalJobDefinitionId || null,
            0,  // run_count
            0,  // success_count
            null,  // avg_duration_seconds
            null,  // avg_cost_wei
            now.toString(),  // created_at (bigint as string)
            null,  // last_used_at
            status,
        ]);

        mcpLogger.info({ templateId, name, status }, 'Registered new job template');

        const result = {
            templateId,
            action: 'created',
            status,
            marketplaceUrl: `${X402_GATEWAY_URL}/templates/${templateId}`,
            explorerUrl: `https://explorer.jinn.network/templates/${templateId}`,
            note: status === 'hidden'
                ? 'Template requires approval before becoming visible in marketplace'
                : 'Template is now visible in marketplace',
        };

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({ data: result, meta: { ok: true } })
            }]
        };

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLogger.error({ error: message }, 'register_template failed');
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message }
                })
            }]
        };
    } finally {
        try {
            await client.end();
        } catch {
            // Ignore close errors
        }
    }
}
