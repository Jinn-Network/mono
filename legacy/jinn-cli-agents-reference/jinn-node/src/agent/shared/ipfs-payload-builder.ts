/**
 * IPFS Payload Builder
 * 
 * Shared helper for constructing complete IPFS job payloads.
 * Used by both dispatchNewJob (agent-initiated) and launch_workstream (human-initiated).
 * 
 * This ensures all dispatches have consistent structure including:
 * - codeMetadata (branch, repo info)
 * - lineage (parent job tracking)
 * - additionalContext (hierarchy, summary)
 * - executionPolicy (branch enforcement)
 */

import { randomUUID } from 'node:crypto';
import { getCurrentJobContext } from '../mcp/tools/shared/context.js';
import { getJobContextForDispatch } from '../mcp/tools/shared/job-context-utils.js';
import { ensureUniversalTools } from '../toolPolicy.js';
import { parseAnnotatedTools, type TemplateToolSpec } from '../../shared/template-tools.js';
import { DEFAULT_WORKER_MODEL, normalizeGeminiModel } from '../../shared/gemini-models.js';
import { config } from '../../config/index.js';
import { assertValidJinnJobEnvMap } from '../../shared/job-env.js';
import {
    ensureJobBranch,
    collectLocalCodeMetadata,
    type CodeMetadata,
    type EnsureBranchResult,
} from './code_metadata.js';

/**
 * Options for building an IPFS job payload
 */
export interface BuildIpfsPayloadOptions {
    // Required fields
    blueprint: string;
    jobName: string;
    jobDefinitionId: string;

    // Optional behavior modifiers
    model?: string;
    enabledTools?: string[];
    tools?: TemplateToolSpec[];
    skipBranch?: boolean;
    dependencies?: string[];
    message?: string;

    /**
     * Input schema for template defaults.
     * Used by x402 gateway to substitute default values for optional fields.
     */
    inputSchema?: Record<string, any>;

    /**
     * Allowed models for child agents (cascaded from blueprint/workstream policy).
     */
    allowedModels?: string[];

    /**
     * Enable cyclic (continuous) operation.
     * Only available to human-initiated dispatches, not agent tools.
     */
    cyclic?: boolean;

    /**
     * Existing codeMetadata from job definition (for redispatches).
     * When provided, skips fresh metadata collection and uses this instead.
     * This enables redispatch scripts to preserve coding tool capabilities.
     */
    codeMetadata?: CodeMetadata | null;

    /**
     * Explicit workstream override for human-initiated dispatches.
     */
    workstreamId?: string;

    /**
     * Venture ID for scheduled dispatches. Propagates to child jobs.
     */
    ventureId?: string;

    /**
     * Template ID that generated this dispatch. Propagates to child jobs.
     */
    templateId?: string;

    /**
     * Additional context overrides for multi-tenant products.
     * Only available to human-initiated dispatches, not agent tools.
     * 
     * - env: Environment variables to inject into the worker
     * - workspaceRepo: Repository to clone as the workspace
     */
    additionalContextOverrides?: {
        env?: Record<string, string>;
        workspaceRepo?: { url: string; branch?: string };
    };
}

/**
 * Result of building an IPFS payload
 */
export interface BuildIpfsPayloadResult {
    /** Complete IPFS JSON contents array ready for marketplaceInteract */
    ipfsJsonContents: any[];

    /** Branch creation result, if a branch was created */
    branchResult?: EnsureBranchResult;

    /** Collected code metadata, if available */
    codeMetadata?: CodeMetadata | null;
}

/**
 * Build a complete IPFS job payload with all required fields.
 * 
 * This is the single source of truth for payload construction, ensuring
 * consistency between agent-initiated and human-initiated dispatches.
 */
export async function buildIpfsPayload(
    options: BuildIpfsPayloadOptions
): Promise<BuildIpfsPayloadResult> {
    const {
        blueprint,
        jobName,
        jobDefinitionId,
        model = DEFAULT_WORKER_MODEL,
        enabledTools: requestedTools,
        tools,
        skipBranch = false,
        dependencies,
        message,
        allowedModels: explicitAllowedModels,
        cyclic = false,
        workstreamId,
        ventureId,
        templateId,
        additionalContextOverrides,
        inputSchema,
    } = options;

    // Ensure universal tools are included
    let enabledTools = ensureUniversalTools(requestedTools);
    const toolPolicy = parseAnnotatedTools(tools);
    const normalizedModel = normalizeGeminiModel(model, DEFAULT_WORKER_MODEL);

    // Get current job context (if running inside an agent)
    const context = getCurrentJobContext();

    // Build lineage context for workstream tracking
    const lineageContext: Record<string, any> = {};
    if (context.requestId) lineageContext.sourceRequestId = context.requestId;
    if (context.jobDefinitionId) lineageContext.sourceJobDefinitionId = context.jobDefinitionId;
    if (workstreamId) {
        lineageContext.workstreamId = workstreamId;
    } else if (context.workstreamId) {
        lineageContext.workstreamId = context.workstreamId;
    }
    if (ventureId) {
        lineageContext.ventureId = ventureId;
    } else if (context.ventureId) {
        lineageContext.ventureId = context.ventureId;
    }
    if (templateId) {
        lineageContext.templateId = templateId;
    }

    // Fetch job hierarchy for additionalContext
    const jobContext = await getJobContextForDispatch(jobDefinitionId, 3);

    // Build additionalContext with hierarchy, summary, and message
    let additionalContext: Record<string, any> = {};

    // Add hierarchy and summary from job context
    if (jobContext) {
        if (jobContext.hierarchy) {
            additionalContext.hierarchy = jobContext.hierarchy;
        }
        if (jobContext.summary) {
            additionalContext.summary = jobContext.summary;
        }
    }

    // Add message if provided
    if (message) {
        let messageObj: any = null;
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage && typeof parsedMessage === 'object' && parsedMessage.content) {
                messageObj = parsedMessage;
            }
        } catch {
            // ignore parse error
        }

        additionalContext.message = messageObj || {
            content: message,
            to: jobDefinitionId,
            from: context.jobDefinitionId || undefined,
        };
    }

    // Inherit parent job payload env for workstream-level config propagation.
    const inheritedEnvJson = process.env.JINN_CTX_INHERITED_ENV;
    if (inheritedEnvJson && !additionalContextOverrides?.env) {
        let parsedInheritedEnv: unknown;
        try {
            parsedInheritedEnv = JSON.parse(inheritedEnvJson);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid JINN_CTX_INHERITED_ENV JSON: ${message}`);
        }
        additionalContext.env = assertValidJinnJobEnvMap(parsedInheritedEnv, 'JINN_CTX_INHERITED_ENV');
    }

    // Merge additionalContextOverrides (human-only fields, takes precedence)
    if (additionalContextOverrides) {
        if (additionalContextOverrides.env) {
            additionalContext.env = assertValidJinnJobEnvMap(
                additionalContextOverrides.env,
                'additionalContextOverrides.env',
            );
        }
        if (additionalContextOverrides.workspaceRepo) {
            additionalContext.workspaceRepo = additionalContextOverrides.workspaceRepo;
        }
    }

    // Determine if we should create a branch
    const hasRepoRoot = Boolean(process.env.CODE_METADATA_REPO_ROOT);
    const hasParentBranchContext = Boolean(context.branchName || context.baseBranch);
    const missingRepoContext = !hasRepoRoot && !hasParentBranchContext;
    const shouldCreateBranch = !skipBranch && !missingRepoContext;
    const shouldKeepRepoContext = !shouldCreateBranch && !missingRepoContext;

    const baseBranch =
        context.branchName ||
        context.baseBranch ||
        config.git.defaultBaseBranch;

    let branchResult: EnsureBranchResult | undefined;
    // Use provided codeMetadata (from redispatch) or prepare to collect fresh
    let codeMetadata: CodeMetadata | null = options.codeMetadata || null;

    // Helper to build metadata hints
    const getMetadataHints = (targetBranchName?: string) => ({
        jobDefinitionId,
        parent:
            context.jobDefinitionId || context.requestId
                ? {
                    jobDefinitionId: context.jobDefinitionId || undefined,
                    requestId: context.requestId || undefined,
                }
                : undefined,
        baseBranch,
        branchName: targetBranchName,
    });

    // Create branch and collect metadata (skip if codeMetadata already provided)
    if (shouldCreateBranch && !codeMetadata) {
        try {
            branchResult = await ensureJobBranch({
                jobDefinitionId,
                jobName,
                baseBranch,
            });

            codeMetadata = await collectLocalCodeMetadata(getMetadataHints(branchResult.branchName));
        } catch (branchError: any) {
            // Re-throw with context
            throw new Error(`Failed to create job branch or collect metadata: ${branchError.message}`);
        }
    } else if (shouldKeepRepoContext && !codeMetadata) {
        // Skip creating a new branch, but preserve repo context
        try {
            codeMetadata = await collectLocalCodeMetadata(getMetadataHints(undefined));
        } catch (metadataError: any) {
            console.warn('[buildIpfsPayload] Failed to collect local metadata (non-critical):', metadataError);
            // Continue without code metadata - job will be artifact-only
        }
    }

    // Routing contract: coding jobs (codeMetadata present) must include process_branch
    // so workers can apply github capability filtering pre-claim.
    if (codeMetadata) {
        enabledTools = Array.from(new Set([...enabledTools, 'process_branch']));
    } else {
        enabledTools = Array.from(new Set(enabledTools));
    }

    // Build lineage object
    const lineage =
        context.requestId ||
            context.jobDefinitionId ||
            context.parentRequestId ||
            context.branchName ||
            context.baseBranch
            ? {
                dispatcherRequestId: context.requestId || undefined,
                dispatcherJobDefinitionId: context.jobDefinitionId || undefined,
                parentDispatcherRequestId: context.parentRequestId || undefined,
                dispatcherBranchName: context.branchName || undefined,
                dispatcherBaseBranch: context.baseBranch || undefined,
            }
            : undefined;

    // Resolve allowed models: explicit option > parent context inheritance
    const allowedModels = explicitAllowedModels || (
        context.allowedModels && Array.isArray(context.allowedModels) && context.allowedModels.length > 0
            ? [...context.allowedModels]
            : undefined
    );

    // Assemble the complete IPFS payload
    const ipfsJsonContents: any[] = [{
        blueprint,
        jobName,
        model: normalizedModel.normalized,
        enabledTools,
        ...(toolPolicy.availableTools.length > 0 ? { tools } : {}),
        ...(allowedModels ? { allowedModels } : {}),
        jobDefinitionId,
        nonce: randomUUID(),
        networkId: 'jinn',
        additionalContext: Object.keys(additionalContext).length > 0 ? additionalContext : undefined,
        ...(branchResult ? { branchName: branchResult.branchName, baseBranch } : {}),
        ...lineageContext,
        ...(inputSchema ? { inputSchema } : {}),
    }];

    // Add dependencies at root level if provided
    if (dependencies && dependencies.length > 0) {
        ipfsJsonContents[0].dependencies = dependencies;
    }

    // Add lineage if present
    if (lineage) {
        ipfsJsonContents[0].lineage = lineage;
    }

    // Add codeMetadata if collected
    if (codeMetadata) {
        ipfsJsonContents[0].codeMetadata = codeMetadata;
    }

    // Add executionPolicy if branch was created
    if (branchResult) {
        ipfsJsonContents[0].executionPolicy = {
            branch: branchResult.branchName,
            ensureTestsPass: true,
            description: 'Agent must work on the provided branch and pass required validations before finalizing.',
        };
    }

    // Add cyclic flag if enabled
    if (cyclic) {
        ipfsJsonContents[0].cyclic = true;
    }

    return {
        ipfsJsonContents,
        branchResult,
        codeMetadata,
    };
}
