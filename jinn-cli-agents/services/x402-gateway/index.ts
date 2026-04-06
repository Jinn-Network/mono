/**
 * x402 Gateway Service
 *
 * Execute OLAS-registered agents via x402 payments. Exposes:
 * - GET /agents - List available agents (free)
 * - GET /agents/:slug - Get agent details (free)
 * - POST /agents/:slug/execute - Execute agent (paid via x402)
 * - GET /runs/:requestId/status - Check run status (free)
 * - GET /runs/:requestId/result - Get run result (free, 202 if not ready)
 *
 * Required env vars:
 * - PAYMENT_WALLET_ADDRESS: Address to receive payments
 * - CDP_API_KEY_ID: Coinbase Developer Platform key ID (for x402)
 * - CDP_API_KEY_SECRET: Coinbase Developer Platform key secret
 * - SUPABASE_URL: Supabase project URL
 * - SUPABASE_SERVICE_ROLE_KEY: Supabase service role key
 * - PONDER_GRAPHQL_URL: Ponder GraphQL endpoint (for run status/results)
 * - PRIVATE_KEY: Wallet private key for dispatching jobs
 * - MECH_ADDRESS: Target mech address
 */

// Crash protection — log before dying so we can diagnose silent deaths.
// Must be registered before any imports that create async resources (Postgres pools, Redis, etc.).
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception — gateway will exit:', err.stack || err.message || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection — gateway will exit:', reason instanceof Error ? (reason.stack || reason.message) : reason);
  process.exit(1);
});

// NOTE: dotenv/config intentionally NOT imported here.
// Env vars are inherited from the parent process (ProcessManager on E2E, Railway on prod).
// Double-loading .env can override injected vars and cause subtle misconfigurations.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, type Network } from "x402-hono";
import { createFacilitatorConfig } from "@coinbase/x402";
import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import {
  extractAndValidate,
  summarizeOutputSpec as summarizeSpec,
  DEFAULT_OUTPUT_SPEC,
  type OutputSpec
} from "./output-spec.js";
import { handleProvisioning } from "./provisioning/index.js";
import {
  computeTemplatePrice,
  validateBudget,
  formatWei,
} from "./pricing.js";
import { deepSubstitute, buildBlueprintFromTemplate as sharedBuildBlueprint } from '../../scripts/shared/template-substitution.js';
import { buildAnnotatedTools, parseAnnotatedTools } from '../../jinn-node/dist/shared/template-tools.js';
import { buildDiscoveryItems, buildWellKnownManifest } from './discovery.js';

// Inlined from gemini-agent/shared/code_metadata.ts (Railway deploys this service standalone)
interface BranchSnapshot {
  name: string;
  headCommit: string;
  remoteUrl?: string;
}

interface RepoMetadata {
  remoteUrl?: string;
}

interface CodeMetadata {
  branch: BranchSnapshot;
  repo?: RepoMetadata;
  baseBranch?: string;
  capturedAt: string;
  jobDefinitionId: string;
}

function buildJobBranchName(options: { jobDefinitionId: string; jobName?: string | null; maxSlugLength?: number }): string {
  const { jobDefinitionId, jobName, maxSlugLength = 30 } = options;
  const prefix = jobDefinitionId.slice(0, 8);

  let slug = '';
  if (jobName) {
    slug = jobName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxSlugLength);
  }

  return slug ? `job/${prefix}-${slug}` : `job/${prefix}`;
}

const app = new Hono();
app.use("/*", cors());

// Environment
const env = process.env;
const payTo = env.PAYMENT_WALLET_ADDRESS as `0x${string}` | undefined;
const network = (env.X402_NETWORK || "base") as Network;
const mechAddress = env.MECH_ADDRESS;
const privateKey = env.PRIVATE_KEY;
// Ponder GraphQL endpoint — used only for /runs/ endpoints (on-chain delivery status)
const ponderUrl = env.PONDER_GRAPHQL_URL || "https://indexer.jinn.network/graphql";
const chainConfig = env.CHAIN_CONFIG || "base";

// Supabase client — source of truth for agent templates
const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

// Types — Supabase templates table (snake_case)
interface AgentTemplate {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  version: string | null;
  blueprint: Record<string, any>;       // jsonb — already parsed
  input_schema: Record<string, any> | null;
  output_spec: Record<string, any> | null;
  enabled_tools: any[] | null;           // jsonb array
  tags: string[] | null;
  price_wei: string | null;
  price_usd: string | null;
  default_cyclic: boolean | null;
  venture_id: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  olas_agent_id: number | null;
}

function parseAgentToolPolicy(agent: AgentTemplate): {
  requiredTools: string[];
  availableTools: string[];
} {
  // Try blueprint first (for templates with embedded tools in templateMeta.tools)
  if (agent.blueprint) {
    const bp = agent.blueprint; // already parsed jsonb
    const tools = bp?.templateMeta?.tools ?? bp?.tools;
    const result = parseAnnotatedTools(tools);
    if (result.requiredTools.length > 0 || result.availableTools.length > 0) {
      return result;
    }
  }

  // Fallback to enabled_tools
  if (agent.enabled_tools && agent.enabled_tools.length > 0) {
    const result = parseAnnotatedTools(agent.enabled_tools);
    if (result.requiredTools.length > 0 || result.availableTools.length > 0) {
      return result;
    }
    // If parseAnnotatedTools didn't find anything, treat as flat array
    return {
      requiredTools: [],
      availableTools: agent.enabled_tools.filter((t): t is string => typeof t === 'string' && t.length > 0),
    };
  }

  return { requiredTools: [], availableTools: [] };
}

// ============================================================================
// Supabase data access — agents are templates with olas_agent_id
// ============================================================================

async function fetchAgents(): Promise<AgentTemplate[]> {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .not('olas_agent_id', 'is', null)
    .eq('status', 'published')
    .order('olas_agent_id', { ascending: true });

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data || [];
}

async function fetchAgentBySlug(slug: string): Promise<AgentTemplate | null> {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('slug', slug)
    .not('olas_agent_id', 'is', null)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
    throw new Error(`Supabase query failed: ${error.message}`);
  }
  return data;
}

/**
 * Build codeMetadata from standardized input fields.
 * Templates use `repoUrl` and optionally `baseBranch`.
 */
function buildCodeMetadataFromInput(
  input: Record<string, any>,
  jobDefinitionId: string,
  jobName: string
): CodeMetadata | undefined {
  const repoInput = input?.repoUrl;
  if (typeof repoInput !== 'string' || !repoInput) {
    return undefined;
  }

  // Convert org/repo format to full URL if needed
  const repoUrl = repoInput.includes('://')
    ? repoInput
    : `https://github.com/${repoInput}`;

  const baseBranch = input?.baseBranch || 'main';

  const branchName = buildJobBranchName({
    jobDefinitionId,
    jobName,
    maxSlugLength: 20,
  });

  return {
    branch: {
      name: branchName,
      headCommit: 'pending', // Worker resolves after checkout
      remoteUrl: repoUrl,
    },
    repo: { remoteUrl: repoUrl },
    baseBranch,
    capturedAt: new Date().toISOString(),
    jobDefinitionId,
  };
}

interface ExecuteRequest {
  input?: Record<string, any>;
  context?: string;
  callerBudget?: string; // Optional budget cap in wei
  cyclic?: boolean; // Run continuously (auto-restart after completion)
}

// ============================================================================
// Shared dispatch logic
// ============================================================================

interface DispatchOptions {
  callerBudget?: string;
  estimatedCost?: string;
  cyclic?: boolean;
}

const JINN_JOB_ENV_KEY_PATTERN = /^JINN_JOB_[A-Z0-9_]+$/;

function assertValidJobPayloadEnvKey(key: string, source: string): void {
  if (!JINN_JOB_ENV_KEY_PATTERN.test(key)) {
    throw new Error(
      `${source} contains invalid env key "${key}". Only JINN_JOB_* keys are allowed.`,
    );
  }
}

function assertValidJobPayloadEnvMap(rawEnv: unknown, source: string): Record<string, string> {
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    throw new Error(`${source} must be an object map of JINN_JOB_* keys to string values.`);
  }

  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
    assertValidJobPayloadEnvKey(key, source);
    if (typeof value !== 'string') {
      throw new Error(`${source} has non-string value for key "${key}".`);
    }
    validated[key] = value;
  }
  return validated;
}

async function dispatchAgent(
  agent: AgentTemplate,
  rawInput: Record<string, any>,
  source: string = 'x402',
  options: DispatchOptions = {},
): Promise<{ requestIds: string[]; jobDefinitionId: string }> {
  if (!mechAddress || !privateKey) {
    throw new Error('Server not configured for dispatch');
  }

  const { requiredTools, availableTools } = parseAgentToolPolicy(agent);
  const enabledTools = requiredTools.length > 0 ? requiredTools : availableTools;
  if (enabledTools.length === 0) {
    throw new Error('Agent has no tools configured');
  }

  const inputSchema = (agent.input_schema || {}) as Record<string, any>;

  // Handle $provision sentinels
  let enrichedInput = rawInput;
  try {
    enrichedInput = await handleProvisioning(rawInput, inputSchema);
  } catch (provisionError: any) {
    throw new Error(`Provisioning failed: ${provisionError.message}`);
  }

  // Inject system-provided context variables
  enrichedInput = {
    ...enrichedInput,
    currentTimestamp: new Date().toISOString(),
  };

  // Build blueprint from template — sharedBuildBlueprint expects blueprint as JSON string
  const templateForBlueprint = {
    blueprint: JSON.stringify(agent.blueprint),
    inputSchema: agent.input_schema || undefined,
    name: agent.name,
  };
  const { invariants } = await buildBlueprintFromTemplate(templateForBlueprint, enrichedInput);

  const jobDefinitionId = crypto.randomUUID();
  const jobName = `${agent.name} (via ${source})`;
  const { marketplaceInteract } = await import("@jinn-network/mech-client-ts/dist/marketplace_interact.js");

  // Build codeMetadata from standardized input fields
  const codeMetadata = buildCodeMetadataFromInput(enrichedInput, jobDefinitionId, jobName);

  // Build additionalContext with budget info and env vars
  const additionalContext: Record<string, any> = {};
  if (options.callerBudget) {
    additionalContext.budgetCap = options.callerBudget;
    additionalContext.estimatedCost = options.estimatedCost;
  }
  // Extract env vars from inputSchema.envVar mappings
  const extractedEnv: Record<string, string> = {};
  if (inputSchema.properties) {
    for (const [field, spec] of Object.entries(inputSchema.properties)) {
      const fieldSpec = spec as { envVar?: string };
      if (fieldSpec.envVar && enrichedInput[field] !== undefined) {
        assertValidJobPayloadEnvKey(fieldSpec.envVar, `inputSchema.properties.${field}.envVar`);
        extractedEnv[fieldSpec.envVar] = String(enrichedInput[field]);
      }
    }
  }
  const explicitEnv = enrichedInput.env !== undefined
    ? assertValidJobPayloadEnvMap(enrichedInput.env, 'input.env')
    : undefined;
  if (Object.keys(extractedEnv).length > 0 || explicitEnv) {
    additionalContext.env = {
      ...extractedEnv,
      ...(explicitEnv || {}),
    };
  }

  const tools = buildAnnotatedTools({ requiredTools, availableTools });
  const result = await marketplaceInteract({
    prompts: [JSON.stringify({ invariants })],
    priorityMech: mechAddress,
    tools: enabledTools,
    ipfsJsonContents: [{
      blueprint: JSON.stringify({ invariants }),
      jobName,
      model: "auto-gemini-3",
      jobDefinitionId,
      nonce: crypto.randomUUID(),
      networkId: 'jinn',
      templateId: agent.id,
      templateVersion: agent.version || "1.0.0",
      enabledTools,
      ...(tools.length > 0 ? { tools } : {}),
      ...(agent.output_spec && { outputSpec: agent.output_spec }),
      ...(agent.input_schema && { inputSchema: agent.input_schema }),
      estimatedCost: options.estimatedCost,
      cyclic: options.cyclic ?? agent.default_cyclic ?? false,
      ...(Object.keys(additionalContext).length > 0 && { additionalContext }),
      ...(codeMetadata && {
        codeMetadata,
        branchName: codeMetadata.branch.name,
        baseBranch: codeMetadata.baseBranch,
        executionPolicy: {
          branch: codeMetadata.branch.name,
          ensureTestsPass: true,
          description: 'Agent must work on the provided branch.',
        },
      }),
    }],
    chainConfig,
    keyConfig: { source: "value", value: privateKey },
    postOnly: true,
    responseTimeout: 61,
  });

  if (!result?.request_ids?.[0]) {
    throw new Error("Dispatch failed: no request ID");
  }

  return { requestIds: result.request_ids, jobDefinitionId };
}

// Health check
app.get("/health", (c) => {
  const providers: Record<string, string> = {};
  if (env.UMAMI_HOST && env.UMAMI_USERNAME && env.UMAMI_PASSWORD) providers.umami = 'static';
  if (env.SUPABASE_SERVICE_ROLE_KEY) providers.supabase = 'static';
  if (env.TELEGRAM_BOT_TOKEN) providers.telegram = 'static';
  if (env.CIVITAI_API_TOKEN || env.CIVITAI_API_KEY) providers.civitai = 'static';
  if (env.OPENAI_API_KEY) providers.openai = 'static';

  return c.json({
    status: "ok",
    service: "x402-gateway",
    timestamp: new Date().toISOString(),
    providers,
  });
});

// .well-known/x402 — Discovery endpoint (supports both x402scan and Bazaar formats)
app.get("/.well-known/x402", async (c) => {
  if (!payTo) {
    return c.json({ error: "Payment not configured" }, 503);
  }
  try {
    const agents = await fetchAgents();
    const baseUrl = `https://${env.RAILWAY_PUBLIC_DOMAIN || c.req.header("host") || "localhost:3001"}`;
    const format = c.req.query("format");

    if (format === "bazaar") {
      const items = buildDiscoveryItems(agents, baseUrl, payTo, `eip155:8453`);
      const limit = parseInt(c.req.query("limit") || "20", 10);
      const offset = parseInt(c.req.query("offset") || "0", 10);
      const manifest = buildWellKnownManifest(items, limit, offset);
      return c.json(manifest);
    }

    // Default: x402scan-compatible discovery format
    const resources = agents.map(a => `${baseUrl}/agents/${a.slug}/execute`);
    return c.json({
      version: 1,
      resources,
      x402Version: 2,
      items: buildDiscoveryItems(agents, baseUrl, payTo, `eip155:8453`),
      pagination: {
        limit: resources.length,
        offset: 0,
        total: resources.length,
      },
    });
  } catch (err: any) {
    return c.json({ error: "Discovery unavailable", details: err.message }, 503);
  }
});

// Service info
app.get("/", (c) => c.json({
  name: "x402 Gateway",
  description: "Execute OLAS-registered AI agents via x402 payments",
  network,
  endpoints: {
    "GET /.well-known/x402": { payment: "free", description: "x402 discovery manifest" },
    "GET /agents": { payment: "free", description: "List available agents" },
    "GET /agents/:slug": { payment: "free", description: "Get agent details" },
    "POST /agents/:slug/execute": { payment: "dynamic", description: "Execute agent (price from agent config)" },
    "GET /runs/:requestId/status": { payment: "free", description: "Check run status" },
    "GET /runs/:requestId/result": { payment: "free", description: "Get run result (202 if pending)" },
  }
}));

// GET /agents - List available agents (OLAS-registered templates from Supabase)
app.get("/agents", async (c) => {
  try {
    const agents = await fetchAgents();

    const items = agents.map((a) => ({
      slug: a.slug,
      name: a.name,
      description: a.description,
      tags: a.tags || [],
      olasAgentId: a.olas_agent_id,
      price: a.price_wei ? formatPrice(a.price_wei) : "free",
      priceWei: a.price_wei || "0",
      outputSpecSummary: summarizeOutputSpec(a.output_spec as OutputSpec | null),
    }));

    return c.json({ agents: items });
  } catch (err: any) {
    console.error("Agent list failed:", err.message);
    return c.json({ error: "Agent service unavailable", details: err.message }, 503);
  }
});

// GET /agents/:slug - Get agent details
app.get("/agents/:slug", async (c) => {
  const slug = c.req.param("slug");

  try {
    const agent = await fetchAgentBySlug(slug);

    if (!agent) {
      return c.json({ error: "Agent not found" }, 404);
    }

    return c.json({
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      tags: agent.tags || [],
      olasAgentId: agent.olas_agent_id,
      enabledTools: agent.enabled_tools || [],
      inputSchema: agent.input_schema || {},
      outputSpec: agent.output_spec || {},
      price: formatPrice(agent.price_wei || "0"),
      priceWei: agent.price_wei || "0",
      status: agent.status,
      createdAt: agent.created_at,
      updatedAt: agent.updated_at,
    });
  } catch (err: any) {
    console.error("Agent detail failed for slug:", slug, err.message);
    return c.json({ error: "Agent service unavailable", details: err.message }, 503);
  }
});

// POST /agents/:slug/execute - Execute agent
// x402 payment gate: returns 402 with payment requirements when no valid payment header is present.
app.post("/agents/:slug/execute", async (c, next) => {
  // If CDP keys and payment address are configured, apply x402 payment gate
  if (payTo && env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    const slug = c.req.param("slug");

    // Fetch agent to get its price
    let agentPrice = "$0.001"; // minimum floor
    try {
      const a = await fetchAgentBySlug(slug);
      if (a?.price_wei && a.price_wei !== "0") {
        const eth = Number(BigInt(a.price_wei)) / 1e18;
        const usd = eth * 3000; // rough ETH/USD estimate
        agentPrice = usd < 0.001 ? "$0.001" : `$${usd.toFixed(3)}`;
      }
    } catch {
      // Use default price if agent lookup fails
    }

    const middleware = paymentMiddleware(
      payTo,
      { 'POST *': { price: agentPrice, network } },
      createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
    );
    return middleware(c, next);
  }
  // No payment gate configured — proceed directly
  await next();
}, async (c) => {
  if (!mechAddress || !privateKey) {
    return c.json({ error: "Server not configured for dispatch" }, 500);
  }

  const slug = c.req.param("slug");

  let agent: AgentTemplate | null = null;
  try {
    agent = await fetchAgentBySlug(slug);
  } catch (err: any) {
    console.error("Agent lookup failed for execute:", slug, err.message);
    return c.json({ error: "Agent service unavailable", details: err.message }, 503);
  }

  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  // Parse request body
  let body: ExecuteRequest;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const { requiredTools, availableTools } = parseAgentToolPolicy(agent);
  if (requiredTools.length === 0 && availableTools.length === 0) {
    return c.json({
      error: "Agent tool policy missing",
      details: "Agent must include a tools list (either in blueprint.templateMeta.tools or enabled_tools field).",
    }, 400);
  }
  const enabledTools = requiredTools.length > 0 ? requiredTools : availableTools;
  if (availableTools.length > 0) {
    const availableSet = new Set(availableTools.map((tool) => tool.toLowerCase()));
    const disallowedRequired = requiredTools.filter((tool) => !availableSet.has(String(tool).toLowerCase()));
    if (disallowedRequired.length > 0) {
      return c.json({
        error: "Agent has invalid tool policy",
        details: `requiredTools must be a subset of availableTools. Invalid: ${disallowedRequired.join(', ')}.`,
        invalidTools: disallowedRequired,
        availableTools,
      }, 400);
    }
  }

  // Use template price directly (set in Supabase), fallback to minimum
  const estimatedCost = agent.price_wei || '500000000000000'; // 0.0005 ETH min

  // Validate caller budget if provided
  const budgetCheck = validateBudget(body.callerBudget, estimatedCost);
  if (!budgetCheck.valid) {
    return c.json({
      error: "Budget exceeded",
      details: budgetCheck.message,
      estimatedCost: formatWei(estimatedCost),
      callerBudget: body.callerBudget ? formatWei(body.callerBudget) : undefined,
    }, 402);
  }

  // Validate input against schema (basic validation)
  const inputSchema = (agent.input_schema || {}) as Record<string, any>;
  const input = body.input || {};

  if (inputSchema.required) {
    for (const field of inputSchema.required) {
      if (!(field in input)) {
        return c.json({ error: `Missing required input field: ${field}` }, 400);
      }
    }
  }

  try {
    const { requestIds, jobDefinitionId } = await dispatchAgent(agent, input, 'x402', {
      callerBudget: body.callerBudget,
      estimatedCost,
      cyclic: body.cyclic,
    });

    const requestId = requestIds[0];
    const baseUrl = new URL(c.req.url).origin;

    return c.json({
      requestId,
      jobDefinitionId,
      agentSlug: agent.slug,
      olasAgentId: agent.olas_agent_id,
      statusUrl: `${baseUrl}/runs/${requestId}/status`,
      resultUrl: `${baseUrl}/runs/${requestId}/result`,
      explorerUrl: `https://explorer.jinn.network/requests/${requestId}`,
    }, 201);

  } catch (e: any) {
    console.error("Execute failed:", e);
    return c.json({ error: "Execution failed", details: e.message }, 500);
  }
});

// GET /runs/:requestId/status - Check run status (Ponder — on-chain data)
app.get("/runs/:requestId/status", async (c) => {
  const requestId = c.req.param("requestId");

  const query = `query ($id: String!) {
    request(id: $id) {
      id
      delivered
      jobName
      blockTimestamp
    }
  }`;

  try {
    const res = await fetch(ponderUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: requestId } }),
    });

    const data = await res.json() as { data?: { request?: { delivered: boolean; jobName?: string; blockTimestamp?: string } } };
    const req = data?.data?.request;

    if (!req) {
      return c.json({
        requestId,
        status: "not_found",
        message: "Request not yet indexed or does not exist"
      });
    }

    return c.json({
      requestId,
      status: req.delivered ? "completed" : "in_progress",
      jobName: req.jobName,
      createdAt: req.blockTimestamp ? new Date(Number(req.blockTimestamp) * 1000).toISOString() : undefined,
    });
  } catch (e: any) {
    return c.json({ error: "Status query failed", details: e.message }, 500);
  }
});

// GET /runs/:requestId/result - Get run result (Ponder + IPFS)
// Returns the FINAL result of a workstream, not just the initial request's delivery
app.get("/runs/:requestId/result", async (c) => {
  const requestId = c.req.param("requestId");

  // Step 1: Get the request and its jobDefinitionId
  const requestQuery = `query ($id: String!) {
    request(id: $id) {
      id
      delivered
      deliveryIpfsHash
      jobName
      jobDefinitionId
    }
  }`;

  try {
    const res = await fetch(ponderUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: requestQuery, variables: { id: requestId } }),
    });

    const data = await res.json() as {
      data?: {
        request?: {
          delivered: boolean;
          deliveryIpfsHash?: string;
          jobName?: string;
          jobDefinitionId?: string;
        }
      }
    };
    const req = data?.data?.request;

    if (!req) {
      return c.json({
        status: "not_found",
        result: null,
      }, 404);
    }

    if (!req.delivered) {
      // Return 202 Accepted - still processing
      return c.json({
        status: "in_progress",
        result: null,
      }, 202);
    }

    // Step 2: Check job definition's lastStatus to determine if workstream is complete
    let finalRequestId = requestId;
    let finalDeliveryHash = req.deliveryIpfsHash;

    if (req.jobDefinitionId) {
      const jobDefQuery = `query ($id: String!) {
        jobDefinition(id: $id) {
          id
          lastStatus
        }
      }`;

      const jobDefRes = await fetch(ponderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: jobDefQuery, variables: { id: req.jobDefinitionId } }),
      });

      const jobDefData = await jobDefRes.json() as { data?: { jobDefinition?: { lastStatus?: string } } };
      const lastStatus = jobDefData?.data?.jobDefinition?.lastStatus;

      // If job is COMPLETED, find the latest delivered request for this job definition
      if (lastStatus === "COMPLETED") {
        const latestQuery = `query ($jobDefId: String!) {
          requests(
            where: { jobDefinitionId: $jobDefId, delivered: true }
            orderBy: "blockTimestamp"
            orderDirection: "desc"
            limit: 1
          ) {
            items {
              id
              deliveryIpfsHash
            }
          }
        }`;

        const latestRes = await fetch(ponderUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: latestQuery, variables: { jobDefId: req.jobDefinitionId } }),
        });

        const latestData = await latestRes.json() as { data?: { requests?: { items?: Array<{ id: string; deliveryIpfsHash?: string }> } } };
        const latestRequest = latestData?.data?.requests?.items?.[0];

        if (latestRequest?.deliveryIpfsHash) {
          finalRequestId = latestRequest.id;
          finalDeliveryHash = latestRequest.deliveryIpfsHash;
        }
      } else if (lastStatus === "DELEGATING") {
        // Workstream has children still processing
        return c.json({
          status: "in_progress",
          result: null,
        }, 202);
      }
    }

    if (!finalDeliveryHash) {
      return c.json({
        status: "in_progress",
        result: null,
      }, 202);
    }

    // Step 3: Fetch delivery payload from IPFS
    const ipfsUrl = buildIpfsUrl(finalDeliveryHash, finalRequestId);
    const ipfsRes = await fetch(ipfsUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!ipfsRes.ok) {
      return c.json({
        status: "error",
        error: "Delivery completed but payload fetch failed",
      }, 502);
    }

    const deliveryPayload = await ipfsRes.json() as Record<string, any>;

    // Get OutputSpec: prefer passthrough from delivery payload, fallback to Supabase lookup
    let outputSpec: OutputSpec | undefined;

    if (deliveryPayload.outputSpec && typeof deliveryPayload.outputSpec === 'object') {
      outputSpec = deliveryPayload.outputSpec as OutputSpec;
    } else {
      // Fallback: fetch from Supabase if templateId is present
      const templateId = deliveryPayload.templateId;
      if (templateId) {
        try {
          const { data: template } = await supabase
            .from('templates')
            .select('output_spec')
            .eq('id', templateId)
            .single();
          if (template?.output_spec) {
            outputSpec = template.output_spec as OutputSpec;
          }
        } catch {
          // OutputSpec lookup failed, proceed without it
        }
      }
    }

    // Apply OutputSpec mapping and validation
    try {
      const result = extractAndValidate(deliveryPayload, outputSpec);

      return c.json({
        status: "completed",
        result,
      });
    } catch (validationError: any) {
      return c.json({
        status: "error",
        error: validationError.message,
      }, 502);
    }

  } catch (e: any) {
    return c.json({ status: "error", error: e.message }, 500);
  }
});

// Helper: Convert f01551220... digest to dag-pb CID URL with requestId path
function buildIpfsUrl(deliveryIpfsHash: string, requestId: string): string {
  const digestHex = deliveryIpfsHash.replace(/^f01551220/i, '');

  if (digestHex.length !== 64) {
    return `https://gateway.autonolas.tech/ipfs/${deliveryIpfsHash}/${requestId}`;
  }

  try {
    const digestBytes: number[] = [];
    for (let i = 0; i < digestHex.length; i += 2) {
      digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16));
    }

    // Build CIDv1 bytes: [0x01] + [0x70] (dag-pb) + multihash: [0x12, 0x20] + digest
    const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];

    const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bitBuffer = 0;
    let bitCount = 0;
    let out = '';
    for (const b of cidBytes) {
      bitBuffer = (bitBuffer << 8) | (b & 0xff);
      bitCount += 8;
      while (bitCount >= 5) {
        const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
        bitCount -= 5;
        out += base32Alphabet[idx];
      }
    }
    if (bitCount > 0) {
      const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
      out += base32Alphabet[idx];
    }

    const dirCid = 'b' + out;
    return `https://gateway.autonolas.tech/ipfs/${dirCid}/${requestId}`;
  } catch {
    return `https://gateway.autonolas.tech/ipfs/${deliveryIpfsHash}/${requestId}`;
  }
}

// Helper: Format price from wei to human readable
function formatPrice(weiString: string | number | bigint): string {
  const wei = BigInt(weiString || 0);
  if (wei === 0n) return "free";

  const eth = Number(wei) / 1e18;
  if (eth >= 0.001) return `${eth.toFixed(4)} ETH`;

  const gwei = Number(wei) / 1e9;
  if (gwei >= 1) return `${gwei.toFixed(2)} gwei`;

  return `${wei} wei`;
}

function getProviderStaticConfig(provider: string): Record<string, string> {
  switch (provider) {
    case 'supabase':
      return env.SUPABASE_URL ? { SUPABASE_URL: env.SUPABASE_URL } : {};
    case 'umami':
      return env.UMAMI_HOST ? { UMAMI_HOST: env.UMAMI_HOST.replace(/\/$/, '') } : {};
    default:
      return {};
  }
}

const summarizeOutputSpec = summarizeSpec;
const buildBlueprintFromTemplate = sharedBuildBlueprint;

// ============================================================
// Admin Routes: Operator Management, Policies, Venture Credentials
// ============================================================
app.route('/admin', adminApp);

// ============================================================
// Credential Bridge: Crypto Identity → Web2 OAuth
// ============================================================

import { getGrant, listGrants } from './credentials/acl.js';
import { getNangoAccessToken } from './credentials/nango-client.js';
import { getStaticCredential } from './credentials/static-providers.js';
import { getCredentialNonceStore, getRedis } from './credentials/redis.js';
import { verifyPayment, type PaymentErrorCode } from './credentials/x402-verify.js';
import { checkRateLimit, getRateLimitHeaders } from './credentials/rate-limit.js';
import { logAudit, getClientIp, getUserAgent } from './credentials/audit.js';
import { verifyJobClaim } from './credentials/job-verify.js';
import type { CredentialRequest, CredentialResponse, CredentialError } from './credentials/types.js';
import { adminApp } from './credentials/admin-routes.js';
import { checkVentureCredentialAccess, discoverVentureProviders } from './credentials/venture-resolver.js';
import { verifyRequestWithErc8128 } from '../../jinn-node/dist/http/erc8128.js';

const credentialNonceStore = getCredentialNonceStore();

async function parseCredentialBody(request: Request): Promise<CredentialRequest> {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_json');
  }

  return parsed as CredentialRequest;
}

async function authenticateCredentialRequest(request: Request): Promise<
  | { ok: true; address: string }
  | { ok: false; reason: string; detail?: string }
> {
  const verifyResult = await verifyRequestWithErc8128({
    request,
    nonceStore: credentialNonceStore,
    policy: {
      clockSkewSec: 5,
      maxValiditySec: 300,
    },
  });

  if (!verifyResult.ok) {
    return {
      ok: false,
      reason: verifyResult.reason,
      detail: verifyResult.detail,
    };
  }

  return {
    ok: true,
    address: verifyResult.address.toLowerCase(),
  };
}

/**
 * POST /credentials/capabilities
 *
 * Lightweight endpoint for workers to discover which credential providers
 * they have ACL grants for. Uses the same signature scheme as /credentials/:provider
 * but skips rate limiting, job context, and payment checks.
 *
 * Body: { requestId?: string }
 *   - If requestId provided: returns union of global grants + venture-scoped providers
 *     (requires active claim for the requestId)
 *   - If no requestId: returns global grants only (startup probe)
 *
 * Returns { providers: ["github", "telegram", ...] }
 */
app.post("/credentials/capabilities", async (c) => {
  const authResult = await authenticateCredentialRequest(c.req.raw.clone());
  if (!authResult.ok) {
    return c.json({
      error: "Invalid ERC-8128 signature",
      reason: authResult.reason,
      detail: authResult.detail,
    }, 401);
  }

  // Parse optional requestId from body
  let requestId: string | undefined;
  try {
    const body = await parseCredentialBody(c.req.raw);
    requestId = body.requestId;
  } catch {
    // Empty body is fine — treated as startup probe (no requestId)
  }

  try {
    // Global grants (always returned)
    const grants = await listGrants(authResult.address);
    const globalProviders = new Set(Object.keys(grants));

    // Venture-scoped providers (only when requestId provided)
    if (requestId) {
      const { accessible, blockedFromGlobal } = await discoverVentureProviders({
        requestId,
        operatorAddress: authResult.address,
      });
      for (const p of accessible) {
        globalProviders.add(p);
      }
      // venture_only providers that denied this operator must suppress global fallback
      for (const p of blockedFromGlobal) {
        globalProviders.delete(p);
      }
    }

    return c.json({ providers: [...globalProviders] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[capabilities] ACL query failed for ${authResult.address}: ${message}`);
    return c.json({ error: "Failed to query capabilities" }, 500);
  }
});

/**
 * POST /credentials/:provider
 *
 * Requester signs the HTTP request with ERC-8128.
 * Gateway verifies signer EOA, enforces optional job claim ownership
 * against Control API, checks ACL, optionally verifies x402 payment,
 * then returns a fresh OAuth token from Nango.
 */
app.post("/credentials/:provider", async (c) => {
  const provider = c.req.param("provider");

  // Extract audit context early
  const clientIp = getClientIp(c);
  const userAgent = getUserAgent(c);
  const authResult = await authenticateCredentialRequest(c.req.raw.clone());

  if (!authResult.ok) {
    logAudit({
      address: 'unknown',
      provider,
      action: 'auth_failed',
      ip: clientIp,
      userAgent,
      metadata: {
        reason: 'erc8128_invalid',
        verifyReason: authResult.reason,
        verifyDetail: authResult.detail,
      },
    });
    return c.json(
      { error: "Invalid ERC-8128 signature", code: "INVALID_SIGNATURE" } satisfies CredentialError,
      401,
    );
  }
  const requesterAddress = authResult.address;

  // Parse request body
  let body: CredentialRequest;
  try {
    body = await parseCredentialBody(c.req.raw);
  } catch {
    logAudit({ address: requesterAddress, provider, action: 'auth_failed', ip: clientIp, userAgent, metadata: { reason: 'invalid_json' } });
    return c.json({ error: "Invalid JSON body", code: "INVALID_SIGNATURE" } satisfies CredentialError, 400);
  }
  const requestId = body.requestId;

  // Rate limit check (before ACL/payment to fail fast)
  const rateLimit = await checkRateLimit(requesterAddress, provider);
  if (!rateLimit.allowed) {
    logAudit({ address: requesterAddress, provider, action: 'rate_limited', ip: clientIp, userAgent, requestId });
    return c.json(
      { error: 'Rate limit exceeded. Try again later.', code: 'RATE_LIMITED' } satisfies CredentialError,
      { status: 429, headers: getRateLimitHeaders(rateLimit) }
    );
  }

  // Read and validate idempotency key early, but enforce AFTER auth/payment (see below)
  const rawIdempotencyKey = c.req.header('Idempotency-Key');
  let idempotencyKey: string | undefined;
  if (rawIdempotencyKey) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawIdempotencyKey)) {
      logAudit({ address: requesterAddress, provider, action: 'invalid_idempotency_key', ip: clientIp, userAgent, requestId });
      return c.json(
        { error: 'Invalid Idempotency-Key format. Must be 1-64 alphanumeric, hyphen, or underscore characters.', code: 'INVALID_REQUEST' } satisfies CredentialError,
        { status: 400, headers: getRateLimitHeaders(rateLimit) }
      );
    }
    idempotencyKey = rawIdempotencyKey;
  }

  // Job context verification (optional based on REQUIRE_JOB_CONTEXT env)
  const requireJobContext = process.env.REQUIRE_JOB_CONTEXT !== 'false';
  if (requireJobContext) {
    if (!body.requestId) {
      logAudit({
        address: requesterAddress,
        provider,
        action: 'auth_failed',
        ip: clientIp,
        userAgent,
        requestId,
        verificationState: 'invalid',
        verificationError: 'Job context (requestId) required',
        metadata: { reason: 'missing_job_context' },
      });
      return c.json(
        { error: 'Job context (requestId) required', code: 'JOB_NOT_ACTIVE' } satisfies CredentialError,
        { status: 403, headers: getRateLimitHeaders(rateLimit) }
      );
    }

    const jobValid = await verifyJobClaim(body.requestId, requesterAddress);
    if (jobValid.state !== 'valid') {
      const denyStatus = jobValid.state === 'unavailable' ? 503 : 403;
      logAudit({
        address: requesterAddress,
        provider,
        action: 'auth_failed',
        ip: clientIp,
        userAgent,
        requestId,
        verificationState: jobValid.state,
        verificationError: jobValid.error,
        verificationDetail: jobValid.detail,
        metadata: {
          reason: jobValid.state === 'unavailable' ? 'job_verification_unavailable' : 'job_not_active',
          requestId: body.requestId,
          detail: jobValid.error,
          verifyDetail: jobValid.detail,
        },
      });
      const errorCode = jobValid.state === 'unavailable' ? 'JOB_VERIFICATION_UNAVAILABLE' : 'JOB_CLAIM_MISMATCH';
      return c.json(
        { error: jobValid.error || 'Job verification failed', code: errorCode } satisfies CredentialError,
        { status: denyStatus, headers: getRateLimitHeaders(rateLimit) }
      );
    }
  }
  const verificationState = requireJobContext ? 'valid' : 'not_required';

  // Venture-scoped credential check (if requestId available)
  // This runs before global ACL to respect venture owner sovereignty.
  let ventureNangoConnectionId: string | null = null;
  if (requestId) {
    const ventureAccess = await checkVentureCredentialAccess({
      requestId,
      provider,
      operatorAddress: requesterAddress,
    });

    if (ventureAccess.ventureAccessGranted && ventureAccess.ventureCredential?.nangoConnectionId) {
      // Venture-scoped access granted — use venture's Nango connection
      ventureNangoConnectionId = ventureAccess.ventureCredential.nangoConnectionId;
    } else if (ventureAccess.blockGlobalFallback && !ventureAccess.ventureAccessGranted) {
      // Venture has this provider registered with venture_only mode but denied access
      logAudit({
        address: requesterAddress,
        provider,
        action: 'not_authorized',
        ip: clientIp,
        userAgent,
        requestId,
        verificationState,
        metadata: { reason: `venture_denied:${ventureAccess.reason}` },
      });
      return c.json({ error: `Not authorized for ${provider} in this venture`, code: "NOT_AUTHORIZED" } satisfies CredentialError, 403);
    }
    // Otherwise: no venture credential for this provider, or union_with_global — fall through to global ACL
  }

  // Check global ACL (skipped if venture-scoped access was already granted)
  const grant = ventureNangoConnectionId
    ? { nangoConnectionId: ventureNangoConnectionId, pricePerAccess: '0', expiresAt: null, active: true }
    : await getGrant(requesterAddress, provider);

  if (!grant) {
    logAudit({
      address: requesterAddress,
      provider,
      action: 'not_authorized',
      ip: clientIp,
      userAgent,
      requestId,
      verificationState,
    });
    return c.json({ error: `No active grant for ${provider}`, code: "NOT_AUTHORIZED" } satisfies CredentialError, 403);
  }
  const paymentAudit: {
    paymentRequiredAmount?: string;
    paymentPaidAmount?: string;
    paymentPayer?: string;
    paymentNetwork?: string;
  } = {};

  // Check payment if required
  const price = BigInt(grant.pricePerAccess || '0');
  if (price > 0n) {
    const paymentHeader = c.req.header("X-Payment") || c.req.header("X-402-Payment");
    const gatewayAddress = process.env.GATEWAY_PAYMENT_ADDRESS as `0x${string}`;
    const x402Network = process.env.X402_NETWORK || 'base';
    paymentAudit.paymentRequiredAmount = grant.pricePerAccess;
    paymentAudit.paymentNetwork = x402Network;

    if (!gatewayAddress) {
      logAudit({
        address: requesterAddress,
        provider,
        action: 'payment_required',
        ip: clientIp,
        userAgent,
        requestId,
        verificationState,
        ...paymentAudit,
        metadata: { reason: 'server_misconfigured' },
      });
      return c.json({ error: "Server misconfigured: GATEWAY_PAYMENT_ADDRESS not set", code: "PAYMENT_REQUIRED" } satisfies CredentialError, 500);
    }

    if (!paymentHeader) {
      logAudit({
        address: requesterAddress,
        provider,
        action: 'payment_required',
        ip: clientIp,
        userAgent,
        requestId,
        verificationState,
        ...paymentAudit,
        metadata: { amount: grant.pricePerAccess },
      });
      return c.json({
        error: `Payment required: ${grant.pricePerAccess} (USDC atomic units)`,
        code: "PAYMENT_REQUIRED"
      } satisfies CredentialError, 402);
    }

    const result = await verifyPayment({
      paymentHeader,
      requiredAmount: grant.pricePerAccess,
      resource: `/credentials/${provider}`,
      payTo: gatewayAddress,
      network: x402Network,
    });

    if (!result.valid) {
      const status = result.error?.code === 'FACILITATOR_UNAVAILABLE' ? 503 : 402;
      logAudit({
        address: requesterAddress,
        provider,
        action: 'payment_invalid',
        ip: clientIp,
        userAgent,
        requestId,
        verificationState,
        ...paymentAudit,
        paymentErrorCode: result.error?.code,
        paymentErrorMessage: result.error?.message,
        metadata: { errorCode: result.error?.code, errorMessage: result.error?.message },
      });
      return c.json({
        error: result.error?.message || 'Payment verification failed',
        code: "PAYMENT_INVALID",
        paymentError: result.error?.code,
      } satisfies CredentialError & { paymentError?: PaymentErrorCode }, status);
    }

    paymentAudit.paymentPaidAmount = grant.pricePerAccess;
    paymentAudit.paymentPayer = result.payer;
    console.log(`[x402] Payment verified: ${result.payer} → ${provider}`);
  }

  // Idempotency — AFTER auth/payment so cached responses can't bypass security.
  // Key scoped to (address, provider, clientKey) to prevent cross-caller and cross-provider leakage.
  // Atomic SET NX prevents concurrent double-issuance.
  const idempotencyCacheKey = idempotencyKey
    ? `idempotency:${requesterAddress.toLowerCase()}:${provider}:${idempotencyKey}`
    : null;

  if (idempotencyCacheKey) {
    const redis = getRedis();
    if (redis) {
      // Atomically claim this key. Returns 'OK' if we got the lock, null if already taken.
      // Lock TTL (60s) exceeds Nango fetch timeout (15s) + overhead, preventing expiry during processing
      const claimed = await redis.set(idempotencyCacheKey, 'processing', 'EX', 60, 'NX');
      if (claimed !== 'OK') {
        // Key exists — either another request is processing or a result is cached
        const cached = await redis.get(idempotencyCacheKey);
        if (cached && cached !== 'processing') {
          try {
            const { status, body: cachedBody } = JSON.parse(cached);
            return c.json(cachedBody, { status, headers: getRateLimitHeaders(rateLimit) });
          } catch { /* corrupted entry — fall through to 409 */ }
        }
        // Another request is in-flight with this key — reject to prevent double-issuance
        return c.json(
          { error: 'Duplicate request in progress', code: 'DUPLICATE_REQUEST' } satisfies CredentialError,
          { status: 409, headers: getRateLimitHeaders(rateLimit) }
        );
      }
    }
  }

  // Fetch token: check static providers first, then fall back to Nango
  let tokenSource: 'static' | 'nango' = 'nango';
  try {
    const staticToken = await getStaticCredential(provider);
    let token: { access_token: string; expires_in: number };
    if (staticToken) {
      token = staticToken;
      tokenSource = 'static';
    } else {
      token = await getNangoAccessToken(grant.nangoConnectionId, provider);
      tokenSource = 'nango';
    }
    const response: CredentialResponse = {
      access_token: token.access_token,
      expires_in: token.expires_in,
      provider,
      config: getProviderStaticConfig(provider),
    };
    logAudit({
      address: requesterAddress,
      provider,
      action: 'token_issued',
      ip: clientIp,
      userAgent,
      requestId,
      verificationState,
      ...paymentAudit,
      metadata: { source: tokenSource },
    });
    // Overwrite "processing" marker with actual response (longer TTL)
    if (idempotencyCacheKey) {
      const redis = getRedis();
      if (redis) {
        redis.set(idempotencyCacheKey, JSON.stringify({ status: 200, body: response }), 'EX', 300).catch(() => {});
      }
    }
    return c.json(response, { headers: getRateLimitHeaders(rateLimit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = tokenSource === 'static' ? 'STATIC_PROVIDER_ERROR' : 'NANGO_ERROR';
    logAudit({
      address: requesterAddress,
      provider,
      action: tokenSource === 'static' ? 'static_provider_error' : 'nango_error',
      ip: clientIp,
      userAgent,
      requestId,
      verificationState,
      ...paymentAudit,
      metadata: { error: message, source: tokenSource },
    });
    // Clear "processing" marker on failure so retries aren't blocked
    if (idempotencyCacheKey) {
      const redis = getRedis();
      if (redis) {
        redis.del(idempotencyCacheKey).catch(() => {});
      }
    }
    return c.json(
      { error: `Credential fetch error (${tokenSource}): ${message}`, code: errorCode } satisfies CredentialError,
      { status: 502, headers: getRateLimitHeaders(rateLimit) }
    );
  }
});

// Start server
const port = parseInt(env.PORT || "3001", 10);
console.log(`x402 Gateway running on :${port}`);
console.log(`Supabase: ${env.SUPABASE_URL}`);
console.log(`Ponder (runs): ${ponderUrl}`);

serve({ fetch: app.fetch, port });
