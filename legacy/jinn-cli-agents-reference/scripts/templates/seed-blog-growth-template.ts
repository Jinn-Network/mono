#!/usr/bin/env tsx
/**
 * Seed Blog Growth Template
 *
 * Registers the blog-growth template in the job_template table.
 * Run after Ponder is running and the table exists.
 *
 * Usage:
 *   yarn tsx scripts/templates/seed-blog-growth-template.ts
 *   yarn tsx scripts/templates/seed-blog-growth-template.ts --dry-run
 */

// @ts-ignore - pg package exists
import { Client } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { parseAnnotatedTools } from 'jinn-node/shared/template-tools.js';

dotenv.config();

const TEMPLATE_FILE = join(process.cwd(), 'blueprints', 'blog-growth-template.json');

function getPonderDatabaseUrl(): string | null {
    const candidates = [
        process.env.PONDER_DATABASE_URL,
        process.env.SUPABASE_POSTGRES_URL,
        process.env.DATABASE_URL,
    ];
    return candidates.find((url) => typeof url === 'string' && url.length > 0) || null;
}

/**
 * Discovers the active Ponder schema by finding the schema with the most recent
 * checkpoint. Ponder creates schemas named after Railway deployment IDs (UUIDs).
 */
async function discoverActiveSchema(client: Client): Promise<string | null> {
    // Find all schemas that have the job_template table
    const schemasResult = await client.query(`
        SELECT schemaname FROM pg_tables
        WHERE tablename = 'job_template'
        AND schemaname LIKE '%-%-%-%-%'
        ORDER BY schemaname
    `);

    if (schemasResult.rows.length === 0) {
        console.error('No schemas found with job_template table');
        return null;
    }

    console.log(`Found ${schemasResult.rows.length} Ponder schemas with job_template table`);

    // Find the schema with the most recent checkpoint
    // This indicates the currently active Ponder deployment
    let activeSchema: string | null = null;
    let latestCheckpoint = BigInt(0);

    for (const row of schemasResult.rows) {
        const schemaName = row.schemaname;
        try {
            const checkpointResult = await client.query(`
                SELECT latest_checkpoint FROM "${schemaName}"._ponder_checkpoint
                WHERE latest_checkpoint IS NOT NULL
                ORDER BY latest_checkpoint DESC LIMIT 1
            `);
            if (checkpointResult.rows.length > 0) {
                // latest_checkpoint is a large numeric string
                const checkpoint = BigInt(checkpointResult.rows[0].latest_checkpoint);
                if (checkpoint > latestCheckpoint) {
                    latestCheckpoint = checkpoint;
                    activeSchema = schemaName;
                }
            }
        } catch (err) {
            // Schema might not have checkpoint table, skip
            console.log(`  Skipping schema ${schemaName}: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
    }

    if (activeSchema) {
        console.log(`Active Ponder schema: ${activeSchema}`);
    }

    return activeSchema;
}

function computeBlueprintHash(blueprint: string): string {
    let hash = 0;
    for (let i = 0; i < blueprint.length; i++) {
        const char = blueprint.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'bph_' + Math.abs(hash).toString(16).padStart(8, '0');
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');

    console.log('Loading template from:', TEMPLATE_FILE);
    const templateJson = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf-8'));

    const { templateMeta, invariants, context } = templateJson;

    // Extract blueprint (invariants + context) for storage
    const blueprint = JSON.stringify({ invariants, context });
    const blueprintHash = computeBlueprintHash(blueprint);

    const toolPolicy = parseAnnotatedTools(templateMeta.tools);

    const template = {
        id: templateMeta.id,
        name: templateMeta.name,
        description: templateMeta.description,
        tags: ['blog', 'growth', 'content', 'autonomous'],
        enabledTools: toolPolicy.availableTools,
        blueprintHash,
        blueprint,
        inputSchema: templateMeta.inputSchema,
        outputSpec: null, // Not defined yet
        priceWei: templateMeta.priceWei || '0',
        priceUsd: '$0.00', // Free for testing
        canonicalJobDefinitionId: null,
        runCount: 0,
        successCount: 0,
        avgDurationSeconds: null,
        avgCostWei: null,
        createdAt: Math.floor(Date.now() / 1000).toString(),
        lastUsedAt: null,
        status: 'visible',
    };

    console.log('\nTemplate to seed:');
    console.log('  ID:', template.id);
    console.log('  Name:', template.name);
    console.log('  Price:', template.priceUsd);
    console.log('  Tools:', template.enabledTools.length);
    console.log('  Blueprint hash:', blueprintHash);

    if (dryRun) {
        console.log('\n[DRY RUN] Would insert template into job_template table');
        console.log('\nInputSchema:');
        console.log(JSON.stringify(templateMeta.inputSchema, null, 2));
        return;
    }

    const dbUrl = getPonderDatabaseUrl();
    if (!dbUrl) {
        console.error('No database URL found. Set PONDER_DATABASE_URL or DATABASE_URL');
        process.exit(1);
    }

    const client = new Client({ connectionString: dbUrl });
    client.on('error', (err: Error) => {
        console.warn('PG Client error (suppressed):', err.message);
    });

    try {
        await client.connect();

        // Discover the active Ponder schema (dynamically find the current deployment's schema)
        const activeSchema = await discoverActiveSchema(client);
        if (!activeSchema) {
            console.error('Could not discover active Ponder schema. Is Ponder running?');
            process.exit(1);
        }

        // Disable triggers temporarily (Ponder's live_query_trigger depends on runtime tables)
        await client.query(`ALTER TABLE "${activeSchema}".job_template DISABLE TRIGGER live_query_trigger`);
        await client.query(`ALTER TABLE "${activeSchema}".job_template DISABLE TRIGGER reorg_trigger`);

        try {
            // Upsert template using the discovered schema
            const upsertQuery = `
                INSERT INTO "${activeSchema}".job_template (
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
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    description = EXCLUDED.description,
                    tags = EXCLUDED.tags,
                    enabled_tools = EXCLUDED.enabled_tools,
                    blueprint_hash = EXCLUDED.blueprint_hash,
                    blueprint = EXCLUDED.blueprint,
                    input_schema = EXCLUDED.input_schema,
                    price_wei = EXCLUDED.price_wei,
                    price_usd = EXCLUDED.price_usd,
                    status = EXCLUDED.status
            `;

            await client.query(upsertQuery, [
                template.id,
                template.name,
                template.description,
                template.tags,
                template.enabledTools,
                template.blueprintHash,
                template.blueprint,
                JSON.stringify(template.inputSchema),
                template.outputSpec,
                template.priceWei,
                template.priceUsd,
                template.canonicalJobDefinitionId,
                template.runCount,
                template.successCount,
                template.avgDurationSeconds,
                template.avgCostWei,
                template.createdAt,
                template.lastUsedAt,
                template.status,
            ]);

            console.log('\n✅ Template seeded successfully!');
            console.log(`   View at: https://explorer.jinn.network/templates/${template.id}`);
        } finally {
            // Re-enable triggers
            await client.query(`ALTER TABLE "${activeSchema}".job_template ENABLE TRIGGER live_query_trigger`);
            await client.query(`ALTER TABLE "${activeSchema}".job_template ENABLE TRIGGER reorg_trigger`);
        }

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to seed template:', message);
        process.exit(1);
    } finally {
        try {
            await client.end();
        } catch {
            // Ignore close errors
        }
    }
}

main();
