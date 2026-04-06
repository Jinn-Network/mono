#!/usr/bin/env tsx
// @ts-nocheck
/**
 * x402 Execute Template - Dispatch a job template via local mech-client
 * 
 * Bypasses the x402-gateway's Railway deployment issues by dispatching directly
 * using credentials from the .operate profile.
 * 
 * Usage:
 *   yarn x402:execute ethereum-daily-research-6942e7fd
 *   yarn x402:execute ethereum-daily-research-6942e7fd --input '{"date": "2025-12-15"}'
 *   yarn x402:execute --list  # List available templates
 *   yarn x402:execute --dry-run ethereum-daily-research-6942e7fd
 * 
 * Options:
 *   --input         JSON input parameters for the template
 *   --context       Additional context string
 *   --list          List available templates
 *   --dry-run       Show what would be dispatched without executing
 */

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getServiceProfile } from 'jinn-node/env/operate-profile.js';
import { scriptLogger } from 'jinn-node/logging';

const PONDER_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
const CHAIN_CONFIG = process.env.CHAIN_CONFIG || 'base';

interface PonderJobTemplate {
  id: string;
  name: string;
  description: string | null;
  tags: string[] | null;
  enabledTools: string[] | null;
  blueprint: string | null;
  inputSchema: Record<string, any> | null;
  outputSpec: Record<string, any> | null;
  priceWei: string | null;
  canonicalJobDefinitionId: string | null;
  runCount: number;
  successCount: number;
  status: string;
}

async function queryPonder(query: string, variables?: Record<string, any>): Promise<any> {
  const res = await fetch(PONDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Ponder query failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { data?: any; errors?: any[] };
  if (json.errors?.length) {
    throw new Error(`Ponder query error: ${json.errors[0].message}`);
  }

  return json.data;
}

async function listTemplates(): Promise<PonderJobTemplate[]> {
  const query = `
    query ListTemplates {
      jobTemplates(where: { status: "visible" }, orderBy: "runCount", orderDirection: "desc", limit: 20) {
        items {
          id
          name
          description
          tags
          runCount
          successCount
          status
        }
      }
    }
  `;

  const data = await queryPonder(query);
  return data?.jobTemplates?.items || [];
}

async function fetchTemplate(templateId: string): Promise<PonderJobTemplate | null> {
  const query = `
    query GetTemplate($id: String!) {
      jobTemplate(id: $id) {
        id
        name
        description
        tags
        enabledTools
        blueprint
        inputSchema
        outputSpec
        priceWei
        canonicalJobDefinitionId
        runCount
        successCount
        status
      }
    }
  `;

  const data = await queryPonder(query, { id: templateId });
  return data?.jobTemplate || null;
}

/**
 * Substitute {{variable}} placeholders in a string with input values.
 * Falls back to defaults from inputSchema if available.
 */
function substituteVariables(
  text: string,
  input: Record<string, any>,
  inputSchema?: Record<string, any>
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    // Check input first
    if (input[varName] !== undefined) {
      return String(input[varName]);
    }
    // Fall back to default from schema
    const schemaProp = inputSchema?.properties?.[varName];
    if (schemaProp?.default !== undefined) {
      return String(schemaProp.default);
    }
    // Keep placeholder if no value found (agent will see it as-is)
    scriptLogger.warn({ varName }, 'No value found for template variable');
    return match;
  });
}

/**
 * Deep substitute variables in an object (recursively processes strings).
 */
function deepSubstitute(
  obj: any,
  input: Record<string, any>,
  inputSchema?: Record<string, any>
): any {
  if (typeof obj === 'string') {
    return substituteVariables(obj, input, inputSchema);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => deepSubstitute(item, input, inputSchema));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepSubstitute(value, input, inputSchema);
    }
    return result;
  }
  return obj;
}

function buildBlueprint(
  template: PonderJobTemplate,
  input: Record<string, any>,
  additionalContext?: string
): { invariants: any[]; context: string } {
  // If template has a stored blueprint, parse and use it
  if (template.blueprint) {
    try {
      const storedBlueprint = JSON.parse(template.blueprint);

      // Get invariants (support both 'invariants' and legacy 'assertions')
      const rawInvariants = storedBlueprint.invariants || storedBlueprint.assertions || [];

      // Substitute {{variables}} with input values
      const invariants = deepSubstitute(rawInvariants, input, template.inputSchema || undefined);

      const context = [
        substituteVariables(storedBlueprint.context || '', input, template.inputSchema || undefined),
        '',
        '## Input Parameters',
        JSON.stringify(input, null, 2),
        '',
        additionalContext ? `## Additional Context\n${additionalContext}` : '',
      ].filter(Boolean).join('\n');

      return {
        invariants,
        context,
      };
    } catch (parseError) {
      scriptLogger.warn({ err: parseError }, 'Failed to parse stored blueprint, using generic');
    }
  }

  // Fallback: Generate generic blueprint
  const context = [
    `## Template: ${template.name}`,
    template.description || '',
    '',
    '## Input Parameters',
    JSON.stringify(input, null, 2),
    '',
    additionalContext ? `## Additional Context\n${additionalContext}` : '',
  ].filter(Boolean).join('\n');

  return {
    invariants: [
      {
        id: 'TEMPLATE-001',
        form: 'directive',
        description: `Execute the ${template.name} template with the provided input parameters.`,
        examples: {
          do: ['Follow the template\'s intended purpose', 'Use provided input parameters'],
          dont: ['Deviate from template scope', 'Ignore input parameters']
        },
        commentary: 'Template execution should be deterministic and follow the defined contract.'
      },
      {
        id: 'OUTPUT-001',
        form: 'constraint',
        description: 'Produce output conforming to the template\'s output specification.',
        examples: {
          do: ['Include all required output fields', 'Format output as specified'],
          dont: ['Omit required fields', 'Return unstructured data']
        },
        commentary: 'Output determinism enables reliable downstream consumption.'
      }
    ],
    context,
  };
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .command('$0 [templateId]', 'Execute a job template', (yargs) => {
      return yargs.positional('templateId', {
        type: 'string',
        description: 'Template ID to execute',
      });
    })
    .option('input', { type: 'string', description: 'JSON input parameters' })
    .option('context', { type: 'string', description: 'Additional context' })
    .option('list', { type: 'boolean', description: 'List available templates' })
    .option('dry-run', { type: 'boolean', description: 'Show without executing' })
    .help()
    .parse();

  // List mode
  if (argv.list) {
    const templates = await listTemplates();
    console.log('\nAvailable Templates (top 20 by usage):\n');
    for (const t of templates) {
      console.log(`  ${t.id}`);
      console.log(`    Name: ${t.name}`);
      console.log(`    Runs: ${t.runCount} (${t.successCount} successful)`);
      if (t.description) console.log(`    Desc: ${t.description.slice(0, 60)}...`);
      console.log();
    }
    return;
  }

  // Require templateId for execution
  if (!argv.templateId) {
    console.error('Error: templateId is required. Use --list to see available templates.');
    process.exit(1);
  }

  // Get credentials from operate-profile
  const profile = getServiceProfile();

  if (!profile.privateKey) {
    scriptLogger.error('No private key found in operate-profile. Run setup:service first.');
    process.exit(1);
  }

  if (!profile.mechAddress) {
    scriptLogger.error('No mech address found in operate-profile.');
    process.exit(1);
  }

  scriptLogger.info({
    mechAddress: profile.mechAddress,
    chainConfig: profile.chainConfig,
  }, 'Using operate-profile credentials');

  // Fetch template
  const template = await fetchTemplate(argv.templateId!);
  if (!template) {
    console.error(`Template not found: ${argv.templateId}`);
    process.exit(1);
  }

  scriptLogger.info({
    templateId: template.id,
    name: template.name,
    runCount: template.runCount,
  }, 'Found template');

  // Parse input
  let input: Record<string, any> = {};
  if (argv.input) {
    try {
      input = JSON.parse(argv.input);
    } catch {
      console.error('Invalid JSON in --input');
      process.exit(1);
    }
  }

  // Inject system-provided context variables
  // currentTimestamp: ISO timestamp at dispatch time (for explicit time calculations)
  input.currentTimestamp = new Date().toISOString();

  // Build blueprint
  const blueprint = buildBlueprint(template, input, argv.context as string | undefined);

  if (argv.dryRun) {
    console.log('\n=== DRY RUN ===\n');
    console.log('Template:', template.name);
    console.log('Input:', JSON.stringify(input, null, 2));
    console.log('Invariants:', blueprint.invariants.length);
    console.log('Context preview:', blueprint.context.slice(0, 200) + '...');
    console.log('\nWould dispatch to mech:', profile.mechAddress);
    return;
  }

  // Dispatch
  const jobDefinitionId = crypto.randomUUID();
  const { marketplaceInteract } = await import('@jinn-network/mech-client-ts/dist/marketplace_interact.js');

  scriptLogger.info({ jobDefinitionId }, 'Dispatching template job...');

  try {
    const result = await marketplaceInteract({
      prompts: [JSON.stringify(blueprint)],
      priorityMech: profile.mechAddress,
      tools: template.enabledTools || [],
      ipfsJsonContents: [{
        blueprint: JSON.stringify(blueprint),
        jobName: `${template.name} (via x402)`,
        model: 'gemini-2.5-flash',
        jobDefinitionId,
        nonce: crypto.randomUUID(),
        templateId: template.id,
        templateVersion: '1.0.0',
        networkId: 'jinn',
      }],
      chainConfig: profile.chainConfig || CHAIN_CONFIG,
      keyConfig: { source: 'value', value: profile.privateKey },
      postOnly: true,
      responseTimeout: 61,
    });

    if (!result?.request_ids?.[0]) {
      throw new Error('Dispatch failed: no request ID');
    }

    const requestId = result.request_ids[0];

    console.log('\n✅ Template dispatched!');
    console.log(`   Request ID: ${requestId}`);
    console.log(`   Job Definition: ${jobDefinitionId}`);
    console.log(`   Template: ${template.name}`);
    console.log(`\n   Run worker: yarn dev:mech --workstream=${requestId} --single`);
    console.log(`   Explorer: https://indexer.jinn.network/requests/${requestId}`);

  } catch (e: any) {
    scriptLogger.error({ err: e }, 'Dispatch failed');
    console.error(`\n❌ Dispatch failed: ${e.message}`);
    process.exit(1);
  }
}

main();
