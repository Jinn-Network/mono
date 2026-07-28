import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TESTED_CODEX_VERSION,
  MIN_TESTED_CODEX_VERSION,
  inspectCodexCredentials,
  parseCodexVersion,
  requireChatGptOAuth,
  type CodexCredentialMode,
} from '../../src/harnesses/codex-auth.js';

const NOW_MS = Date.UTC(2026, 6, 28, 12, 0, 0);
const AUTH_FILE_PATH = '/operator/.codex/auth.json';

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ sub: 'operator', exp: expSeconds })).toString(
    'base64url',
  );
  return `${header}.${payload}.signature`;
}

const liveJwt = jwtWithExp(Math.floor(NOW_MS / 1000) + 3_600);
const expiredJwt = jwtWithExp(Math.floor(NOW_MS / 1000) - 3_600);
const validOAuth = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { refresh_token: 'refresh-secret' },
};

interface CredentialCase {
  readonly name: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly authFile: unknown;
  readonly expectedStatus: 'ok' | 'expired' | 'not_configured';
  readonly expectedMode: CodexCredentialMode;
  readonly oauthReady: boolean;
}

const credentialCases: readonly CredentialCase[] = [
  {
    name: 'valid refresh',
    environment: {},
    authFile: validOAuth,
    expectedStatus: 'ok',
    expectedMode: 'chatgpt-oauth',
    oauthReady: true,
  },
  {
    name: 'valid bearer',
    environment: {},
    authFile: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: liveJwt },
    },
    expectedStatus: 'ok',
    expectedMode: 'chatgpt-oauth',
    oauthReady: true,
  },
  {
    name: 'valid id-token bearer',
    environment: {},
    authFile: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: liveJwt },
    },
    expectedStatus: 'ok',
    expectedMode: 'chatgpt-oauth',
    oauthReady: true,
  },
  {
    name: 'wrong auth mode',
    environment: {},
    authFile: {
      auth_mode: 'apiKey',
      OPENAI_API_KEY: null,
      tokens: { refresh_token: 'wrong-mode-refresh-secret' },
    },
    expectedStatus: 'expired',
    expectedMode: 'invalid',
    oauthReady: false,
  },
  {
    name: 'env API key',
    environment: { OPENAI_API_KEY: 'paid-env-secret' },
    authFile: validOAuth,
    expectedStatus: 'ok',
    expectedMode: 'api-key',
    oauthReady: false,
  },
  {
    name: 'file API key',
    environment: {},
    authFile: { ...validOAuth, OPENAI_API_KEY: 'paid-file-secret' },
    expectedStatus: 'ok',
    expectedMode: 'api-key',
    oauthReady: false,
  },
  {
    name: 'mixed auth',
    environment: { OPENAI_API_KEY: 'paid-mixed-env-secret' },
    authFile: { ...validOAuth, OPENAI_API_KEY: 'paid-mixed-file-secret' },
    expectedStatus: 'ok',
    expectedMode: 'api-key',
    oauthReady: false,
  },
  {
    name: 'expired bearer',
    environment: {},
    authFile: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: expiredJwt },
    },
    expectedStatus: 'expired',
    expectedMode: 'invalid',
    oauthReady: false,
  },
  {
    name: 'missing tokens',
    environment: {},
    authFile: { auth_mode: 'chatgpt', OPENAI_API_KEY: null },
    expectedStatus: 'expired',
    expectedMode: 'invalid',
    oauthReady: false,
  },
  {
    name: 'malformed file',
    environment: {},
    authFile: '{',
    expectedStatus: 'expired',
    expectedMode: 'invalid',
    oauthReady: false,
  },
  {
    name: 'missing file',
    environment: {},
    authFile: undefined,
    expectedStatus: 'not_configured',
    expectedMode: 'not-configured',
    oauthReady: false,
  },
];

describe('inspectCodexCredentials', () => {
  it.each(credentialCases)(
    'classifies $name without exposing credential material',
    ({
      environment,
      authFile,
      expectedStatus,
      expectedMode,
      oauthReady,
    }) => {
      const readAuthFile = vi.fn((_path: string) =>
        authFile === undefined
          ? undefined
          : typeof authFile === 'string'
            ? authFile
            : JSON.stringify(authFile),
      );
      const options = {
        environment,
        homeDirectory: '/operator',
        readAuthFile,
        now: NOW_MS,
      };

      const inspection = inspectCodexCredentials(options);
      const oauthPolicy = requireChatGptOAuth(options);

      expect(inspection).toMatchObject({
        status: expectedStatus,
        mode: expectedMode,
      });
      expect(oauthPolicy.ready).toBe(oauthReady);

      if (oauthReady) {
        expect(oauthPolicy).toEqual({ ready: true, authFilePath: AUTH_FILE_PATH });
      } else {
        expect(oauthPolicy).toEqual({
          ready: false,
          reason: expect.any(String),
        });
      }

      const publicOutput = JSON.stringify({ inspection, oauthPolicy });
      for (const secret of [
        'refresh-secret',
        'wrong-mode-refresh-secret',
        'paid-env-secret',
        'paid-file-secret',
        'paid-mixed-env-secret',
        'paid-mixed-file-secret',
        liveJwt,
        expiredJwt,
      ]) {
        expect(publicOutput).not.toContain(secret);
      }
    },
  );

  it('uses CODEX_HOME exactly and returns the resolved OAuth auth-file path', () => {
    const readAuthFile = vi.fn(() => JSON.stringify(validOAuth));

    const result = inspectCodexCredentials({
      environment: { CODEX_HOME: '/srv/codex-home' },
      homeDirectory: '/ignored-home',
      readAuthFile,
      now: NOW_MS,
    });

    expect(readAuthFile).toHaveBeenCalledWith('/srv/codex-home/auth.json');
    expect(result).toEqual({
      status: 'ok',
      mode: 'chatgpt-oauth',
      authFilePath: '/srv/codex-home/auth.json',
    });
  });

  it('gives an environment API key precedence without reading auth.json', () => {
    const readAuthFile = vi.fn(() => JSON.stringify(validOAuth));

    expect(
      inspectCodexCredentials({
        environment: { OPENAI_API_KEY: 'env-priority-secret' },
        homeDirectory: '/operator',
        readAuthFile,
        now: NOW_MS,
      }),
    ).toEqual({
      status: 'ok',
      mode: 'api-key',
      reason: 'OPENAI_API_KEY is set',
    });
    expect(readAuthFile).not.toHaveBeenCalled();
  });

  it('requires auth_mode to equal chatgpt exactly', () => {
    const result = inspectCodexCredentials({
      environment: {},
      homeDirectory: '/operator',
      readAuthFile: () =>
        JSON.stringify({
          auth_mode: 'ChatGPT',
          tokens: { refresh_token: 'case-sensitive-secret' },
        }),
      now: NOW_MS,
    });

    expect(result).toEqual({
      status: 'expired',
      mode: 'invalid',
      authFilePath: AUTH_FILE_PATH,
      reason: 'auth_mode is not chatgpt',
    });
    expect(JSON.stringify(result)).not.toContain('case-sensitive-secret');
  });
});

describe('Codex version contract', () => {
  it('exports the tested compatibility window used by the doctor', () => {
    expect(MIN_TESTED_CODEX_VERSION).toBe('0.50.0');
    expect(MAX_TESTED_CODEX_VERSION).toBe('0.136.0');
  });

  it('extracts the first semver triple without throwing on unknown output', () => {
    expect(parseCodexVersion('codex-cli 0.136.7 (build 1.2.3)')).toBe('0.136.7');
    expect(parseCodexVersion('codex CLI (build deadbeef)')).toBeNull();
  });
});
