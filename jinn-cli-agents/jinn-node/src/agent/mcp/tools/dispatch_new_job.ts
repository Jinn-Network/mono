import { z } from 'zod';
import { graphQLRequest } from '../../../http/client.js';
import { randomUUID } from 'node:crypto';
import { getCurrentJobContext } from './shared/context.js';
import { dispatchToMarketplace } from '../../shared/dispatch-core.js';
import { validateInvariantsStrict } from '../../../worker/prompt/invariant-validator.js';
import { buildAnnotatedTools, normalizeToolArray, extractModelPolicyFromBlueprint } from '../../../shared/template-tools.js';
import { blueprintStructureSchema } from '../../shared/blueprint-schema.js';
import { BASE_UNIVERSAL_TOOLS } from '../../toolPolicy.js';
import { validateModelAllowed, normalizeGeminiModel, DEFAULT_WORKER_MODEL, AVAILABLE_MODELS, isKnownValidModel, KNOWN_VALID_MODELS } from '../../../shared/gemini-models.js';
import { config } from '../../../config/index.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dispatchNewJobParamsBase = z.object({
  jobName: z.string().min(1).describe('Name for this job definition'),
  blueprint: z.string().optional().describe('JSON string containing structured blueprint with invariants array. Each invariant must have: id, type (FLOOR/CEILING/RANGE/BOOLEAN), assessment, and type-specific fields (metric+min for FLOOR, metric+max for CEILING, metric+min+max for RANGE, condition for BOOLEAN). Optional: examples.'),
  model: z.enum(AVAILABLE_MODELS).optional().describe('Gemini model to use for this job. Defaults to "gemini-3-flash-preview" if not specified.'),
  enabledTools: z.array(z.string()).optional().describe('Array of tool names to enable for this job'),
  message: z.string().optional().describe('Optional message to include in the job request'),
  dependencies: z.array(z.string()).optional().describe('Array of job definition UUIDs (not job names) that must have at least one delivered request before this job can execute. Use get_details or search_jobs to find job definition IDs. Example: ["4eac1570-7980-4e2b-afc7-3f5159e99ea5"]'),
  skipBranch: z.boolean().optional().default(false).describe('If true, skip branch creation and code metadata collection. Auto-detected: branches are automatically skipped when CODE_METADATA_REPO_ROOT is not set and no parent branch context exists (artifact-only mode).'),
  responseTimeout: z.number().optional().default(61).describe('Response timeout in seconds for marketplace request. Defaults to 61 (just above the 60s on-chain minimum). This is the priority mech exclusivity window — after it expires, any staked mech can deliver. Min/max range is queried from the on-chain marketplace contract.'),
  inputSchema: z.record(z.any()).optional().describe('Input schema for template defaults. Used by x402 gateway to substitute default values for optional fields.'),
});

export const dispatchNewJobParams = dispatchNewJobParamsBase;

export const dispatchNewJobSchema = {
  description: `Create a new job definition and dispatch a new marketplace request using a structured JSON blueprint.

IMPORTANT: This tool ALWAYS creates a new job definition with a unique ID and posts a new on-chain marketplace request.
- Each call creates a distinct job instance (node in the work graph)
- To re-run an existing job, use dispatch_existing_job instead

WHEN TO USE THIS TOOL:
- Creating a new child job with a different purpose than existing jobs
- Breaking work into new sub-tasks that don't have job definitions yet
- Each call creates a brand new job definition with a new UUID

WHEN NOT TO USE (use dispatch_existing_job instead):
- Re-running an existing job definition (iteration/retry)
- You want multiple requests to share the same job container and workstream
- Continuing work in an established job context

BLUEPRINT FORMAT (REQUIRED):
The blueprint must be a JSON string with an invariants array. Each invariant has:
- id: Unique identifier (e.g., "JOB-001")
- type: One of "FLOOR", "CEILING", "RANGE", or "BOOLEAN"
- assessment: How to verify/measure this invariant
- Type-specific fields:
  - FLOOR: metric (string), min (number) - "metric must be at least min"
  - CEILING: metric (string), max (number) - "metric must be at most max"
  - RANGE: metric (string), min (number), max (number) - "metric must be between min and max"
  - BOOLEAN: condition (string) - "condition must be true"

Example with all four types:
{
  "invariants": [
    {
      "id": "QUAL-001",
      "type": "FLOOR",
      "metric": "content_quality_score",
      "min": 70,
      "assessment": "Rate 0-100 based on originality and depth"
    },
    {
      "id": "COST-001",
      "type": "CEILING",
      "metric": "compute_cost_usd",
      "max": 20,
      "assessment": "Sum API costs from telemetry"
    },
    {
      "id": "FREQ-001",
      "type": "RANGE",
      "metric": "posts_per_week",
      "min": 3,
      "max": 7,
      "assessment": "Count posts published in last 7 days"
    },
    {
      "id": "BUILD-001",
      "type": "BOOLEAN",
      "condition": "You ensure the build passes without errors",
      "assessment": "Run yarn build and verify exit code is 0"
    }
  ]
}

INVARIANT SCOPING (CRITICAL):
When creating child jobs, write NEW invariants specific to that child's responsibility.
Do NOT copy-paste parent invariants that span multiple concerns.
Example - If parent has "ship 3 games: Snake, 2048, Minesweeper":
  - 2048-child: { type: "BOOLEAN", condition: "You implement 2048 tile-merging puzzle with score tracking", assessment: "Verify game loads and tiles merge correctly" }
  - Snake-child: { type: "BOOLEAN", condition: "You implement Snake with growing snake and collision", assessment: "Verify snake grows when eating food" }
  - Minesweeper-child: { type: "BOOLEAN", condition: "You implement Minesweeper with mine reveal logic", assessment: "Verify mines trigger game over on click" }
Each child sees only its own scope, not requirements for sibling work.

PARAMETERS:
- jobName: (required) Name for this job definition
- blueprint: (required) JSON string containing structured invariants array as defined above
- model: (optional) Gemini model to use (defaults to "gemini-3-flash-preview")
- enabledTools: (optional) Array of tool names to enable
- message: (optional) Additional message to include in the job request
- dependencies: (optional) Array of job definition UUIDs (not job names) that must have at least one delivered request before this job executes. Use get_details or search_jobs to find job definition IDs.
- responseTimeout: (optional) Priority mech exclusivity window in seconds (defaults to 61, range 60-300). After this window, any staked mech can deliver.

The blueprint is validated and made directly available to the agent in blueprint context.`,
  inputSchema: dispatchNewJobParamsBase.shape,
};

function ensureUuid(): string {
  if (typeof randomUUID === 'function') return randomUUID();
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  throw new Error('crypto.randomUUID not available; cannot generate strict UUID');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchDependencyPresence(params: { gqlUrl: string; ids: string[] }): Promise<Set<string>> {
  const { gqlUrl, ids } = params;
  if (ids.length === 0) return new Set();
  const result = await graphQLRequest<{
    jobDefinitions: { items: Array<{ id: string }> };
    requests: { items: Array<{ jobDefinitionId?: string | null }> };
  }>({
    url: gqlUrl,
    query: `query DependencyPresence($ids: [String!]!) {
      jobDefinitions(where: { id_in: $ids }) {
        items { id }
      }
      requests(where: { jobDefinitionId_in: $ids }, limit: 200) {
        items { jobDefinitionId }
      }
    }`,
    variables: { ids },
    maxRetries: 1,
    context: { operation: 'dependencyPresence', idsCount: ids.length },
  });

  const found = new Set<string>();
  for (const item of result?.jobDefinitions?.items || []) {
    found.add(String(item.id).toLowerCase());
  }
  for (const item of result?.requests?.items || []) {
    if (item?.jobDefinitionId) {
      found.add(String(item.jobDefinitionId).toLowerCase());
    }
  }
  return found;
}

async function validateDependencies(params: { gqlUrl: string; dependencies: string[] }): Promise<{
  ok: boolean;
  invalid: string[];
  missing: string[];
}> {
  const { gqlUrl, dependencies } = params;
  if (dependencies.length === 0) {
    return { ok: true, invalid: [], missing: [] };
  }

  const invalid = dependencies.filter(dep => !UUID_REGEX.test(dep));
  if (invalid.length > 0) {
    return { ok: false, invalid, missing: [] };
  }

  const retries = Math.max(1, Number(process.env.JINN_DEPENDENCY_VALIDATION_RETRIES || 3));
  const delayMs = Math.max(0, Number(process.env.JINN_DEPENDENCY_VALIDATION_DELAY_MS || 500));
  const normalized = dependencies.map(dep => dep.toLowerCase());

  let missing: string[] = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const found = await fetchDependencyPresence({ gqlUrl, ids: dependencies });
    missing = normalized.filter(dep => !found.has(dep));
    if (missing.length === 0) {
      return { ok: true, invalid: [], missing: [] };
    }
    if (attempt < retries && delayMs > 0) {
      await sleep(delayMs * attempt);
    }
  }

  const missingOriginal = dependencies.filter(dep => missing.includes(dep.toLowerCase()));
  return { ok: false, invalid: [], missing: missingOriginal };
}

function getCompletedChildRequestIdsFromEnv(): string[] {
  const raw = process.env.JINN_CTX_COMPLETED_CHILDREN;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id: unknown) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function requireChildReviewIfNeeded(): string | null {
  const completedChildIds = getCompletedChildRequestIdsFromEnv();
  if (completedChildIds.length === 0) {
    return null;
  }
  if (process.env.JINN_CTX_CHILD_WORK_REVIEWED === 'true') {
    return null;
  }
  const previewIds = completedChildIds.slice(0, 3).join(', ');
  return `Completed child job(s) already exist (${previewIds}). Use the get_details tool with those request IDs (and resolve_ipfs=true) to review their artifacts before dispatching new work.`;
}

export async function dispatchNewJob(args: unknown) {
  try {
    if (process.env.MCP_DEBUG_MECH_CLIENT === '1') {
      try {
        const { createRequire } = await import('node:module');
        const r = (createRequire as any)(import.meta.url);
        const resolved = r.resolve('mech-client-ts/dist/marketplace_interact.js');
        console.error('[mcp-debug] mech-client resolve =', resolved);
      } catch { }
    }
    const parsed = dispatchNewJobParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const childReviewMessage = requireChildReviewIfNeeded();
    if (childReviewMessage) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'CHILD_REVIEW_REQUIRED', message: childReviewMessage },
          }),
        }],
      };
    }

    const { jobName, blueprint, model, enabledTools: requestedTools, message, dependencies, skipBranch, responseTimeout, inputSchema } = parsed.data;
    const context = getCurrentJobContext();

    // Normalize tools to string arrays (handles both string and object formats)
    const requiredTools = normalizeToolArray(context.requiredTools);
    const availableTools = normalizeToolArray(context.availableTools);
    const normalizedRequestedTools = normalizeToolArray(requestedTools);
    const mergedRequestedTools = [
      ...normalizedRequestedTools,
      ...requiredTools,
    ];

    if (!blueprint) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: 'blueprint is required and cannot be empty' },
          }),
        }],
      };
    }

    if (dependencies && dependencies.length > 0 && process.env.JINN_SKIP_DEPENDENCY_VALIDATION !== '1') {
      const gqlUrl = config.services.ponderUrl;
      const validation = await validateDependencies({ gqlUrl, dependencies });
      if (!validation.ok) {
        if (validation.invalid.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                data: null,
                meta: {
                  ok: false,
                  code: 'INVALID_DEPENDENCY_ID',
                  message: `Dependencies must be job definition UUIDs. Invalid: ${validation.invalid.join(', ')}`,
                  details: { invalidDependencies: validation.invalid },
                },
              }),
            }],
          };
        }

        if (validation.missing.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                data: null,
                meta: {
                  ok: false,
                  code: 'MISSING_DEPENDENCY',
                  message: `Dependency job definition(s) not found in Ponder: ${validation.missing.join(', ')}`,
                  details: { missingDependencies: validation.missing },
                },
              }),
            }],
          };
        }
      }
    }

    if (availableTools.length > 0) {
      // Universal tools are always allowed - filter them out before validation
      const universalSet = new Set(BASE_UNIVERSAL_TOOLS.map(t => t.toLowerCase()));
      const toolsToValidate = mergedRequestedTools.filter(
        (tool) => !universalSet.has(tool.toLowerCase())
      );

      const availableSet = new Set(availableTools.map((tool) => tool.toLowerCase()));
      const disallowedTools = toolsToValidate.filter((tool) => !availableSet.has(tool.toLowerCase()));
      if (disallowedTools.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'UNAUTHORIZED_TOOLS',
                message: `enabledTools not allowed by template policy: ${disallowedTools.join(', ')}.`,
                details: {
                  disallowedTools,
                  availableTools,
                },
              },
            }),
          }],
        };
      }
    }

    // Validate blueprint structure
    let blueprintObj: any;
    try {
      blueprintObj = JSON.parse(blueprint);
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'INVALID_BLUEPRINT',
              message: `blueprint must be valid JSON: ${error instanceof Error ? error.message : 'Parse error'}`
            },
          }),
        }],
      };
    }

    const blueprintValidation = blueprintStructureSchema.safeParse(blueprintObj);
    if (!blueprintValidation.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'INVALID_BLUEPRINT_STRUCTURE',
              message: `blueprint structure is invalid: ${blueprintValidation.error.message}`
            },
          }),
        }],
      };
    }

    // Semantic validation using the comprehensive invariant validator
    // This catches errors like RANGE with min > max
    try {
      validateInvariantsStrict(blueprintObj.invariants);
    } catch (validationError: any) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'INVALID_INVARIANT_SEMANTICS',
              message: validationError.message || String(validationError)
            },
          }),
        }],
      };
    }

    // Model validation: check for deprecated models and template policy
    const modelPolicy = extractModelPolicyFromBlueprint(blueprintObj);
    const modelToUse = model || modelPolicy.defaultModel;

    // 1. Check for deprecated models (always rejected)
    const modelValidation = validateModelAllowed(modelToUse);
    if (!modelValidation.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'DEPRECATED_MODEL',
              message: modelValidation.reason,
              details: {
                requestedModel: modelToUse,
                suggestion: modelValidation.suggestion,
                allowedModels: modelPolicy.allowedModels.length > 0
                  ? modelPolicy.allowedModels
                  : undefined,
              },
            },
          }),
        }],
      };
    }

    // 2. Check against template whitelist (if defined)
    if (modelPolicy.allowedModels.length > 0) {
      const normalizedRequested = normalizeGeminiModel(modelToUse, modelPolicy.defaultModel).normalized;
      const allowedSet = new Set(modelPolicy.allowedModels.map(m =>
        normalizeGeminiModel(m, modelPolicy.defaultModel).normalized
      ));

      if (!allowedSet.has(normalizedRequested)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'UNAUTHORIZED_MODEL',
                message: `Model not allowed by template policy: ${modelToUse}`,
                details: {
                  requestedModel: modelToUse,
                  allowedModels: modelPolicy.allowedModels,
                  defaultModel: modelPolicy.defaultModel,
                },
              },
            }),
          }],
        };
      }
    }

    // 3. Check against parent context allowlist (cascaded from workstream root)
    const parentAllowedModels = context.allowedModels;
    if (Array.isArray(parentAllowedModels) && parentAllowedModels.length > 0) {
      const normalizedRequested = normalizeGeminiModel(modelToUse, DEFAULT_WORKER_MODEL).normalized;
      const parentAllowedSet = new Set(parentAllowedModels.map(m =>
        normalizeGeminiModel(m, DEFAULT_WORKER_MODEL).normalized
      ));
      if (!parentAllowedSet.has(normalizedRequested)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'UNAUTHORIZED_MODEL',
                message: `Model not allowed by workstream policy: ${modelToUse}`,
                details: {
                  requestedModel: modelToUse,
                  allowedModels: parentAllowedModels,
                },
              },
            }),
          }],
        };
      }
    }

    // 4. Fallback: reject unknown models when no explicit policy configured
    const hasExplicitPolicy = modelPolicy.allowedModels.length > 0 ||
      (Array.isArray(parentAllowedModels) && parentAllowedModels.length > 0);
    if (!hasExplicitPolicy) {
      const normalizedToCheck = normalizeGeminiModel(modelToUse, DEFAULT_WORKER_MODEL).normalized;
      if (!isKnownValidModel(normalizedToCheck)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'UNKNOWN_MODEL',
                message: `Model '${modelToUse}' is not a recognized Gemini model. Use one of the known-valid models.`,
                details: {
                  requestedModel: modelToUse,
                  normalizedModel: normalizedToCheck,
                  knownValidModels: Array.from(KNOWN_VALID_MODELS),
                  suggestion: DEFAULT_WORKER_MODEL,
                },
              },
            }),
          }],
        };
      }
    }

    // Use validated model
    const validatedModel = modelToUse;

    const finalBlueprint = blueprint;
    const gqlUrl = config.services.ponderUrl;

    // Generate unique job definition ID
    const jobDefinitionId: string = ensureUuid();

    // Validate dependencies before building payload (agent-specific validation)
    if (dependencies && dependencies.length > 0) {
      // Validate that all dependencies are UUIDs (not job names)
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const invalidDeps = dependencies.filter(dep => !UUID_REGEX.test(dep));

      if (invalidDeps.length > 0) {
        console.error('[dispatch_new_job] Invalid dependencies - must be UUIDs, not job names:', invalidDeps);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'INVALID_DEPENDENCIES',
                message: `Dependencies must be job definition UUIDs, not job names. Invalid: ${invalidDeps.join(', ')}. Use get_details or search_jobs to find job definition IDs.`,
              },
            }),
          }],
        };
      }

      // CRITICAL: Prevent circular dependencies with parent job
      const context = getCurrentJobContext();
      const parentJobDefinitionId = context.jobDefinitionId;
      if (parentJobDefinitionId && dependencies.includes(parentJobDefinitionId)) {
        console.error('[dispatch_new_job] CIRCULAR_DEPENDENCY: Child job cannot depend on its parent job:', parentJobDefinitionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'CIRCULAR_DEPENDENCY',
                message: `Child job cannot depend on its parent job (${parentJobDefinitionId}). This creates a deadlock: parent waits for children, children wait for parent. Dependencies should only be between sibling jobs (other children) to control execution order.`,
              },
            }),
          }],
        };
      }
    }

    // Build IPFS payload + post to marketplace via shared dispatch core
    // Note: Agents cannot set cyclic or additionalContextOverrides
    try {
      const toolPolicy = availableTools && availableTools.length > 0
        ? { requiredTools, availableTools }
        : (requiredTools.length > 0 ? { requiredTools, availableTools: requiredTools } : null);
      const tools = toolPolicy ? buildAnnotatedTools(toolPolicy) : undefined;

      const dispatchResult = await dispatchToMarketplace({
        blueprint: finalBlueprint,
        jobName,
        jobDefinitionId,
        model: validatedModel,
        enabledTools: mergedRequestedTools,
        tools,
        skipBranch,
        dependencies,
        message,
        inputSchema,
        allowedModels: parentAllowedModels || (modelPolicy.allowedModels.length > 0 ? modelPolicy.allowedModels : undefined),
        responseTimeout,
        // Propagate venture lineage from parent context
        ventureId: context.ventureId || undefined,
        // cyclic and additionalContextOverrides intentionally NOT passed
        // These are only available to human-initiated dispatches
      });

      if (dispatchResult.requestIds.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: dispatchResult.rawResult ?? null,
              meta: {
                ok: false,
                code: 'DISPATCH_FAILED',
                message: 'Marketplace dispatch did not return any request IDs. Verify MECH configuration, funding, and private key setup.',
              },
            }),
          }],
        };
      }

      // Best-effort IPFS gateway URL enrichment
      let ipfsGatewayUrl: string | null = null;
      try {
        const firstRequestId = dispatchResult.requestIds[0];
        if (firstRequestId && gqlUrl) {
          const query = `query ($id: String!) { request(id: $id) { ipfsHash } }`;
          for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            try {
              const lookupResult = await graphQLRequest<{
                request: { ipfsHash?: string } | null;
              }>({
                url: gqlUrl,
                query,
                variables: { id: firstRequestId },
                maxRetries: 0,
                context: { operation: 'pollIpfsHash', requestId: firstRequestId, attempt }
              });
              const ipfsHash = lookupResult?.request?.ipfsHash;
              if (ipfsHash) {
                ipfsGatewayUrl = `https://gateway.autonolas.tech/ipfs/${ipfsHash}`;
                break;
              }
            } catch {
              continue;
            }
          }
        }
      } catch (lookupError) {
        // IPFS enrichment is best-effort
      }

      const enriched = {
        ...dispatchResult.rawResult,
        jobDefinitionId,
        ipfs_gateway_url: ipfsGatewayUrl,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: enriched,
            meta: { ok: true }
          }),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'EXECUTION_ERROR', message: error?.message || String(error) },
          }),
        }],
      };
    }
  } catch (error: any) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'UNEXPECTED_ERROR', message: error?.message || String(error) },
        }),
      }],
    };
  }
}
