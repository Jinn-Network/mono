/**
 * Job context management: setting and clearing JINN_* environment variables
 */

/**
 * Set job context environment variables
 */
export function setJobContext(params: {
  requestId?: string;
  jobDefinitionId?: string | null;
  baseBranch?: string;
  mechAddress?: string;
  workstreamId?: string;
  ventureId?: string;
  parentRequestId?: string;
  branchName?: string;
  completedChildRequestIds?: string[];
  requiredTools?: string[];
  availableTools?: string[];
  blueprintInvariantIds?: string[];
  allowedModels?: string[];
  defaultModel?: string;
}): void {
  const {
    requestId,
    jobDefinitionId,
    baseBranch,
    mechAddress,
    workstreamId,
    ventureId,
    parentRequestId,
    branchName,
    completedChildRequestIds,
    requiredTools,
    availableTools,
    blueprintInvariantIds,
    allowedModels,
    defaultModel,
  } = params;
  
  if (requestId) {
    process.env.JINN_CTX_REQUEST_ID = requestId;
  }
  
  if (jobDefinitionId) {
    process.env.JINN_CTX_JOB_DEFINITION_ID = jobDefinitionId;
  }
  
  if (baseBranch) {
    process.env.JINN_CTX_BASE_BRANCH = baseBranch;
  }
  
  if (mechAddress) {
    process.env.JINN_CTX_MECH_ADDRESS = mechAddress;
  }

  if (workstreamId) {
    process.env.JINN_CTX_WORKSTREAM_ID = workstreamId;
  }

  if (ventureId) {
    process.env.JINN_CTX_VENTURE_ID = ventureId;
  }

  if (parentRequestId) {
    process.env.JINN_CTX_PARENT_REQUEST_ID = parentRequestId;
  }

  if (branchName) {
    process.env.JINN_CTX_BRANCH_NAME = branchName;
  }

  if (Array.isArray(completedChildRequestIds)) {
    if (completedChildRequestIds.length > 0) {
      process.env.JINN_CTX_COMPLETED_CHILDREN = JSON.stringify(completedChildRequestIds);
      process.env.JINN_CTX_CHILD_WORK_REVIEWED = 'false';
    } else {
      process.env.JINN_CTX_COMPLETED_CHILDREN = '[]';
      process.env.JINN_CTX_CHILD_WORK_REVIEWED = 'true';
    }
  } else {
    delete process.env.JINN_CTX_COMPLETED_CHILDREN;
    delete process.env.JINN_CTX_CHILD_WORK_REVIEWED;
  }

  if (Array.isArray(requiredTools)) {
    process.env.JINN_CTX_REQUIRED_TOOLS = JSON.stringify(requiredTools);
  } else {
    delete process.env.JINN_CTX_REQUIRED_TOOLS;
  }

  if (Array.isArray(availableTools)) {
    process.env.JINN_CTX_AVAILABLE_TOOLS = JSON.stringify(availableTools);
  } else {
    delete process.env.JINN_CTX_AVAILABLE_TOOLS;
  }

  if (Array.isArray(blueprintInvariantIds)) {
    process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS = JSON.stringify(blueprintInvariantIds);
  } else {
    delete process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS;
  }

  if (Array.isArray(allowedModels)) {
    process.env.JINN_CTX_ALLOWED_MODELS = JSON.stringify(allowedModels);
  } else {
    delete process.env.JINN_CTX_ALLOWED_MODELS;
  }

  if (defaultModel) {
    process.env.JINN_CTX_DEFAULT_MODEL = defaultModel;
  } else {
    delete process.env.JINN_CTX_DEFAULT_MODEL;
  }
}

/**
 * Clear job context environment variables
 */
export function clearJobContext(): void {
  delete process.env.JINN_CTX_REQUEST_ID;
  delete process.env.JINN_CTX_JOB_DEFINITION_ID;
  delete process.env.JINN_CTX_BASE_BRANCH;
  delete process.env.JINN_CTX_MECH_ADDRESS;
  delete process.env.JINN_CTX_WORKSTREAM_ID;
  delete process.env.JINN_CTX_VENTURE_ID;
  delete process.env.JINN_CTX_PARENT_REQUEST_ID;
  delete process.env.JINN_CTX_BRANCH_NAME;
  delete process.env.JINN_CTX_COMPLETED_CHILDREN;
  delete process.env.JINN_CTX_CHILD_WORK_REVIEWED;
  delete process.env.JINN_CTX_REQUIRED_TOOLS;
  delete process.env.JINN_CTX_AVAILABLE_TOOLS;
  delete process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS;
  delete process.env.JINN_CTX_ALLOWED_MODELS;
  delete process.env.JINN_CTX_DEFAULT_MODEL;
}

/**
 * Snapshot current job context
 */
export function snapshotJobContext(): {
  requestId?: string;
  jobDefinitionId?: string;
  baseBranch?: string;
  mechAddress?: string;
  workstreamId?: string;
  ventureId?: string;
  parentRequestId?: string;
  branchName?: string;
  completedChildRequestIds?: string[];
  childWorkReviewed?: string;
  requiredTools?: string[];
  availableTools?: string[];
  blueprintInvariantIds?: string[];
  allowedModels?: string[];
  defaultModel?: string;
  inheritedEnv?: string;
} {
  return {
    requestId: process.env.JINN_CTX_REQUEST_ID,
    jobDefinitionId: process.env.JINN_CTX_JOB_DEFINITION_ID,
    baseBranch: process.env.JINN_CTX_BASE_BRANCH,
    mechAddress: process.env.JINN_CTX_MECH_ADDRESS,
    workstreamId: process.env.JINN_CTX_WORKSTREAM_ID,
    ventureId: process.env.JINN_CTX_VENTURE_ID,
    parentRequestId: process.env.JINN_CTX_PARENT_REQUEST_ID,
    branchName: process.env.JINN_CTX_BRANCH_NAME,
    completedChildRequestIds: process.env.JINN_CTX_COMPLETED_CHILDREN
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_COMPLETED_CHILDREN as string);
          } catch {
            return undefined;
          }
        })()
      : undefined,
    childWorkReviewed: process.env.JINN_CTX_CHILD_WORK_REVIEWED,
    requiredTools: process.env.JINN_CTX_REQUIRED_TOOLS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_REQUIRED_TOOLS as string);
          } catch {
            return undefined;
          }
        })()
      : undefined,
    availableTools: process.env.JINN_CTX_AVAILABLE_TOOLS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_AVAILABLE_TOOLS as string);
          } catch {
            return undefined;
          }
        })()
      : undefined,
    blueprintInvariantIds: process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS as string);
          } catch {
            return undefined;
          }
        })()
      : undefined,
    allowedModels: process.env.JINN_CTX_ALLOWED_MODELS
      ? (() => {
          try {
            return JSON.parse(process.env.JINN_CTX_ALLOWED_MODELS as string);
          } catch {
            return undefined;
          }
        })()
      : undefined,
    defaultModel: process.env.JINN_CTX_DEFAULT_MODEL,
    inheritedEnv: process.env.JINN_CTX_INHERITED_ENV,
  };
}

/**
 * Restore job context from snapshot
 */
export function restoreJobContext(snapshot: {
  requestId?: string;
  jobDefinitionId?: string;
  baseBranch?: string;
  mechAddress?: string;
  workstreamId?: string;
  ventureId?: string;
  parentRequestId?: string;
  branchName?: string;
  completedChildRequestIds?: string[];
  childWorkReviewed?: string;
  blueprintInvariantIds?: string[];
  allowedModels?: string[];
  defaultModel?: string;
  inheritedEnv?: string;
}): void {
  clearJobContext();
  setJobContext({
    requestId: snapshot.requestId,
    jobDefinitionId: snapshot.jobDefinitionId,
    baseBranch: snapshot.baseBranch,
    mechAddress: snapshot.mechAddress,
    workstreamId: snapshot.workstreamId,
    ventureId: snapshot.ventureId,
    parentRequestId: snapshot.parentRequestId,
    branchName: snapshot.branchName,
    completedChildRequestIds: snapshot.completedChildRequestIds,
    blueprintInvariantIds: snapshot.blueprintInvariantIds,
    allowedModels: snapshot.allowedModels,
    defaultModel: snapshot.defaultModel,
  });
  if (snapshot.childWorkReviewed) {
    process.env.JINN_CTX_CHILD_WORK_REVIEWED = snapshot.childWorkReviewed;
  }
  if (snapshot.inheritedEnv) {
    process.env.JINN_CTX_INHERITED_ENV = snapshot.inheritedEnv;
  }
}
