import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runStopHookCli } from '../../src/bin/jinn-stop-hook.js';

function stdinFrom(text: string): NodeJS.ReadStream {
  return Readable.from([text]) as unknown as NodeJS.ReadStream;
}

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

  // ── §14.1: fail loudly instead of posting unauthenticated ───────────────
  it('fails loudly with a named error and does NOT call fetch when DAEMON_API_TOKEN is absent', async () => {
    let fetchCalled = false;
    let stderrText = '';
    const code = await runStopHookCli({
      argv: ['--tool', 'claude-code'],
      env: {},
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

  it('fails loudly when DAEMON_API_TOKEN is set but empty', async () => {
    let fetchCalled = false;
    const code = await runStopHookCli({
      argv: ['--tool', 'claude-code'],
      env: { DAEMON_API_TOKEN: '' },
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
});
