import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStopHookCli } from '../../src/bin/jinn-stop-hook.js';
import { daemonApiTokenPath, ensureDaemonApiToken } from '../../src/api/daemon-token.js';

function stdinFrom(text: string): NodeJS.ReadStream {
  return Readable.from([text]) as unknown as NodeJS.ReadStream;
}

// An isolated, guaranteed-empty earningDir per test — without this, `env: {}`
// would fall through to the REAL `~/.jinn-client/earning` on the machine
// running the suite, and a developer who has ever run `jinn run` locally
// would have a real persisted token there, silently making the "missing
// token" tests pass or fail depending on host state.
let earningDir: string;
afterEach(() => {
  if (earningDir) rmSync(earningDir, { recursive: true, force: true });
});

describe('jinn-stop-hook binary', () => {
  it('posts normalized stdin payload to the daemon endpoint with the bearer token attached', async () => {
    let url = '';
    let body: unknown;
    let authHeader: string | null = null;
    const code = await runStopHookCli({
      argv: ['--tool', 'gemini-cli', '--daemon-url', 'http://daemon.local'],
      env: { DAEMON_API_TOKEN: 'hook-token-123' },
      stdin: stdinFrom(JSON.stringify({ session_id: 'sess-hook', transcript_path: '/tmp/g.jsonl' })),
      fetchImpl: (async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as unknown;
        authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(url).toBe('http://daemon.local/api/stop-hook');
    expect(authHeader).toBe('Bearer hook-token-123');
    expect(body).toMatchObject({
      tool: 'gemini-cli',
      sessionId: 'sess-hook',
      transcriptPath: '/tmp/g.jsonl',
    });
  });

  it('returns a non-zero code for invalid tool input', async () => {
    const code = await runStopHookCli({
      argv: ['--tool', 'not-a-tool'],
      env: { DAEMON_API_TOKEN: 'hook-token-123' },
      stdin: stdinFrom('{}'),
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      stderr: { write: () => true },
    });
    expect(code).toBe(2);
  });

  // ── §14.1/§14.2: fail loudly instead of posting unauthenticated ─────────
  it('fails loudly with a named error and does NOT call fetch when DAEMON_API_TOKEN is absent and no token file exists', async () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-stop-hook-notoken-'));
    let fetchCalled = false;
    let stderrText = '';
    const code = await runStopHookCli({
      argv: ['--tool', 'claude-code'],
      env: { JINN_EARNING_DIR: earningDir },
      stdin: stdinFrom(JSON.stringify({ session_id: 'sess-no-token' })),
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
      stderr: { write: (s: string) => { stderrText += s; return true; } },
    });

    expect(fetchCalled).toBe(false);
    expect(code).not.toBe(0);
    expect(stderrText).toMatch(/DAEMON_API_TOKEN/);
  });

  it('fails loudly when DAEMON_API_TOKEN is set but empty and no token file exists', async () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-stop-hook-emptytoken-'));
    let fetchCalled = false;
    const code = await runStopHookCli({
      argv: ['--tool', 'claude-code'],
      env: { DAEMON_API_TOKEN: '', JINN_EARNING_DIR: earningDir },
      stdin: stdinFrom('{}'),
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
      stderr: { write: () => true },
    });

    expect(fetchCalled).toBe(false);
    expect(code).not.toBe(0);
  });

  // ── §14.2 fix: file-fallback resolution ──────────────────────────────────
  it('falls back to the persisted daemon-api-token file when DAEMON_API_TOKEN is unset — the out-of-daemon hook path', async () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-stop-hook-filefallback-'));
    const { token } = ensureDaemonApiToken(daemonApiTokenPath(earningDir));

    let authHeader: string | null = null;
    const code = await runStopHookCli({
      argv: ['--tool', 'claude-code', '--daemon-url', 'http://daemon.local'],
      env: { JINN_EARNING_DIR: earningDir },
      stdin: stdinFrom(JSON.stringify({ session_id: 'sess-file-fallback' })),
      fetchImpl: (async (_input, init) => {
        authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(authHeader).toBe(`Bearer ${token}`);
  });

  it('prefers env DAEMON_API_TOKEN over the persisted file when both are present', async () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-stop-hook-envwins-'));
    ensureDaemonApiToken(daemonApiTokenPath(earningDir));

    let authHeader: string | null = null;
    const code = await runStopHookCli({
      argv: ['--tool', 'claude-code'],
      env: { DAEMON_API_TOKEN: 'env-token-wins', JINN_EARNING_DIR: earningDir },
      stdin: stdinFrom('{}'),
      fetchImpl: (async (_input, init) => {
        authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(authHeader).toBe('Bearer env-token-wins');
  });
});
