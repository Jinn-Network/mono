import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

const DEFAULT_ENV_FILES = ['.env', '.env.test'];
const REQUIRED_SECRETS = [
  'TENDERLY_ACCESS_KEY',
  'TENDERLY_ACCOUNT_SLUG',
  'TENDERLY_PROJECT_SLUG',
  // 'TEST_GITHUB_REPO',  // Optional: uses local template if not set
  // 'GITHUB_TOKEN',      // Optional: only needed for remote repo
];

export interface TestEnvOverrides {
  [key: string]: string | undefined;
}

export interface WithTestEnvOptions {
  overrides?: TestEnvOverrides;
  envFiles?: string[];
}

export interface EnvSnapshot {
  runtimeEnvironment: string;
  operateProfileDir: string;
  appliedEnv: Record<string, string>;
}

let bootstrapped = false;
let cachedSnapshot: EnvSnapshot | null = null;

// Exported for testing purposes only
export function resetBootstrap() {
  bootstrapped = false;
  cachedSnapshot = null;
}

function resolveOperateFixture(): string {
  const fixturePath = path.resolve(process.cwd(), 'tests-next/fixtures/operate-profile');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(
      `tests-next operate profile fixture not found at ${fixturePath}. ` +
      'Ensure the directory exists so tests can read deterministic service configuration.'
    );
  }
  return fixturePath;
}

function loadEnvFiles(envFiles: string[] = DEFAULT_ENV_FILES): void {
  for (const file of envFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) {
      dotenv.config({ path: fullPath, override: false });
    }
  }
}

function ensureRequiredSecrets(): void {
  const missing = REQUIRED_SECRETS.filter((key) => {
    const value = process.env[key];
    return typeof value === 'undefined' || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets for system tests: ${missing.join(', ')}. ` +
      'Populate them in .env.test or your shell before running tests-next.'
    );
  }
}

function snapshotEnv(): EnvSnapshot {
  const runtimeEnvironment = process.env.RUNTIME_ENVIRONMENT ?? '';
  const operateProfileDir = process.env.OPERATE_PROFILE_DIR ?? '';
  const appliedEnv: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (typeof value === 'string') {
      appliedEnv[key] = value;
    }
  }
  return {
    runtimeEnvironment,
    operateProfileDir,
    appliedEnv,
  };
}

function bootstrapEnv(options?: WithTestEnvOptions): EnvSnapshot {
  if (bootstrapped && cachedSnapshot) {
    return cachedSnapshot;
  }

  loadEnvFiles(options?.envFiles);

  process.env.RUNTIME_ENVIRONMENT = 'test';

  const operateDir = resolveOperateFixture();
  process.env.OPERATE_PROFILE_DIR = operateDir;
  process.env.OPERATE_DIR = operateDir;

  ensureRequiredSecrets();

  cachedSnapshot = snapshotEnv();
  bootstrapped = true;
  return cachedSnapshot;
}

function applyOverrides(overrides?: TestEnvOverrides) {
  if (!overrides) return () => {};
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (typeof value === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function withTestEnv<T>(
  fn: (snapshot: EnvSnapshot) => Promise<T>,
  options?: WithTestEnvOptions
): Promise<T> {
  const snapshot = bootstrapEnv(options);
  const revert = applyOverrides(options?.overrides);
  try {
    return await fn(snapshot);
  } finally {
    revert();
  }
}

export function getEnvSnapshot(): EnvSnapshot {
  if (!cachedSnapshot) {
    return bootstrapEnv();
  }
  return cachedSnapshot;
}
