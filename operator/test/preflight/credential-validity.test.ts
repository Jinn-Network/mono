import { describe, expect, it, vi } from 'vitest';

import {
  checkCredentialsValid,
  requiredCredentialRuntimes,
  type CheckCredentialsValidDeps,
} from '../../src/preflight/credential-validity.js';
import type { AuthProbeResult } from '../../src/preflight/claude-auth.js';
import type { CodexAuthStatus } from '../../src/api/codex-doctor-endpoint.js';
import type { HermesAuthStatus } from '../../src/api/hermes-doctor-endpoint.js';

const SECRET = 'sk-ant-SUPERSECRET-DO-NOT-LEAK';
const AUTH_CTX = 'container' as const;

function claudeProbe(overrides: Partial<AuthProbeResult> = {}): AuthProbeResult {
  return {
    authenticated: true,
    context: 'container',
    detail: 'logged in',
    validity: 'valid',
    ...overrides,
  };
}

function hermesProbe(overrides: Partial<HermesAuthStatus> = {}): HermesAuthStatus {
  return {
    provider: 'openrouter',
    authed: true,
    raw: 'openrouter (1 credentials):\n  #0 api_key',
    ...overrides,
  };
}

function validityDeps(overrides: Partial<CheckCredentialsValidDeps> = {}): CheckCredentialsValidDeps {
  return {
    probeClaudeAuth: () => claudeProbe(),
    probeHermesAuthStatus: async () => hermesProbe(),
    probeCodexDoctor: async () => ({
      installed: true,
      authenticated: true,
      authStatus: 'ok' as CodexAuthStatus,
      exitCode: 0,
    }),
    ...overrides,
  };
}

describe('requiredCredentialRuntimes', () => {
  it('returns an empty list when no execution wiring is configured', () => {
    expect(requiredCredentialRuntimes(undefined)).toEqual([]);
    expect(requiredCredentialRuntimes([])).toEqual([]);
  });

  it('maps wired harness names onto distinct Claude / Hermes / Codex runtimes', () => {
    expect(
      requiredCredentialRuntimes([
        { harness: 'claude-code' },
        { harness: 'hermes-agent' },
        { harness: 'codex' },
        { harness: 'prediction-v1-baseline' },
      ]),
    ).toEqual(['claude', 'hermes', 'codex']);
  });

  it('canonicalizes learner aliases and Claude MCP harnesses onto the Claude runtime', () => {
    expect(
      requiredCredentialRuntimes([
        { harness: 'claude-code-learner' },
        { harness: 'claude-mcp-prediction' },
        { harness: 'codex-code-learner' },
      ]),
    ).toEqual(['claude', 'codex']);
  });
});

describe('checkCredentialsValid', () => {
  it('reports valid for a required Claude runtime whose probe authenticates', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['claude'], env: { ANTHROPIC_API_KEY: SECRET }, authContext: AUTH_CTX },
      validityDeps(),
    );
    expect(result.name).toBe('credentials_valid');
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([{ runtime: 'claude', validity: 'valid' }]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('keeps absent distinct from invalid when the required runtime has no credential', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['claude'], env: {}, authContext: AUTH_CTX },
      validityDeps({
        probeClaudeAuth: () =>
          claudeProbe({
            authenticated: false,
            detail: 'not logged in',
            validity: 'invalid',
          }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([{ runtime: 'claude', validity: 'absent' }]);
    expect(result.detail).toMatch(/claude: absent/i);
  });

  it('fails when a required runtime credential is present but invalid', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['claude'], env: { ANTHROPIC_API_KEY: SECRET }, authContext: AUTH_CTX },
      validityDeps({
        probeClaudeAuth: () =>
          claudeProbe({
            authenticated: false,
            detail: 'not logged in',
            validity: 'invalid',
          }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.runtimes).toEqual([{ runtime: 'claude', validity: 'invalid' }]);
    expect(result.detail).toMatch(/claude: invalid/i);
    expect(result.remedy).toMatch(/claude/i);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('fails when a required Claude probe returns malformed auth output', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['claude'], env: { ANTHROPIC_API_KEY: SECRET }, authContext: AUTH_CTX },
      validityDeps({
        probeClaudeAuth: () =>
          claudeProbe({
            authenticated: false,
            detail: 'claude auth status output is not valid JSON',
            validity: 'malformed',
          }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.runtimes).toEqual([{ runtime: 'claude', validity: 'malformed' }]);
    expect(result.detail).toMatch(/claude: malformed/i);
  });

  it('treats a probe timeout as advisory, not invalid', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['claude'], env: { ANTHROPIC_API_KEY: SECRET }, authContext: AUTH_CTX },
      validityDeps({
        validityTimeoutMs: 20,
        probeClaudeAuth: () => new Promise(() => undefined),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'claude', validity: 'error', note: 'timed out' },
    ]);
    expect(result.detail).toMatch(/claude: error/i);
    expect(result.detail).toMatch(/timed out/i);
  });

  it('treats a probe throw as advisory, not invalid', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['hermes'], env: { OPENROUTER_API_KEY: 'or-secret' }, authContext: AUTH_CTX },
      validityDeps({
        probeHermesAuthStatus: async () => {
          throw new Error('spawn failed');
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([{ runtime: 'hermes', validity: 'error' }]);
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('REGRESSION: a missing hermes binary is an advisory error, not an invalid credential', async () => {
    // The real `probeHermesAuthStatus` resolves — it never throws — for
    // ENOENT / EACCES / its own timeout, so the outer `withTimeout` race in
    // `probeRuntime` never fires. Drive the real return shape (not a stubbed
    // hang or throw) or the classifier's missing-binary branch goes untested.
    // Classifying this as `invalid` would make `credentials_valid` fail, and
    // that check is boot-fatal for a required runtime in a hosted deployment.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({ authed: false, raw: '', errorCode: 'ENOENT' }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'error', note: 'ENOENT' },
    ]);
    expect(result.detail).toMatch(/hermes: error \(ENOENT\)/);
    expect(result.remedy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('REGRESSION: a wedged hermes binary that times out is an advisory error', async () => {
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({ authed: false, raw: '', errorCode: 'ETIMEDOUT' }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'error', note: 'ETIMEDOUT' },
    ]);
  });

  it('REGRESSION: a hermes CLI that exits non-zero is an advisory error, not an invalid credential', async () => {
    // A hermes that spawns and then fails (version skew that renamed `auth
    // list`, a corrupt `~/.hermes`, a Python traceback) carries no errno at
    // all — `errorCode` is undefined and stdout is empty. Classified on
    // `authed` alone that reads as a rejected credential, which is
    // boot-fatal for a required runtime in a hosted deployment, with a
    // remedy pointing at a key that is not the problem.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({ authed: false, raw: '', exitCode: 2 }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'error', note: 'hermes CLI probe failed' },
    ]);
    expect(result.remedy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('REGRESSION: a rate-limited OpenRouter credential is non-blocking, not invalid', async () => {
    // `hermes auth list` annotates a pooled credential the provider is
    // throttling as `rate-limited (12m 3s left)`. The CLI ran cleanly (exit 0,
    // no errno) and OpenRouter AUTHENTICATED the key — it is rate-limiting it
    // for a stated window, and it works again in minutes with no operator
    // action. Judged on `authed` alone this falls through every earlier guard
    // onto the env-presence split and reads as `invalid`: blocking, and
    // boot-fatal for a required runtime in a hosted deployment. A daemon that
    // restarts inside the window then refuses to boot, takes the operator
    // console (served by that same daemon) down with it, and prints a remedy
    // telling the operator to replace the one credential that is not broken.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({
            authed: false,
            exitCode: 0,
            raw:
              'openrouter (1 credentials):\n' +
              '  #0  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY rate-limited (429) (12m 3s left)',
            unusableReason: 'throttled',
          }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'throttled', note: 'openrouter credential rate-limited' },
    ]);
    // `throttled` is outside the blocking set, so no remedy is emitted at all
    // — and in particular nothing tells the operator to replace the key.
    expect(result.remedy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('OPENROUTER_API_KEY');
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('REGRESSION: an exhausted OpenRouter credential with a wait window still open is non-blocking', async () => {
    // The other annotation `_format_exhausted_status` emits for an open
    // window. Same fact, same verdict.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({
            authed: false,
            exitCode: 0,
            raw:
              'openrouter (1 credentials):\n' +
              '  #0  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY exhausted (1h 4m left)',
            unusableReason: 'throttled',
          }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'throttled', note: 'openrouter credential rate-limited' },
    ]);
    expect(result.remedy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('OPENROUTER_API_KEY');
  });

  it('reports a throttled non-OpenRouter provider as throttled rather than absent', async () => {
    // The throttle verdict is a fact about whatever provider was probed, so it
    // is read before the OpenRouter-only env split. Calling a provider that
    // HAS a pooled credential `absent` would be a second, quieter
    // misclassification of the same answer.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
        hermesProvider: 'anthropic',
      },
      validityDeps({
        probeHermesAuthStatus: async (provider) =>
          hermesProbe({
            provider,
            authed: false,
            exitCode: 0,
            raw: 'anthropic (1 credentials):\n  #0  key   oauth rate-limited (429) (2m 0s left)',
            unusableReason: 'throttled',
          }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'throttled', note: 'anthropic credential rate-limited' },
    ]);
    expect(result.remedy).toBeUndefined();
  });

  it('still reports invalid when hermes runs and rejects a present credential', async () => {
    // The complement of the cases above: hermes answered, the pool carries a
    // credential OpenRouter HARD-REJECTED (`auth failed (re-auth may be
    // required)`), and the key is present. That is a credential the runtime
    // actually rejected — it stays `invalid` and blocking, which is exactly
    // what #1001 asks to be boot-fatal for a required runtime.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({
            authed: false,
            exitCode: 0,
            raw: 'openrouter (1 credentials):\n  #1 api_key auth failed (re-auth may be required)',
            unusableReason: 'auth_failed',
          }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.runtimes).toEqual([{ runtime: 'hermes', validity: 'invalid' }]);
    expect(result.remedy).toMatch(/hermes/i);
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('still reports invalid when hermes sees no pooled credential at all while the key is present', async () => {
    // The remaining route to `invalid`, pinned so the fix above cannot be read
    // as having made the hermes branch unable to block. An empty pool with
    // `OPENROUTER_API_KEY` set means the runtime is not carrying the operator's
    // credential — nothing rejected it and nothing is throttling it, so there
    // is no `unusableReason`, and it will not clear on its own.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: async () => hermesProbe({ authed: false, exitCode: 0, raw: '' }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.runtimes).toEqual([{ runtime: 'hermes', validity: 'invalid' }]);
    expect(result.remedy).toMatch(/OPENROUTER_API_KEY/);
  });

  it('REGRESSION: hermes in local-provider mode never gates on OpenRouter auth', async () => {
    // `hermesBaseUrl` points Hermes at a loopback OpenAI-compatible endpoint,
    // and the harness deliberately bypasses the OpenRouter auth/credit gates
    // for it (`hermes-agent/harness.ts`). OpenRouter has rejected nothing —
    // it is not the provider in use — so `authed: false` here is not a
    // credential verdict. Classifying it `invalid` is boot-fatal for a
    // required runtime in a hosted deployment, and the operator console goes
    // down with the daemon that serves it. `credentials_resolvable` actively
    // steers container operators to set OPENROUTER_API_KEY, so the key being
    // present is the expected shape of a healthy local-provider deployment.
    const hermes = vi.fn(async () => hermesProbe({ authed: false, exitCode: 0, raw: '' }));
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
        hermesBaseUrl: 'http://127.0.0.1:11434/v1',
      },
      validityDeps({ probeHermesAuthStatus: hermes }),
    );
    expect(hermes).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([
      { runtime: 'hermes', validity: 'absent', note: 'local hermes provider' },
    ]);
    expect(result.remedy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('REGRESSION: a non-OpenRouter hermes provider is not judged by OPENROUTER_API_KEY', async () => {
    // `hermesProvider` is first-class (#1243) and is what `runProbe` actually
    // probes. Judging that probe's answer against the OpenRouter env key
    // reads a provider with no pooled credential as `invalid` purely because
    // an unrelated key is set — and emits a remedy naming the one thing that
    // is not the problem.
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
        hermesProvider: 'anthropic',
      },
      validityDeps({
        probeHermesAuthStatus: async (provider) =>
          hermesProbe({ provider, authed: false, exitCode: 0, raw: '' }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([{ runtime: 'hermes', validity: 'absent' }]);
    expect(result.remedy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('or-secret');
  });

  it('does not treat a Hermes credential as valid Claude authentication', async () => {
    const hermes = vi.fn(async () => hermesProbe());
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['claude'],
        env: { OPENROUTER_API_KEY: 'or-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeHermesAuthStatus: hermes,
        probeClaudeAuth: () =>
          claudeProbe({
            authenticated: false,
            detail: 'not logged in',
            validity: 'invalid',
          }),
      }),
    );
    expect(hermes).not.toHaveBeenCalled();
    expect(result.runtimes).toEqual([{ runtime: 'claude', validity: 'absent' }]);
    expect(result.ok).toBe(true);
  });

  it('does not treat a Claude credential as valid Hermes authentication', async () => {
    const claude = vi.fn(() => claudeProbe());
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['hermes'],
        env: { ANTHROPIC_API_KEY: SECRET },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeClaudeAuth: claude,
        probeHermesAuthStatus: async () => hermesProbe({ authed: false, raw: '' }),
      }),
    );
    expect(claude).not.toHaveBeenCalled();
    expect(result.runtimes).toEqual([{ runtime: 'hermes', validity: 'absent' }]);
    expect(result.ok).toBe(true);
  });

  it('fails only the required Codex runtime when its session is expired', async () => {
    const result = await checkCredentialsValid(
      {
        requiredRuntimes: ['codex'],
        env: { OPENAI_API_KEY: 'sk-openai-secret' },
        authContext: AUTH_CTX,
      },
      validityDeps({
        probeCodexDoctor: async () => ({
          installed: true,
          authenticated: false,
          authStatus: 'expired',
          exitCode: 0,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.runtimes).toEqual([{ runtime: 'codex', validity: 'invalid' }]);
    expect(result.remedy).toMatch(/codex/i);
    expect(JSON.stringify(result)).not.toContain('sk-openai-secret');
  });

  it('skips probes when no runtime is required', async () => {
    const probeClaudeAuth = vi.fn(() => claudeProbe());
    const result = await checkCredentialsValid(
      { requiredRuntimes: [], env: { ANTHROPIC_API_KEY: SECRET }, authContext: AUTH_CTX },
      validityDeps({ probeClaudeAuth }),
    );
    expect(probeClaudeAuth).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.runtimes).toEqual([]);
    expect(result.detail).toMatch(/no required runtime/i);
  });

  it('never copies probe stdout or secret provider payloads into the result', async () => {
    const result = await checkCredentialsValid(
      { requiredRuntimes: ['hermes'], env: { OPENROUTER_API_KEY: 'or-secret' }, authContext: AUTH_CTX },
      validityDeps({
        probeHermesAuthStatus: async () =>
          hermesProbe({
            authed: false,
            raw: `openrouter (1 credentials):\n  #0 api_key or-secret Authorization: Bearer or-secret`,
          }),
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('or-secret');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });
});
