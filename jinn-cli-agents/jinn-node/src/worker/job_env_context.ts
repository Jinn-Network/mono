import { getCurrentJobContext, setJobContext, type JobContext } from '../agent/mcp/tools/shared/context.js';

type EnvSnapshot = {
  hadValue: boolean;
  value?: string;
};

export type JobEnvironmentSnapshot = {
  jobContext: JobContext;
  repoRoot: EnvSnapshot;
};

export type RequestEnvironmentSnapshot = {
  hadRequestId: boolean;
  requestId?: string;
  hadMechAddress: boolean;
  mechAddress?: string;
};

function snapshotEnvVar(key: string): EnvSnapshot {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
  const value = process.env[key];
  return hadValue ? { hadValue: true, value: value ?? undefined } : { hadValue: false };
}

function restoreEnvVar(key: string, snapshot: EnvSnapshot): void {
  if (!snapshot.hadValue) {
    delete process.env[key];
    return;
  }
  if (snapshot.value !== undefined) {
    process.env[key] = snapshot.value;
  } else {
    delete process.env[key];
  }
}

export function snapshotJobEnvironment(): JobEnvironmentSnapshot {
  return {
    jobContext: getCurrentJobContext(),
    repoRoot: snapshotEnvVar('CODE_METADATA_REPO_ROOT'),
  };
}

export function applyJobEnvironment(opts: { baseBranch?: string | null; repoRoot?: string | null }): void {
  const current = getCurrentJobContext();
  const nextBaseBranch = opts.baseBranch ?? current.baseBranch ?? null;

  setJobContext(
    current.jobId,
    current.jobName,
    current.threadId,
    current.projectRunId,
    current.projectDefinitionId,
    current.jobDefinitionId,
    nextBaseBranch ?? undefined,
  );

  if (opts.repoRoot != null) {
    process.env.CODE_METADATA_REPO_ROOT = opts.repoRoot;
  } else {
    delete process.env.CODE_METADATA_REPO_ROOT;
  }
}

export function restoreJobEnvironment(snapshot: JobEnvironmentSnapshot): void {
  const ctx = snapshot.jobContext;
  setJobContext(
    ctx.jobId,
    ctx.jobName,
    ctx.threadId,
    ctx.projectRunId,
    ctx.projectDefinitionId,
    ctx.jobDefinitionId,
    ctx.baseBranch ?? undefined,
  );
  restoreEnvVar('CODE_METADATA_REPO_ROOT', snapshot.repoRoot);
}

export function applyRequestEnvironment(requestId: string, mechAddress: string): RequestEnvironmentSnapshot {
  const snapshot: RequestEnvironmentSnapshot = {
    hadRequestId: Object.prototype.hasOwnProperty.call(process.env, 'JINN_CTX_REQUEST_ID'),
    requestId: process.env.JINN_CTX_REQUEST_ID,
    hadMechAddress: Object.prototype.hasOwnProperty.call(process.env, 'JINN_CTX_MECH_ADDRESS'),
    mechAddress: process.env.JINN_CTX_MECH_ADDRESS,
  };

  process.env.JINN_CTX_REQUEST_ID = requestId;
  process.env.JINN_CTX_MECH_ADDRESS = mechAddress;

  return snapshot;
}

export function restoreRequestEnvironment(snapshot: RequestEnvironmentSnapshot): void {
  if (snapshot.hadRequestId) {
    if (snapshot.requestId !== undefined) {
      process.env.JINN_CTX_REQUEST_ID = snapshot.requestId;
    } else {
      delete process.env.JINN_CTX_REQUEST_ID;
    }
  } else {
    delete process.env.JINN_CTX_REQUEST_ID;
  }

  if (snapshot.hadMechAddress) {
    if (snapshot.mechAddress !== undefined) {
      process.env.JINN_CTX_MECH_ADDRESS = snapshot.mechAddress;
    } else {
      delete process.env.JINN_CTX_MECH_ADDRESS;
    }
  } else {
    delete process.env.JINN_CTX_MECH_ADDRESS;
  }
}
