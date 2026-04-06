/**
 * Environment setup/teardown: CODE_METADATA_REPO_ROOT, .operate, etc.
 */

interface EnvironmentSnapshot {
  CODE_METADATA_REPO_ROOT?: string;
  JINN_CTX_BASE_BRANCH?: string;
  JINN_CTX_INHERITED_ENV?: string;
  jinnJobVars: Record<string, string>;
}

/**
 * Snapshot environment variables affected by jobs.
 * Captures JINN_JOB_* vars so they can be cleaned up between job runs.
 */
export function snapshotEnvironment(): EnvironmentSnapshot {
  const jinnJobVars: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('JINN_JOB_') && process.env[key] !== undefined) {
      jinnJobVars[key] = process.env[key]!;
    }
  }
  return {
    CODE_METADATA_REPO_ROOT: process.env.CODE_METADATA_REPO_ROOT,
    JINN_CTX_BASE_BRANCH: process.env.JINN_CTX_BASE_BRANCH,
    JINN_CTX_INHERITED_ENV: process.env.JINN_CTX_INHERITED_ENV,
    jinnJobVars,
  };
}

/**
 * Restore environment variables from snapshot.
 * Removes any JINN_JOB_* vars injected during the job run.
 */
export function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  if (snapshot.CODE_METADATA_REPO_ROOT !== undefined) {
    process.env.CODE_METADATA_REPO_ROOT = snapshot.CODE_METADATA_REPO_ROOT;
  } else {
    delete process.env.CODE_METADATA_REPO_ROOT;
  }

  if (snapshot.JINN_CTX_BASE_BRANCH !== undefined) {
    process.env.JINN_CTX_BASE_BRANCH = snapshot.JINN_CTX_BASE_BRANCH;
  } else {
    delete process.env.JINN_CTX_BASE_BRANCH;
  }

  if (snapshot.JINN_CTX_INHERITED_ENV !== undefined) {
    process.env.JINN_CTX_INHERITED_ENV = snapshot.JINN_CTX_INHERITED_ENV;
  } else {
    delete process.env.JINN_CTX_INHERITED_ENV;
  }

  // Remove any JINN_JOB_* vars injected during this job
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('JINN_JOB_') && !(key in snapshot.jinnJobVars)) {
      delete process.env[key];
    }
  }
  // Restore original JINN_JOB_* values
  for (const [key, value] of Object.entries(snapshot.jinnJobVars)) {
    process.env[key] = value;
  }
}
