export interface JobContext {
  jobId: string | null;
  jobDefinitionId: string | null;
  jobName: string | null;
  threadId: string | null;
  projectRunId: string | null;
  sourceEventId: string | null;
  projectDefinitionId: string | null;
  requestId?: string | null;
  mechAddress?: string | null;
  baseBranch?: string | null;
  workstreamId?: string | null;
  ventureId?: string | null;
  parentRequestId?: string | null;
  branchName?: string | null;
  requiredTools?: string[] | null;
  availableTools?: string[] | null;
  allowedModels?: string[] | null;
  defaultModel?: string | null;
}

// Canonical: read from environment only
export function getCurrentJobContext(): JobContext {
  return {
    jobId: process.env.JINN_CTX_JOB_ID || null,
    jobDefinitionId: process.env.JINN_CTX_JOB_DEFINITION_ID || null,
    jobName: process.env.JINN_CTX_JOB_NAME || null,
    threadId: process.env.JINN_CTX_THREAD_ID || null,
    projectRunId: process.env.JINN_CTX_PROJECT_RUN_ID || null,
    sourceEventId: process.env.JINN_CTX_SOURCE_EVENT_ID || null,
    projectDefinitionId: process.env.JINN_CTX_PROJECT_DEFINITION_ID || null,
    requestId: process.env.JINN_CTX_REQUEST_ID || null,
    mechAddress: process.env.JINN_CTX_MECH_ADDRESS || null,
    baseBranch: process.env.JINN_CTX_BASE_BRANCH || null,
    workstreamId: process.env.JINN_CTX_WORKSTREAM_ID || null,
    ventureId: process.env.JINN_CTX_VENTURE_ID || null,
    parentRequestId: process.env.JINN_CTX_PARENT_REQUEST_ID || null,
    branchName: process.env.JINN_CTX_BRANCH_NAME || null,
    requiredTools: process.env.JINN_CTX_REQUIRED_TOOLS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_REQUIRED_TOOLS as string);
          } catch {
            return null;
          }
        })()
      : null,
    availableTools: process.env.JINN_CTX_AVAILABLE_TOOLS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_AVAILABLE_TOOLS as string);
          } catch {
            return null;
          }
        })()
      : null,
    allowedModels: process.env.JINN_CTX_ALLOWED_MODELS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_ALLOWED_MODELS as string);
          } catch {
            return null;
          }
        })()
      : null,
    defaultModel: process.env.JINN_CTX_DEFAULT_MODEL || null,
  };
}

// Back-compat helpers for tests: set/clear via env (still canonical path)
export function setJobContext(
  jobId: string | null,
  jobName: string | null,
  threadId?: string | null,
  projectRunId?: string | null,
  projectDefinitionId?: string | null,
  jobDefinitionId?: string | null,
  baseBranch?: string | null,
  parentRequestId?: string | null,
  branchName?: string | null,
  workstreamId?: string | null,
  requiredTools?: string[] | null,
  availableTools?: string[] | null
) {
  if (jobId) process.env.JINN_CTX_JOB_ID = jobId; else delete process.env.JINN_CTX_JOB_ID;
  if (jobName) process.env.JINN_CTX_JOB_NAME = jobName; else delete process.env.JINN_CTX_JOB_NAME;
  if (threadId !== undefined) {
    if (threadId) process.env.JINN_CTX_THREAD_ID = threadId; else delete process.env.JINN_CTX_THREAD_ID;
  }
  if (projectRunId !== undefined) {
    if (projectRunId) process.env.JINN_CTX_PROJECT_RUN_ID = projectRunId; else delete process.env.JINN_CTX_PROJECT_RUN_ID;
  }
  if (projectDefinitionId !== undefined) {
    if (projectDefinitionId) process.env.JINN_CTX_PROJECT_DEFINITION_ID = projectDefinitionId; else delete process.env.JINN_CTX_PROJECT_DEFINITION_ID;
  }
  if (jobDefinitionId !== undefined) {
    if (jobDefinitionId) process.env.JINN_CTX_JOB_DEFINITION_ID = jobDefinitionId; else delete process.env.JINN_CTX_JOB_DEFINITION_ID;
  }
  if (baseBranch !== undefined) {
    if (baseBranch) process.env.JINN_CTX_BASE_BRANCH = baseBranch; else delete process.env.JINN_CTX_BASE_BRANCH;
  }
  if (workstreamId !== undefined) {
    if (workstreamId) process.env.JINN_CTX_WORKSTREAM_ID = workstreamId; else delete process.env.JINN_CTX_WORKSTREAM_ID;
  }
  // ventureId is set via worker metadata/jobContext.ts (JINN_CTX_VENTURE_ID env var)
  if (parentRequestId !== undefined) {
    if (parentRequestId) process.env.JINN_CTX_PARENT_REQUEST_ID = parentRequestId; else delete process.env.JINN_CTX_PARENT_REQUEST_ID;
  }
  if (branchName !== undefined) {
    if (branchName) process.env.JINN_CTX_BRANCH_NAME = branchName; else delete process.env.JINN_CTX_BRANCH_NAME;
  }
  if (requiredTools !== undefined) {
    if (requiredTools) process.env.JINN_CTX_REQUIRED_TOOLS = JSON.stringify(requiredTools); else delete process.env.JINN_CTX_REQUIRED_TOOLS;
  }
  if (availableTools !== undefined) {
    if (availableTools) process.env.JINN_CTX_AVAILABLE_TOOLS = JSON.stringify(availableTools); else delete process.env.JINN_CTX_AVAILABLE_TOOLS;
  }
}

export function clearJobContext() {
  delete process.env.JINN_CTX_JOB_ID;
  delete process.env.JINN_CTX_JOB_DEFINITION_ID;
  delete process.env.JINN_CTX_JOB_NAME;
  delete process.env.JINN_CTX_THREAD_ID;
  delete process.env.JINN_CTX_PROJECT_RUN_ID;
  delete process.env.JINN_CTX_SOURCE_EVENT_ID;
  delete process.env.JINN_CTX_PROJECT_DEFINITION_ID;
  delete process.env.JINN_CTX_BASE_BRANCH;
  delete process.env.JINN_CTX_WORKSTREAM_ID;
  delete process.env.JINN_CTX_VENTURE_ID;
  delete process.env.JINN_CTX_PARENT_REQUEST_ID;
  delete process.env.JINN_CTX_BRANCH_NAME;
  delete process.env.JINN_CTX_INHERITED_ENV;
  delete process.env.JINN_CTX_REQUIRED_TOOLS;
  delete process.env.JINN_CTX_AVAILABLE_TOOLS;
  delete process.env.JINN_CTX_ALLOWED_MODELS;
  delete process.env.JINN_CTX_DEFAULT_MODEL;
}
