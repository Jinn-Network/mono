#!/usr/bin/env tsx
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

type JsonObject = Record<string, any>;

type TemplateRow = {
  id: string;
  name: string | null;
  slug: string | null;
  input_schema: JsonObject | null;
  blueprint: JsonObject | null;
};

type PatchResult = {
  next: JsonObject | null;
  changed: boolean;
  changes: string[];
  unknownEnvVars: string[];
};

const ENV_VAR_RENAMES: Record<string, string> = {
  UMAMI_WEBSITE_ID: 'JINN_JOB_UMAMI_WEBSITE_ID',
  BLOG_DOMAIN: 'JINN_JOB_BLOG_DOMAIN',
  BLOG_RAILWAY_PROJECT_ID: 'JINN_JOB_BLOG_RAILWAY_PROJECT_ID',
  TELEGRAM_CHAT_ID: 'JINN_JOB_TELEGRAM_CHAT_ID',
  TELEGRAM_TOPIC_ID: 'JINN_JOB_TELEGRAM_TOPIC_ID',
};

const REMOVED_ENV_VARS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'UMAMI_HOST',
  'UMAMI_USERNAME',
  'UMAMI_PASSWORD',
]);

function parseMode(argv: string[]): 'dry-run' | 'apply' {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');
  if (apply && dryRun) {
    throw new Error('Use exactly one mode: --dry-run or --apply');
  }
  return apply ? 'apply' : 'dry-run';
}

function patchInputSchema(schema: unknown, schemaPath: string): PatchResult {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { next: schema as JsonObject | null, changed: false, changes: [], unknownEnvVars: [] };
  }

  const next = structuredClone(schema as JsonObject);
  const properties = next.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return { next, changed: false, changes: [], unknownEnvVars: [] };
  }

  const changes: string[] = [];
  const unknownEnvVars: string[] = [];
  const requiredSet = new Set(Array.isArray(next.required) ? next.required.filter((v) => typeof v === 'string') : []);

  for (const [field, spec] of Object.entries(properties as Record<string, any>)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      continue;
    }
    const envVar = spec.envVar;
    if (typeof envVar !== 'string' || envVar.length === 0) {
      continue;
    }

    if (REMOVED_ENV_VARS.has(envVar)) {
      delete (properties as Record<string, unknown>)[field];
      if (requiredSet.delete(field)) {
        changes.push(`${schemaPath}.required removed "${field}"`);
      }
      changes.push(`${schemaPath}.properties.${field} removed (legacy envVar ${envVar})`);
      continue;
    }

    const renamed = ENV_VAR_RENAMES[envVar];
    if (renamed) {
      spec.envVar = renamed;
      changes.push(`${schemaPath}.properties.${field}.envVar: ${envVar} -> ${renamed}`);
      continue;
    }

    if (!envVar.startsWith('JINN_JOB_')) {
      unknownEnvVars.push(`${schemaPath}.properties.${field}.envVar=${envVar}`);
    }
  }

  if (Array.isArray(next.required)) {
    next.required = Array.from(requiredSet);
  }

  return { next, changed: changes.length > 0, changes, unknownEnvVars };
}

function patchTemplateRow(row: TemplateRow): {
  changed: boolean;
  nextInputSchema: JsonObject | null;
  nextBlueprint: JsonObject | null;
  changes: string[];
  unknownEnvVars: string[];
} {
  const changes: string[] = [];
  const unknownEnvVars: string[] = [];

  const inputSchemaResult = patchInputSchema(row.input_schema, 'input_schema');
  changes.push(...inputSchemaResult.changes);
  unknownEnvVars.push(...inputSchemaResult.unknownEnvVars);

  let nextBlueprint: JsonObject | null = row.blueprint ? structuredClone(row.blueprint) : row.blueprint;
  if (nextBlueprint && typeof nextBlueprint === 'object' && !Array.isArray(nextBlueprint)) {
    const templateMetaSchemaResult = patchInputSchema(
      nextBlueprint.templateMeta?.inputSchema,
      'blueprint.templateMeta.inputSchema',
    );
    if (templateMetaSchemaResult.changed) {
      nextBlueprint.templateMeta = nextBlueprint.templateMeta || {};
      nextBlueprint.templateMeta.inputSchema = templateMetaSchemaResult.next;
    }
    changes.push(...templateMetaSchemaResult.changes);
    unknownEnvVars.push(...templateMetaSchemaResult.unknownEnvVars);

    const rootSchemaResult = patchInputSchema(
      nextBlueprint.inputSchema,
      'blueprint.inputSchema',
    );
    if (rootSchemaResult.changed) {
      nextBlueprint.inputSchema = rootSchemaResult.next;
    }
    changes.push(...rootSchemaResult.changes);
    unknownEnvVars.push(...rootSchemaResult.unknownEnvVars);
  }

  return {
    changed: inputSchemaResult.changed || changes.length > 0,
    nextInputSchema: inputSchemaResult.next,
    nextBlueprint,
    changes,
    unknownEnvVars,
  };
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  const { data, error } = await supabase
    .from('templates')
    .select('id,name,slug,input_schema,blueprint');

  if (error) {
    throw new Error(`Failed to fetch templates: ${error.message}`);
  }

  const templates = (data || []) as TemplateRow[];
  const changedRows: Array<{
    row: TemplateRow;
    nextInputSchema: JsonObject | null;
    nextBlueprint: JsonObject | null;
    changes: string[];
    unknownEnvVars: string[];
  }> = [];
  const unknowns: Array<{ id: string; slug: string | null; entries: string[] }> = [];

  for (const row of templates) {
    const patched = patchTemplateRow(row);
    if (patched.unknownEnvVars.length > 0) {
      unknowns.push({ id: row.id, slug: row.slug, entries: patched.unknownEnvVars });
    }
    if (patched.changed) {
      changedRows.push({
        row,
        nextInputSchema: patched.nextInputSchema,
        nextBlueprint: patched.nextBlueprint,
        changes: patched.changes,
        unknownEnvVars: patched.unknownEnvVars,
      });
    }
  }

  console.log(`Mode: ${mode}`);
  console.log(`Templates scanned: ${templates.length}`);
  console.log(`Templates with changes: ${changedRows.length}`);
  console.log(`Templates with unknown envVars: ${unknowns.length}`);

  for (const entry of changedRows) {
    const label = entry.row.slug || entry.row.name || entry.row.id;
    console.log(`\n- ${label} (${entry.row.id})`);
    for (const change of entry.changes) {
      console.log(`  * ${change}`);
    }
    for (const unknown of entry.unknownEnvVars) {
      console.log(`  ! unknown: ${unknown}`);
    }
  }

  if (unknowns.length > 0) {
    throw new Error('Unknown non-JINN_JOB envVar mappings found. Resolve manually before apply.');
  }

  if (mode === 'dry-run') {
    console.log('\nDry run complete. No database updates applied.');
    return;
  }

  let updatedCount = 0;
  for (const entry of changedRows) {
    const { error: updateError } = await supabase
      .from('templates')
      .update({
        input_schema: entry.nextInputSchema,
        blueprint: entry.nextBlueprint,
      })
      .eq('id', entry.row.id);

    if (updateError) {
      throw new Error(`Failed to update template ${entry.row.id}: ${updateError.message}`);
    }
    updatedCount += 1;
  }

  console.log(`\nApply complete. Updated templates: ${updatedCount}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
