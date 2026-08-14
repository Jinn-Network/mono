import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { deriveRuntimeWorkspace, type RuntimeWorkspace } from "./runtime-workspace";

type Environment = Readonly<Record<string, string | undefined>>;

export const BUILD_SECRET_ENV = "BP50_BUILD_SECRET_SENTINEL";
export const RUN_ID_ENV = "BP50_BROWSER_RUN_ID";
export const OWNERSHIP_TOKEN_ENV = "BP50_BROWSER_OWNERSHIP_TOKEN";
export const RUNTIME_SECRET_ENV = "BP50_RUNTIME_SECRET_SENTINEL";
export const CREDENTIAL_SECRET_ENV = "BP50_CREDENTIAL_SENTINEL";
export const LOCAL_APP_CAPABILITY_ENV = "COLOPHON_LOCAL_APP_CAPABILITY";

export interface BrowserRuntimeConfig extends RuntimeWorkspace {
  readonly buildSecret: string;
  readonly runtimeSecret: string;
  readonly credentialSecret: string;
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length < 24) throw new Error(`${name} must be set to a nontrivial production-browser sentinel`);
  return value;
}

/** Creates per-invocation values once in the Playwright config process. The config exports them to
 * global setup, the worker, and `next start`; no secondary process invents its own workspace. */
export function createRuntimeEnvironment(environment: Environment = process.env): Readonly<Record<string, string>> {
  required(environment, BUILD_SECRET_ENV);
  const inheritedNames = [RUN_ID_ENV, OWNERSHIP_TOKEN_ENV, RUNTIME_SECRET_ENV, CREDENTIAL_SECRET_ENV, LOCAL_APP_CAPABILITY_ENV] as const;
  const inherited = inheritedNames.filter((name) => environment[name] !== undefined);
  if (inherited.length > 0) {
    if (inherited.length !== inheritedNames.length) {
      throw new Error("refusing a partial inherited production-browser run identity");
    }
    return Object.fromEntries(inheritedNames.map((name) => [name, required(environment, name)]));
  }
  const runId = randomUUID();
  return {
    [RUN_ID_ENV]: runId,
    [OWNERSHIP_TOKEN_ENV]: randomUUID(),
    [RUNTIME_SECRET_ENV]: `BP50_RUNTIME_SECRET_${randomUUID()}`,
    [CREDENTIAL_SECRET_ENV]: `BP50_CREDENTIAL_${randomUUID()}`,
    [LOCAL_APP_CAPABILITY_ENV]: `BP50_LOCAL_APP_${randomUUID()}`,
  };
}

export function readRuntimeConfig(
  environment: Environment = process.env,
  baseDir: string = tmpdir(),
): BrowserRuntimeConfig {
  const runId = required(environment, RUN_ID_ENV);
  const ownershipToken = required(environment, OWNERSHIP_TOKEN_ENV);
  return {
    ...deriveRuntimeWorkspace({ baseDir, runId, ownershipToken }),
    buildSecret: required(environment, BUILD_SECRET_ENV),
    runtimeSecret: required(environment, RUNTIME_SECRET_ENV),
    credentialSecret: required(environment, CREDENTIAL_SECRET_ENV),
  };
}
