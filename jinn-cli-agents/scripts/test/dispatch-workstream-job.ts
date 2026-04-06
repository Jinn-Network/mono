#!/usr/bin/env npx tsx
/**
 * Dispatch a test job within a specific workstream on a Tenderly VNet.
 *
 * Uses the SAME production code path as redispatch-job.ts:
 *   buildIpfsPayload() → marketplaceInteract() → pushJsonToIpfs()
 *
 * This ensures the IPFS metadata structure matches production exactly,
 * so the worker's BlueprintBuilder correctly extracts the task from
 * blueprint invariants.
 *
 * Usage:
 *   yarn test:e2e:dispatch --workstream <id> --cwd <jinn-node-clone>
 *   yarn test:e2e:dispatch --workstream <id> --cwd <path> --blueprint-file blueprints/my-test.json
 *   yarn test:e2e:dispatch --workstream <id> --cwd <path> --blueprint '{"invariants":[...]}'
 *   yarn test:e2e:dispatch --workstream <id> --cwd <path> --job-def-id <uuid>
 *
 * Flags:
 *   --workstream <id>           Required. Workstream hash.
 *   --cwd <path>                Required. Path to jinn-node clone.
 *   --job-name <name>           Job name (default: e2e-test-job).
 *   --job-def-id <uuid>         Job definition ID (default: random UUID).
 *   --blueprint-file <path>     Load blueprint from JSON file. Tools extracted automatically.
 *   --blueprint <json>          Blueprint JSON string (overrides --blueprint-file).
 *   --enabled-tools <csv>       Comma-separated tool names (overrides blueprint-extracted tools).
 *   --input <path>              JSON input file used with blueprint inputSchema/envVar mappings.
 *   --allow-stale               Allow dispatch even if workstream has undelivered stale requests.
 *
 * Default (no --blueprint or --blueprint-file):
 *   Loads blueprints/e2e-infrastructure-test.json which tests web search, artifacts,
 *   measurements, credential-dependent tools (venture_query), and delegation.
 *
 * Requires:
 *   - OPERATE_PASSWORD env var (for agent key decryption)
 *   - RPC_URL env var or .env.e2e file
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildIpfsPayload } from 'jinn-node/agent/shared/ipfs-payload-builder.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { getMechAddress, getMechChainConfig, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import { assertValidJinnJobEnvKey } from 'jinn-node/shared/job-env.js';
import { extractToolPolicyFromBlueprint } from 'jinn-node/shared/template-tools.js';
import { runHardPreflightGate } from './e2e-harness.js';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MONOREPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const E2E_ENV_FILE = resolve(MONOREPO_ROOT, '.env.e2e');
const DEFAULT_BLUEPRINT_FILE = resolve(MONOREPO_ROOT, 'blueprints', 'e2e-infrastructure-test.json');
const E2E_LOCAL_PONDER_URL = 'http://localhost:42069/graphql';
const E2E_LOCAL_CONTROL_URL = 'http://localhost:4001/graphql';

// Load env files in priority order (later overrides earlier):
// 1. .env — base monorepo creds
// 2. .env.test — Tenderly creds
// 3. .env.e2e — VNet RPC_URL (highest priority)
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });
dotenv.config({ path: E2E_ENV_FILE, override: true, quiet: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const [key, val] = args[i].split('=');
      if (val !== undefined) {
        flags[key.slice(2)] = val;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key.slice(2)] = args[++i];
      } else {
        flags[key.slice(2)] = 'true';
      }
    }
  }
  return flags;
}

/**
 * Load a blueprint from a JSON file. Returns the parsed object and the
 * stringified blueprint payload (invariants + context only, no template metadata).
 */
function loadBlueprintFile(filePath: string): { blueprintObj: any; blueprintPayload: string; enabledTools: string[] } {
  const raw = readFileSync(filePath, 'utf-8');
  const blueprintObj = JSON.parse(raw);

  // Extract tools from blueprint (same logic as launch_workstream.ts)
  const { requiredTools, availableTools } = extractToolPolicyFromBlueprint(blueprintObj);
  const enabledTools = requiredTools.length > 0
    ? requiredTools
    : (availableTools.length > 0
      ? availableTools
      : (blueprintObj.enabledTools || ['google_web_search', 'web_fetch', 'create_artifact']));

  // Build the payload the worker will see (invariants + context, no template metadata)
  const cleanBlueprint: Record<string, unknown> = {
    invariants: blueprintObj.invariants || blueprintObj.assertions || [],
  };
  if (blueprintObj.context) {
    cleanBlueprint.context = blueprintObj.context;
  }
  if (blueprintObj.outputSpec) {
    cleanBlueprint.outputSpec = blueprintObj.outputSpec;
  }

  return {
    blueprintObj,
    blueprintPayload: JSON.stringify(cleanBlueprint),
    enabledTools,
  };
}

function loadInputFile(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Input file must be a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function extractJobPayloadEnvFromBlueprint(
  blueprintObj: any,
  inputConfig: Record<string, unknown>,
): Record<string, string> {
  const schema = blueprintObj?.templateMeta?.inputSchema ?? blueprintObj?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {};
  }

  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return {};
  }

  const required = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((field: unknown): field is string => typeof field === 'string')
      : [],
  );

  const extractedEnv: Record<string, string> = {};
  for (const [field, spec] of Object.entries(properties as Record<string, any>)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    if (typeof spec.envVar !== 'string' || spec.envVar.length === 0) continue;

    assertValidJinnJobEnvKey(spec.envVar, `inputSchema.properties.${field}.envVar`);

    let value: unknown;
    if (Object.prototype.hasOwnProperty.call(inputConfig, field)) {
      value = inputConfig[field];
    } else if (spec.default !== undefined && spec.default !== '$provision') {
      value = spec.default;
    }

    if (value === undefined || value === null || value === '') {
      if (required.has(field)) {
        throw new Error(
          `Missing required input "${field}" for ${spec.envVar}. Provide --input with a value for "${field}".`,
        );
      }
      continue;
    }

    extractedEnv[spec.envVar] = String(value);
  }

  return extractedEnv;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  const workstreamId = flags.workstream;
  if (!workstreamId) throw new Error('--workstream <id> is required');

  const clonePath = flags.cwd;
  if (!clonePath) throw new Error('--cwd <jinn-node-clone-path> is required');
  const allowStaleRequests = flags['allow-stale'] === 'true';

  // Hard-force local E2E APIs for all dispatch-side context calls.
  // This prevents .env.test/.env bleed from accidentally pointing to non-local ports.
  process.env.PONDER_GRAPHQL_URL = E2E_LOCAL_PONDER_URL;
  process.env.CONTROL_API_URL = E2E_LOCAL_CONTROL_URL;
  console.log('Using E2E local endpoints:');
  console.log(`  PONDER_GRAPHQL_URL=${E2E_LOCAL_PONDER_URL}`);
  console.log(`  CONTROL_API_URL=${E2E_LOCAL_CONTROL_URL}`);

  // Hard preflight gate: block dispatch when environment/credentials are invalid.
  await runHardPreflightGate({
    cloneDir: clonePath,
    workstreamId,
    allowStaleRequests,
  });

  const jobName = flags['job-name'] || 'e2e-test-job';
  const jobDefinitionId = flags['job-def-id'] || crypto.randomUUID();
  const inputConfig = flags.input ? loadInputFile(resolve(flags.input)) : {};

  // Resolve blueprint and tools
  let blueprint: string;
  let enabledTools: string[];
  let blueprintObj: any;

  if (flags.blueprint) {
    // Explicit JSON string — use as-is
    blueprint = flags.blueprint;
    blueprintObj = JSON.parse(flags.blueprint);
    enabledTools = flags['enabled-tools']
      ? flags['enabled-tools'].split(',')
      : ['google_web_search', 'web_fetch', 'create_artifact'];
  } else {
    // Load from file (explicit --blueprint-file or default)
    const blueprintFile = flags['blueprint-file']
      ? resolve(flags['blueprint-file'])
      : DEFAULT_BLUEPRINT_FILE;

    console.log('Loading blueprint from:', blueprintFile);
    const loaded = loadBlueprintFile(blueprintFile);
    blueprintObj = loaded.blueprintObj;
    blueprint = loaded.blueprintPayload;
    enabledTools = flags['enabled-tools']
      ? flags['enabled-tools'].split(',')
      : loaded.enabledTools;
  }

  const additionalContextEnv = extractJobPayloadEnvFromBlueprint(blueprintObj, inputConfig);

  // Point operate-profile at the jinn-node clone so getMechAddress(),
  // getServicePrivateKey(), getMechChainConfig() read from the right .operate dir
  const operateDir = join(resolve(clonePath), '.operate');
  process.env.OPERATE_PROFILE_DIR = operateDir;
  console.log('Using operate profile:', operateDir);

  // 1. Build IPFS payload via production helper (same as redispatch-job.ts)
  console.log('\nBuilding IPFS payload...');
  console.log('  jobName:', jobName);
  console.log('  jobDefinitionId:', jobDefinitionId);
  console.log('  workstreamId:', workstreamId);
  console.log('  enabledTools:', enabledTools.join(', '));
  if (Object.keys(additionalContextEnv).length > 0) {
    console.log('  payload env keys:', Object.keys(additionalContextEnv).join(', '));
  }

  const { ipfsJsonContents } = await buildIpfsPayload({
    blueprint,
    jobName,
    jobDefinitionId,
    enabledTools,
    skipBranch: true, // E2E: no git branch creation
    workstreamId,
    additionalContextOverrides: Object.keys(additionalContextEnv).length > 0
      ? { env: additionalContextEnv }
      : undefined,
  });

  // 2. Dispatch via production marketplaceInteract (same as redispatch-job.ts)
  const mechAddress = getMechAddress();
  const chainConfig = getMechChainConfig();
  const privateKey = getServicePrivateKey();

  if (!mechAddress) {
    throw new Error('Mech address not found. Check .operate service config (MECH_TO_CONFIG).');
  }
  if (!privateKey) {
    throw new Error('Service private key not found. Check .operate/keys directory and OPERATE_PASSWORD env.');
  }

  console.log('\nDispatching via marketplaceInteract...');
  console.log('  mechAddress:', mechAddress);

  const result = await marketplaceInteract({
    prompts: [blueprint],
    priorityMech: mechAddress,
    tools: enabledTools,
    ipfsJsonContents,
    chainConfig,
    keyConfig: { source: 'value', value: privateKey },
    postOnly: true,
    responseTimeout: 61,
  });

  if (!result || !Array.isArray(result.request_ids) || result.request_ids.length === 0) {
    throw new Error('Dispatch failed: no request IDs returned. Check RPC quota, funding, or mech config.');
  }

  console.log('\nDispatched successfully!');
  console.log('  Request IDs:', result.request_ids.join(', '));
  if (result.transaction_hash) {
    console.log('  Transaction:', result.transaction_hash);
  }
}

main().catch(e => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
