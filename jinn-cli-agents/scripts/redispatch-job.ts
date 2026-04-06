#!/usr/bin/env tsx
/**
 * Re-dispatch a failed or completed job by jobId or jobName
 *
 * Usage: tsx scripts/redispatch-job.ts --jobId <uuid> [--message "optional message"] [--workstreamId <0x...>]
 *        tsx scripts/redispatch-job.ts --jobName <name> [--message "optional message"] [--workstreamId <0x...>]
 *
 * To update invariants on the fly (relaunch with new config):
 *        tsx scripts/redispatch-job.ts --jobName <name> --input configs/longevity.json --template blueprints/blog-growth-template.json --cyclic
 *
 * Options:
 *   --jobId <uuid>         Job definition UUID to re-dispatch
 *   --jobName <name>       Job name to re-dispatch (alternative to --jobId)
 *   --message <msg>        Optional message to include with dispatch
 *   --workstreamId <0x...> Keep dispatch in existing workstream
 *   --cyclic               Enable continuous operation (auto-redispatch after completion)
 *   --input <path>         Path to input config JSON for variable substitution
 *   --template <path>      Path to blueprint template JSON (required with --input)
 */

import 'jinn-node/env/index.js';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';
import { graphQLRequest } from 'jinn-node/http/client.js';
import { getPonderGraphqlUrl } from 'jinn-node/agent/mcp/tools/shared/env.js';
import { buildIpfsPayload } from 'jinn-node/agent/shared/ipfs-payload-builder.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { getMechAddress, getMechChainConfig, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import { deepSubstitute, loadInputConfig } from './shared/template-substitution.js';
import { validateInvariantsStrict } from 'jinn-node/worker/prompt/invariant-validator.js';
import { extractToolPolicyFromBlueprint } from 'jinn-node/shared/template-tools.js';
import { getRandomStakedMech } from 'jinn-node/worker/filters/stakingFilter.js';
import { assertValidJinnJobEnvKey } from 'jinn-node/shared/job-env.js';

const args = process.argv.slice(2);
const jobIdIndex = args.indexOf('--jobId');
const jobNameIndex = args.indexOf('--jobName');
const messageIndex = args.indexOf('--message');
const workstreamIdIndex = args.indexOf('--workstreamId');
const cyclicIndex = args.indexOf('--cyclic');
const inputIndex = args.indexOf('--input');
const templateIndex = args.indexOf('--template');
const ventureIdIndex = args.indexOf('--ventureId');
const templateIdIndex = args.indexOf('--templateId');

let jobId: string | undefined;
let jobName: string | undefined;
let message: string | undefined;
let workstreamId: string | undefined;
let cyclic = false;
let inputConfigPath: string | undefined;
let templatePath: string | undefined;
let ventureId: string | undefined;
let templateId: string | undefined;

if (jobIdIndex !== -1 && args[jobIdIndex + 1]) {
  jobId = args[jobIdIndex + 1];
}

if (jobNameIndex !== -1 && args[jobNameIndex + 1]) {
  jobName = args[jobNameIndex + 1];
}

if (messageIndex !== -1 && args[messageIndex + 1]) {
  message = args[messageIndex + 1];
}

if (workstreamIdIndex !== -1 && args[workstreamIdIndex + 1]) {
  workstreamId = args[workstreamIdIndex + 1];
}

if (cyclicIndex !== -1) {
  cyclic = true;
}

if (inputIndex !== -1 && args[inputIndex + 1]) {
  inputConfigPath = args[inputIndex + 1];
}

if (templateIndex !== -1 && args[templateIndex + 1]) {
  templatePath = args[templateIndex + 1];
}

if (ventureIdIndex !== -1 && args[ventureIdIndex + 1]) {
  ventureId = args[ventureIdIndex + 1];
}

if (templateIdIndex !== -1 && args[templateIdIndex + 1]) {
  templateId = args[templateIdIndex + 1];
}

// Validate input/template pairing
if (inputConfigPath && !templatePath) {
  console.error('Error: --input requires --template to specify the blueprint template');
  process.exit(1);
}

if (!jobId && !jobName) {
  console.error('Error: Must provide either --jobId or --jobName');
  console.error('Usage: tsx scripts/redispatch-job.ts --jobId <uuid> [--message "optional message"] [--workstreamId <0x...>] [--cyclic]');
  console.error('       tsx scripts/redispatch-job.ts --jobName <name> [--message "optional message"] [--workstreamId <0x...>] [--cyclic]');
  console.error('');
  console.error('To update invariants on the fly:');
  console.error('       tsx scripts/redispatch-job.ts --jobName <name> --input <config.json> --template <blueprint.json> [--cyclic]');
  process.exit(1);
}

/**
 * Load and substitute a blueprint template with input config values.
 * Returns the final blueprint JSON string ready for dispatch.
 */
async function buildSubstitutedBlueprint(templatePath: string, inputConfigPath: string): Promise<{
  blueprint: string;
  enabledTools: string[];
  workspaceRepoUrl?: string;
  extractedEnv?: Record<string, string>;
}> {
  // Load template
  let resolvedTemplatePath = templatePath;
  if (!templatePath.includes('/')) {
    resolvedTemplatePath = join(process.cwd(), 'blueprints', templatePath.endsWith('.json') ? templatePath : `${templatePath}.json`);
  } else {
    resolvedTemplatePath = resolve(process.cwd(), templatePath);
  }

  const templateContent = await readFile(resolvedTemplatePath, 'utf-8');
  let blueprintObj = JSON.parse(templateContent);

  // Load input config
  const inputConfig = await loadInputConfig(inputConfigPath);
  console.log(`  Loaded input config: ${Object.keys(inputConfig).join(', ')}`);
  const workspaceRepoUrl = typeof (inputConfig as any).repoUrl === 'string'
    ? String((inputConfig as any).repoUrl)
    : undefined;

  // Get inputSchema from template (can be at root or in templateMeta)
  const inputSchema = blueprintObj.templateMeta?.inputSchema ?? blueprintObj.inputSchema;

  // Apply variable substitution
  blueprintObj = deepSubstitute(blueprintObj, inputConfig, inputSchema);
  console.log('  Variable substitution applied');

  // Validate invariants
  const invariants = blueprintObj.invariants || blueprintObj.assertions || [];
  if (invariants.length > 0) {
    console.log(`  Validating ${invariants.length} invariants...`);
    validateInvariantsStrict(invariants);
    console.log('  Invariants valid');
  }

  // Extract tool policy
  const { requiredTools, availableTools } = extractToolPolicyFromBlueprint(blueprintObj);
  const enabledTools = requiredTools.length > 0
    ? requiredTools
    : (availableTools.length > 0 ? availableTools : [
      'google_web_search',
      'create_artifact',
      'write_file',
      'read_file',
      'replace',
      'list_directory',
      'run_shell_command',
      'dispatch_new_job',
    ]);

  // Extract env vars from inputConfig using inputSchema.envVar mappings
  // (mirrors launch_workstream.ts logic)
  let extractedEnv: Record<string, string> | undefined;
  if (inputSchema?.properties) {
    const env: Record<string, string> = {};
    for (const [field, spec] of Object.entries(inputSchema.properties)) {
      const fieldSpec = spec as { envVar?: string };
      if (fieldSpec.envVar && inputConfig[field] !== undefined) {
        assertValidJinnJobEnvKey(fieldSpec.envVar, `inputSchema.properties.${field}.envVar`);
        env[fieldSpec.envVar] = String(inputConfig[field]);
      }
    }
    if (Object.keys(env).length > 0) {
      extractedEnv = env;
      console.log(`  Extracted ${Object.keys(env).length} env vars from inputConfig`);
    }
  }

  // Build clean blueprint (strip template metadata)
  const cleanBlueprint: Record<string, unknown> = {
    invariants: blueprintObj.invariants || blueprintObj.assertions || [],
    context: blueprintObj.context,
  };
  if (blueprintObj.outputSpec) {
    cleanBlueprint.outputSpec = blueprintObj.outputSpec;
  }

  return {
    blueprint: JSON.stringify(cleanBlueprint),
    enabledTools,
    workspaceRepoUrl,
    extractedEnv,
  };
}

async function main() {
  console.log('Re-dispatching job...');
  console.log(`  jobId: ${jobId || 'N/A'}`);
  console.log(`  jobName: ${jobName || 'N/A'}`);
  if (message) console.log(`  message: ${message}`);
  if (workstreamId) console.log(`  workstreamId: ${workstreamId}`);
  if (cyclic) console.log('  cyclic: true');
  if (inputConfigPath) console.log(`  input: ${inputConfigPath}`);
  if (templatePath) console.log(`  template: ${templatePath}`);

  // If --input provided, build substituted blueprint
  let overrideBlueprint: string | undefined;
  let overrideEnabledTools: string[] | undefined;
  let workspaceRepoUrl: string | undefined;
  let extractedEnv: Record<string, string> | undefined;
  if (inputConfigPath && templatePath) {
    console.log('\nBuilding substituted blueprint...');
    const result = await buildSubstitutedBlueprint(templatePath, inputConfigPath);
    overrideBlueprint = result.blueprint;
    overrideEnabledTools = result.enabledTools;
    workspaceRepoUrl = result.workspaceRepoUrl;
    extractedEnv = result.extractedEnv;
    console.log('  Blueprint ready for dispatch\n');
  }

  let result: any;
  if (!cyclic) {
    // Non-cyclic: use dispatchExistingJob which supports blueprint override
    result = await dispatchExistingJob({
      jobId,
      jobName,
      message,
      workstreamId,
      blueprint: overrideBlueprint,
      ...(extractedEnv ? { additionalContext: { env: extractedEnv } } : {}),
    });
  } else {
    // Cyclic: need to fetch job def and dispatch directly
    const ponderUrl = getPonderGraphqlUrl();
    let jobDef: any | null = null;
    if (jobId) {
      const response = await graphQLRequest<{
        jobDefinition: {
          id: string;
          name: string;
          enabledTools?: string[];
          blueprint?: string;
          codeMetadata?: any;
        } | null;
      }>({
        url: ponderUrl,
        query: `query($id: String!) { jobDefinition(id: $id) { id name enabledTools blueprint codeMetadata } }`,
        variables: { id: jobId },
        maxRetries: 1,
        context: { operation: 'getJobById', jobId },
      });
      jobDef = response?.jobDefinition || null;
    } else if (jobName) {
      const response = await graphQLRequest<{
        jobDefinitions: { items: Array<{ id: string; name: string; enabledTools?: string[]; blueprint?: string; codeMetadata?: any; }>; };
      }>({
        url: ponderUrl,
        query: `query($name: String!) { jobDefinitions(where: { name: $name }, limit: 1) { items { id name enabledTools blueprint codeMetadata } } }`,
        variables: { name: jobName },
        maxRetries: 1,
        context: { operation: 'getJobByName', jobName },
      });
      jobDef = response?.jobDefinitions?.items?.[0] || null;
    }

    if (!jobDef) {
      if (overrideBlueprint && jobId) {
        console.warn(`Job definition '${jobName || jobId}' not found in Ponder; using override blueprint/tools.`);
        jobDef = {
          id: jobId,
          name: jobName || jobId,
          enabledTools: overrideEnabledTools,
          blueprint: overrideBlueprint,
          codeMetadata: undefined,
        };
      } else {
        console.error(`Job definition '${jobName || jobId}' not found in Ponder.`);
        process.exit(1);
      }
    }

    const jobDefinitionId = jobDef.id;
    // Use override tools if provided, otherwise fall back to job def tools
    const enabledTools = overrideEnabledTools || (Array.isArray(jobDef.enabledTools) ? jobDef.enabledTools : []);
    // Use override blueprint if provided, otherwise use existing blueprint
    const blueprint = overrideBlueprint || (typeof jobDef.blueprint === 'string' ? jobDef.blueprint : undefined);

    if (!blueprint) {
      console.error('Job definition has no blueprint and no --input/--template provided; cannot redispatch.');
      process.exit(1);
    }

    const additionalContextOverrides: Record<string, any> | undefined =
      workspaceRepoUrl || message || extractedEnv
        ? {
          ...(extractedEnv ? { env: extractedEnv } : {}),
          ...(workspaceRepoUrl ? { workspaceRepo: { url: workspaceRepoUrl } } : {}),
          ...(message ? { message: { content: message, to: jobDefinitionId } } : {}),
        }
        : undefined;

    const { ipfsJsonContents } = await buildIpfsPayload({
      blueprint,
      jobName: jobDef.name,
      jobDefinitionId,
      enabledTools,
      model: undefined,
      tools: undefined,
      cyclic: true,
      additionalContextOverrides,
      workstreamId,
      codeMetadata: jobDef.codeMetadata,
      ventureId,
      templateId,
    } as any);

    const mechAddress = getMechAddress();
    const chainConfig = getMechChainConfig();
    const privateKey = getServicePrivateKey();
    if (!mechAddress || !privateKey) {
      throw new Error('Mech config missing (MECH address/private key).');
    }

    const priorityMech = await getRandomStakedMech(mechAddress);
    const dispatchResult = await marketplaceInteract({
      prompts: [blueprint],
      priorityMech,
      tools: enabledTools,
      ipfsJsonContents,
      chainConfig,
      keyConfig: { source: 'value', value: privateKey },
      postOnly: true,
      responseTimeout: 61,
    });

    result = {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ data: dispatchResult, meta: { ok: true } }),
      }],
    };
  }

  console.log('\nResult:');
  if (result.content && result.content[0] && result.content[0].type === 'text') {
    const parsed = JSON.parse(result.content[0].text);
    console.log(JSON.stringify(parsed, null, 2));

    if (parsed.meta?.ok) {
      console.log('\n✓ Job dispatched successfully!');
      if (parsed.data?.request_ids) {
        console.log(`Request IDs: ${parsed.data.request_ids.join(', ')}`);
      }
    } else {
      console.error('\n✗ Job dispatch failed');
      console.error(`Code: ${parsed.meta?.code}`);
      console.error(`Message: ${parsed.meta?.message}`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
