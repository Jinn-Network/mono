import { readFileSync } from 'node:fs';
import type { CommandRunner } from '../dispatcher/issue-source.js';

export type CredentialPhase = 'implement' | 'review' | 'merge';
export type CredentialPreference = 'implementation' | 'review';

/**
 * The runtime-independent fallback read for the attempt-scoped GH token file
 * (#1883). Some coordinator runtimes scrub secret-shaped env vars (like
 * `GH_TOKEN`) from spawned shell tools, so a production session port cannot
 * rely on inheriting it through the environment alone. The token file at
 * `manifest.paths.tokenFile` is written once at attempt creation
 * (`createAttemptWorkspace`) and read directly off disk here — a path
 * survives any runtime's env scrub because it travels through the
 * non-secret-shaped `JINN_AUTOPILOT_SESSION_MANIFEST` env var instead.
 * Returns `undefined` (never throws) so callers can fall through to their
 * own closed failure.
 */
export function readAttemptTokenFile(path: string): string | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

const EXPLICIT_GITHUB_SECRET_ENV = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'JINN_IMPL_GH_TOKEN',
  'JINN_REVIEW_GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
]);

export function isGitHubSecretEnvironmentKey(key: string): boolean {
  const upper = key.toUpperCase();
  return EXPLICIT_GITHUB_SECRET_ENV.has(upper)
    || /(?:^|_)(?:GH|GITHUB).*?(?:TOKEN|PAT)(?:_|$)/.test(upper);
}

function isGitConfigOverrideEnvironmentKey(key: string): boolean {
  return /^GIT_CONFIG(?:_|$)/i.test(key);
}

function isAmbientSshCredentialKey(key: string): boolean {
  return /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|GIT_SSH|GIT_SSH_COMMAND)$/i.test(key);
}

export function isolatedGitCommandOverlay(
  ambient: NodeJS.ProcessEnv,
  askpassPath: string,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const key of Object.keys(ambient)) {
    if (isGitConfigOverrideEnvironmentKey(key)) overlay[key] = '';
  }
  return {
    ...overlay,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // credential.interactive=never must NOT appear here: git treats the
    // askpass helper as interactive prompting, so it turns every HTTPS auth
    // into "fatal: unable to get password from user" (proven live by the
    // first capability probe). GIT_TERMINAL_PROMPT=0 already prevents any
    // real terminal prompt; the askpass script answers from GH_TOKEN.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.askPass',
    GIT_CONFIG_VALUE_1: askpassPath,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askpassPath,
    SSH_ASKPASS: askpassPath,
    GIT_SSH_COMMAND: 'false',
  };
}

/**
 * Overlay for a command runner that itself merges over process.env. Every
 * ambient/equivalent GitHub secret is explicitly blanked; only the selected
 * GH_TOKEN may be restored.
 */
export function sanitizedGitHubCommandOverlay(
  ambient: NodeJS.ProcessEnv,
  selected: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const key of Object.keys(ambient)) {
    if (isGitHubSecretEnvironmentKey(key)) overlay[key] = '';
  }
  for (const key of EXPLICIT_GITHUB_SECRET_ENV) overlay[key] = '';
  for (const [key, value] of Object.entries(selected)) {
    if (!isGitHubSecretEnvironmentKey(key) || key.toUpperCase() === 'GH_TOKEN') {
      overlay[key] = value;
    }
  }
  return overlay;
}

function normalizeLogin(login: string): string {
  return login.toLowerCase();
}

function validatedLogin(raw: string): string {
  const login = raw.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw new Error('configured GitHub credential resolved to an invalid login');
  }
  return login;
}

/** A selected secret is deliberately non-enumerable and cannot leak via JSON. */
export class SelectedCredential {
  readonly login: string;
  readonly normalizedLogin: string;
  readonly preference: CredentialPreference;
  #token: string;

  constructor(login: string, preference: CredentialPreference, token: string) {
    this.login = login;
    this.normalizedLogin = normalizeLogin(login);
    this.preference = preference;
    this.#token = token;
  }

  secret(): string {
    return this.#token;
  }
}

interface PoolEntry {
  readonly login: string;
  readonly normalizedLogin: string;
  readonly implementationToken?: string;
  readonly reviewToken?: string;
}

/**
 * Parent-process credential pool. Tokens remain in native private storage;
 * status/JSON consumers can observe only authenticated logins.
 */
export class CredentialPool {
  #entries: readonly PoolEntry[];

  constructor(entries: readonly PoolEntry[]) {
    this.#entries = entries;
  }

  logins(): string[] {
    return this.#entries.map((entry) => entry.login);
  }

  restrictedTo(logins: readonly string[]): CredentialPool {
    const allowed = new Set(logins.map(normalizeLogin));
    return new CredentialPool(
      this.#entries.filter((entry) => allowed.has(entry.normalizedLogin)),
    );
  }

  select(request: CredentialSelectionRequest): CredentialSelection {
    return selectFromEntries(this.#entries, request);
  }
}

export interface CredentialEnvironment {
  readonly JINN_IMPL_GH_TOKEN?: string;
  readonly JINN_REVIEW_GH_TOKEN?: string;
  readonly JINN_REVIEW_BOT_LOGIN?: string;
}

function isolatedLoginEnvironment(token: string): Record<string, string> {
  const env = sanitizedGitHubCommandOverlay(process.env);
  env.GH_TOKEN = token;
  env.GH_CONFIG_DIR = '';
  return env;
}

export async function resolveCredentialPool(
  env: CredentialEnvironment,
  runner: CommandRunner,
): Promise<CredentialPool> {
  const configured = [
    ...(env.JINN_IMPL_GH_TOKEN
      ? [{ token: env.JINN_IMPL_GH_TOKEN, preference: 'implementation' as const }]
      : []),
    ...(env.JINN_REVIEW_GH_TOKEN
      ? [{ token: env.JINN_REVIEW_GH_TOKEN, preference: 'review' as const }]
      : []),
  ];
  const loginByToken = new Map<string, string>();
  for (const { token, preference } of configured) {
    if (loginByToken.has(token)) continue;
    try {
      const raw = await runner('gh', ['api', 'user', '--jq', '.login'], {
        env: isolatedLoginEnvironment(token),
      });
      loginByToken.set(token, validatedLogin(raw));
    } catch {
      throw new Error(`${preference} credential GitHub login resolution failed`);
    }
  }

  if (env.JINN_REVIEW_BOT_LOGIN !== undefined && env.JINN_REVIEW_BOT_LOGIN.trim() !== '') {
    if (!env.JINN_REVIEW_GH_TOKEN) {
      throw new Error('review login assertion is configured but the review credential is unavailable');
    }
    const actual = loginByToken.get(env.JINN_REVIEW_GH_TOKEN);
    const asserted = validatedLogin(env.JINN_REVIEW_BOT_LOGIN);
    if (actual === undefined || normalizeLogin(actual) !== normalizeLogin(asserted)) {
      throw new Error(
        `review credential resolves to ${actual ?? 'an unknown login'}, not asserted login ${asserted}`,
      );
    }
  }

  const byLogin = new Map<string, {
    login: string;
    implementationToken?: string;
    reviewToken?: string;
  }>();
  for (const configuredCredential of configured) {
    const login = loginByToken.get(configuredCredential.token);
    if (login === undefined) throw new Error('credential login resolution was incomplete');
    const normalized = normalizeLogin(login);
    const current = byLogin.get(normalized) ?? { login };
    if (configuredCredential.preference === 'implementation') {
      current.implementationToken = configuredCredential.token;
    } else {
      current.reviewToken = configuredCredential.token;
    }
    byLogin.set(normalized, current);
  }

  return new CredentialPool([...byLogin.entries()].map(([normalizedLogin, entry]) => ({
    login: entry.login,
    normalizedLogin,
    ...(entry.implementationToken === undefined
      ? {}
      : { implementationToken: entry.implementationToken }),
    ...(entry.reviewToken === undefined ? {} : { reviewToken: entry.reviewToken }),
  })));
}

export type CredentialSelection =
  | {
      readonly status: 'selected';
      readonly login: string;
      readonly preference: CredentialPreference;
      readonly recoveredPreviousReviewer: boolean;
      readonly credential: SelectedCredential;
    }
  | {
      readonly status: 'identity-unavailable';
      readonly code: 'identity-unavailable';
      readonly detail: string;
    };

export interface CredentialSelectionRequest {
  readonly phase: CredentialPhase;
  readonly prAuthor?: string;
  readonly previousReviewerLogin?: string;
  readonly nativeRequestedChanges?: boolean;
}

function selected(
  entry: PoolEntry,
  preference: CredentialPreference,
  recoveredPreviousReviewer: boolean,
): CredentialSelection {
  const token = preference === 'implementation'
    ? entry.implementationToken
    : entry.reviewToken;
  if (token === undefined) throw new Error('credential selection invariant violated');
  return {
    status: 'selected',
    login: entry.login,
    preference,
    recoveredPreviousReviewer,
    credential: new SelectedCredential(entry.login, preference, token),
  };
}

function preferenceFor(
  entry: PoolEntry,
  preferred: CredentialPreference,
): CredentialPreference | null {
  if (preferred === 'implementation') {
    if (entry.implementationToken !== undefined) return 'implementation';
    if (entry.reviewToken !== undefined) return 'review';
  } else {
    if (entry.reviewToken !== undefined) return 'review';
    if (entry.implementationToken !== undefined) return 'implementation';
  }
  return null;
}

function selectFromEntries(
  entries: readonly PoolEntry[],
  request: CredentialSelectionRequest,
): CredentialSelection {
  if (request.phase !== 'review') {
    for (const entry of entries) {
      const preference = preferenceFor(entry, 'implementation');
      if (preference !== null) return selected(entry, preference, false);
    }
    return {
      status: 'identity-unavailable',
      code: 'identity-unavailable',
      detail: `No authenticated GitHub identity is available for ${request.phase}.`,
    };
  }

  const author = request.prAuthor?.trim();
  if (author === undefined || author === '') {
    return {
      status: 'identity-unavailable',
      code: 'identity-unavailable',
      detail: 'PR author identity is unavailable; reviewer selection fails closed.',
    };
  }
  const normalizedAuthor = normalizeLogin(author);
  const previous = request.previousReviewerLogin?.trim();
  if (
    request.nativeRequestedChanges === true
    && (previous === undefined || previous === '')
  ) {
    return {
      status: 'identity-unavailable',
      code: 'identity-unavailable',
      detail:
        'Previous reviewer identity is unavailable; native requested changes make reviewer recovery unsafe.',
    };
  }
  if (previous !== undefined && previous !== '') {
    const priorEntry = entries.find(
      (entry) => entry.normalizedLogin === normalizeLogin(previous),
    );
    if (priorEntry !== undefined && priorEntry.normalizedLogin !== normalizedAuthor) {
      const preference = preferenceFor(priorEntry, 'review');
      if (preference !== null) return selected(priorEntry, preference, true);
    }
    if (request.nativeRequestedChanges === true) {
      return {
        status: 'identity-unavailable',
        code: 'identity-unavailable',
        detail:
          `Previous reviewer ${previous} is unavailable; native requested changes make switching reviewer unsafe.`,
      };
    }
  }

  const eligible = entries.filter((entry) => entry.normalizedLogin !== normalizedAuthor);
  for (const preferred of ['review', 'implementation'] as const) {
    for (const entry of eligible) {
      if (
        (preferred === 'review' && entry.reviewToken !== undefined)
        || (preferred === 'implementation' && entry.implementationToken !== undefined)
      ) {
        return selected(entry, preferred, false);
      }
    }
  }
  return {
    status: 'identity-unavailable',
    code: 'identity-unavailable',
    detail: `No reviewer identity distinct from PR author ${author} is available.`,
  };
}

export function selectCredential(
  pool: CredentialPool,
  request: CredentialSelectionRequest,
): CredentialSelection {
  return pool.select(request);
}

export interface AttemptAuthenticationPaths {
  readonly ghConfigDir: string;
  readonly askpassPath: string;
  readonly manifestPath: string;
}

export function buildSanitizedChildEnv(
  ambient: NodeJS.ProcessEnv,
  credential: SelectedCredential,
  paths: AttemptAuthenticationPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      !isGitHubSecretEnvironmentKey(key)
      && !isGitConfigOverrideEnvironmentKey(key)
      && !isAmbientSshCredentialKey(key)
    ) {
      env[key] = value;
    }
  }
  env.GH_TOKEN = credential.secret();
  env.GH_CONFIG_DIR = paths.ghConfigDir;
  Object.assign(env, isolatedGitCommandOverlay(ambient, paths.askpassPath));
  env.JINN_AUTOPILOT_SESSION_MANIFEST = paths.manifestPath;
  return env;
}

export function gitPublicationArgs(
  askpassPath: string,
  args: readonly string[],
): string[] {
  // No credential.interactive=never here — see isolatedGitCommandOverlay.
  return [
    '-c', 'credential.helper=',
    '-c', `core.askPass=${askpassPath}`,
    ...args,
  ];
}
