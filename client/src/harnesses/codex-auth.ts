import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CodexCredentialMode =
  | 'chatgpt-oauth'
  | 'api-key'
  | 'not-configured'
  | 'invalid';

export interface CodexCredentialInspection {
  readonly status: 'ok' | 'expired' | 'not_configured';
  readonly mode: CodexCredentialMode;
  readonly authFilePath?: string;
  readonly reason?: string;
}

export interface InspectCodexCredentialsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly readAuthFile?: (path: string) => string | undefined;
  readonly now?: number;
}

interface CodexAuthFile {
  readonly auth_mode?: unknown;
  readonly OPENAI_API_KEY?: unknown;
  readonly tokens?: {
    readonly id_token?: unknown;
    readonly access_token?: unknown;
    readonly refresh_token?: unknown;
  } | null;
}

export const MIN_TESTED_CODEX_VERSION = '0.50.0';
export const MAX_TESTED_CODEX_VERSION = '0.136.0';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function jwtExpiry(token: unknown): number | undefined {
  if (!nonEmptyString(token)) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function readDefaultAuthFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return undefined;
    }
    // Preserve the distinction between an absent file and a present file that
    // cannot be trusted. The empty payload classifies as invalid below.
    return '';
  }
}

export function inspectCodexCredentials(
  options: InspectCodexCredentialsOptions = {},
): CodexCredentialInspection {
  const environment = options.environment ?? process.env;
  if (nonEmptyString(environment['OPENAI_API_KEY'])) {
    return {
      status: 'ok',
      mode: 'api-key',
      reason: 'OPENAI_API_KEY is set',
    };
  }

  const codexHome = environment['CODEX_HOME']?.trim();
  const authFilePath = codexHome
    ? join(codexHome, 'auth.json')
    : join(options.homeDirectory ?? homedir(), '.codex', 'auth.json');
  const readAuthFile = options.readAuthFile ?? readDefaultAuthFile;

  let raw: string | undefined;
  try {
    raw = readAuthFile(authFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return {
        status: 'not_configured',
        mode: 'not-configured',
        reason: 'Codex auth file was not found',
      };
    }
    return {
      status: 'expired',
      mode: 'invalid',
      authFilePath,
      reason: 'Codex auth file could not be read',
    };
  }

  if (raw === undefined) {
    return {
      status: 'not_configured',
      mode: 'not-configured',
      reason: 'Codex auth file was not found',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: 'expired',
      mode: 'invalid',
      authFilePath,
      reason: 'Codex auth file is malformed',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 'expired',
      mode: 'invalid',
      authFilePath,
      reason: 'Codex auth file is malformed',
    };
  }

  const auth = parsed as CodexAuthFile;
  if (nonEmptyString(auth.OPENAI_API_KEY)) {
    return {
      status: 'ok',
      mode: 'api-key',
      authFilePath,
      reason: 'auth.json contains OPENAI_API_KEY',
    };
  }
  if (auth.auth_mode !== 'chatgpt') {
    return {
      status: 'expired',
      mode: 'invalid',
      authFilePath,
      reason: 'auth_mode is not chatgpt',
    };
  }

  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return {
      status: 'expired',
      mode: 'invalid',
      authFilePath,
      reason: 'ChatGPT OAuth tokens are missing',
    };
  }
  if (nonEmptyString(tokens.refresh_token)) {
    return {
      status: 'ok',
      mode: 'chatgpt-oauth',
      authFilePath,
    };
  }

  const nowMs = options.now ?? Date.now();
  const bearerExpiries = [
    jwtExpiry(tokens.access_token),
    jwtExpiry(tokens.id_token),
  ];
  if (bearerExpiries.some((expiry) => expiry !== undefined && expiry * 1000 > nowMs)) {
    return {
      status: 'ok',
      mode: 'chatgpt-oauth',
      authFilePath,
    };
  }

  return {
    status: 'expired',
    mode: 'invalid',
    authFilePath,
    reason: bearerExpiries.some((expiry) => expiry !== undefined)
      ? 'ChatGPT OAuth bearer token is expired'
      : 'No usable ChatGPT OAuth token was found',
  };
}

export function requireChatGptOAuth(
  options: InspectCodexCredentialsOptions = {},
): { readonly ready: true; readonly authFilePath: string } | {
  readonly ready: false;
  readonly reason: string;
} {
  const inspection = inspectCodexCredentials(options);
  if (
    inspection.status === 'ok'
    && inspection.mode === 'chatgpt-oauth'
    && inspection.authFilePath !== undefined
  ) {
    return {
      ready: true,
      authFilePath: inspection.authFilePath,
    };
  }
  if (inspection.mode === 'api-key') {
    return {
      ready: false,
      reason: 'ChatGPT OAuth is required; API-key authentication is not allowed',
    };
  }
  return {
    ready: false,
    reason: inspection.reason ?? 'ChatGPT OAuth is not configured',
  };
}

export function parseCodexVersion(stdout: string): string | null {
  const match = stdout.match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? null;
}
