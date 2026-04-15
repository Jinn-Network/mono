/**
 * Runtime job context — replaces JINN_CTX_* environment variables.
 *
 * Instead of writing to process.env per-job, these values live in memory.
 * The worker sets them before each job; MCP tools read them via getJobContext().
 *
 * IMPORTANT: The agent subprocess runs in a separate process. Context is passed
 * to it via process.env at spawn time (agent.ts reads from allowlisted env vars).
 * This module is for the *worker* process only. The agent process reads context
 * from its own process.env (set at spawn time by the worker).
 */

export interface JobContext {
    requestId?: string;
    jobId?: string;
    jobName?: string;
    jobDefinitionId?: string;
    projectRunId?: string;
    projectDefinitionId?: string;
    sourceEventId?: string;
    threadId?: string;
    mechAddress?: string;
    baseBranch?: string;
    workstreamId?: string;
    ventureId?: string;
    parentRequestId?: string;
    branchName?: string;
    completedChildRequestIds?: string[];
    childWorkReviewed?: boolean;
    requiredTools?: string[];
    availableTools?: string[];
    blueprintInvariantIds?: string[];
    allowedModels?: string[];
    defaultModel?: string;
    inheritedEnv?: string;
}

// In-memory context store
let _context: JobContext = {};

/**
 * Get the current job context.
 */
export function getJobContext(): Readonly<JobContext> {
    return Object.freeze({ ..._context });
}

/**
 * Set job context values (merges with existing).
 */
export function setJobContext(ctx: Partial<JobContext>): void {
    _context = { ..._context, ...ctx };
}

/**
 * Clear all job context values.
 */
export function clearJobContext(): void {
    _context = {};
}

/**
 * Snapshot the current context (for save/restore around nested jobs).
 */
export function snapshotJobContext(): JobContext {
    return { ..._context };
}

/**
 * Restore job context from a snapshot.
 */
export function restoreJobContext(snapshot: JobContext): void {
    _context = { ...snapshot };
}

/**
 * Write the current job context to process.env for agent subprocess inheritance.
 * Called by the worker just before spawning the agent process.
 */
export function writeContextToEnv(): void {
    const ctx = _context;
    const setOrDelete = (key: string, value: string | undefined) => {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
    };

    setOrDelete('JINN_CTX_REQUEST_ID', ctx.requestId);
    setOrDelete('JINN_CTX_JOB_ID', ctx.jobId);
    setOrDelete('JINN_CTX_JOB_NAME', ctx.jobName);
    setOrDelete('JINN_CTX_JOB_DEFINITION_ID', ctx.jobDefinitionId);
    setOrDelete('JINN_CTX_PROJECT_RUN_ID', ctx.projectRunId);
    setOrDelete('JINN_CTX_PROJECT_DEFINITION_ID', ctx.projectDefinitionId);
    setOrDelete('JINN_CTX_SOURCE_EVENT_ID', ctx.sourceEventId);
    setOrDelete('JINN_CTX_THREAD_ID', ctx.threadId);
    setOrDelete('JINN_CTX_MECH_ADDRESS', ctx.mechAddress);
    setOrDelete('JINN_CTX_BASE_BRANCH', ctx.baseBranch);
    setOrDelete('JINN_CTX_WORKSTREAM_ID', ctx.workstreamId);
    setOrDelete('JINN_CTX_VENTURE_ID', ctx.ventureId);
    setOrDelete('JINN_CTX_PARENT_REQUEST_ID', ctx.parentRequestId);
    setOrDelete('JINN_CTX_BRANCH_NAME', ctx.branchName);
    setOrDelete('JINN_CTX_DEFAULT_MODEL', ctx.defaultModel);
    setOrDelete('JINN_CTX_INHERITED_ENV', ctx.inheritedEnv);

    // Array values serialized as JSON
    if (ctx.completedChildRequestIds) {
        process.env.JINN_CTX_COMPLETED_CHILDREN = JSON.stringify(ctx.completedChildRequestIds);
    } else {
        delete process.env.JINN_CTX_COMPLETED_CHILDREN;
    }

    if (ctx.childWorkReviewed !== undefined) {
        process.env.JINN_CTX_CHILD_WORK_REVIEWED = ctx.childWorkReviewed ? 'true' : 'false';
    } else {
        delete process.env.JINN_CTX_CHILD_WORK_REVIEWED;
    }

    if (ctx.requiredTools) process.env.JINN_CTX_REQUIRED_TOOLS = JSON.stringify(ctx.requiredTools);
    else delete process.env.JINN_CTX_REQUIRED_TOOLS;

    if (ctx.availableTools) process.env.JINN_CTX_AVAILABLE_TOOLS = JSON.stringify(ctx.availableTools);
    else delete process.env.JINN_CTX_AVAILABLE_TOOLS;

    if (ctx.blueprintInvariantIds) process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS = JSON.stringify(ctx.blueprintInvariantIds);
    else delete process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS;

    if (ctx.allowedModels) process.env.JINN_CTX_ALLOWED_MODELS = JSON.stringify(ctx.allowedModels);
    else delete process.env.JINN_CTX_ALLOWED_MODELS;
}

/**
 * Read job context from process.env (for use in the MCP tool subprocess).
 * This is the equivalent of the old shared/context.ts getCurrentJobContext().
 */
export function readContextFromEnv(): JobContext {
    const parseJsonArray = (key: string): string[] | undefined => {
        const val = process.env[key];
        if (!val) return undefined;
        try { return JSON.parse(val); } catch { return undefined; }
    };

    return {
        requestId: process.env.JINN_CTX_REQUEST_ID || undefined,
        jobId: process.env.JINN_CTX_JOB_ID || undefined,
        jobName: process.env.JINN_CTX_JOB_NAME || undefined,
        jobDefinitionId: process.env.JINN_CTX_JOB_DEFINITION_ID || undefined,
        projectRunId: process.env.JINN_CTX_PROJECT_RUN_ID || undefined,
        projectDefinitionId: process.env.JINN_CTX_PROJECT_DEFINITION_ID || undefined,
        sourceEventId: process.env.JINN_CTX_SOURCE_EVENT_ID || undefined,
        threadId: process.env.JINN_CTX_THREAD_ID || undefined,
        mechAddress: process.env.JINN_CTX_MECH_ADDRESS || undefined,
        baseBranch: process.env.JINN_CTX_BASE_BRANCH || undefined,
        workstreamId: process.env.JINN_CTX_WORKSTREAM_ID || undefined,
        ventureId: process.env.JINN_CTX_VENTURE_ID || undefined,
        parentRequestId: process.env.JINN_CTX_PARENT_REQUEST_ID || undefined,
        branchName: process.env.JINN_CTX_BRANCH_NAME || undefined,
        defaultModel: process.env.JINN_CTX_DEFAULT_MODEL || undefined,
        inheritedEnv: process.env.JINN_CTX_INHERITED_ENV || undefined,
        completedChildRequestIds: parseJsonArray('JINN_CTX_COMPLETED_CHILDREN'),
        requiredTools: parseJsonArray('JINN_CTX_REQUIRED_TOOLS'),
        availableTools: parseJsonArray('JINN_CTX_AVAILABLE_TOOLS'),
        blueprintInvariantIds: parseJsonArray('JINN_CTX_BLUEPRINT_INVARIANT_IDS'),
        allowedModels: parseJsonArray('JINN_CTX_ALLOWED_MODELS'),
        childWorkReviewed: process.env.JINN_CTX_CHILD_WORK_REVIEWED !== undefined
            ? process.env.JINN_CTX_CHILD_WORK_REVIEWED === 'true'
            : undefined,
    };
}
