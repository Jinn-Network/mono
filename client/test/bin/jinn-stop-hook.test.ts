import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runStopHookCli } from '../../src/bin/jinn-stop-hook.js';

function stdinFrom(text: string): NodeJS.ReadStream {
  return Readable.from([text]) as unknown as NodeJS.ReadStream;
}

describe('jinn-stop-hook binary', () => {
  it('posts normalized stdin payload to the daemon endpoint', async () => {
    let url = '';
    let body: unknown;
    const code = await runStopHookCli({
      argv: ['--tool', 'gemini-cli', '--daemon-url', 'http://daemon.local'],
      stdin: stdinFrom(JSON.stringify({ session_id: 'sess-hook', transcript_path: '/tmp/g.jsonl' })),
      fetchImpl: (async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as unknown;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(url).toBe('http://daemon.local/api/stop-hook');
    expect(body).toMatchObject({
      tool: 'gemini-cli',
      sessionId: 'sess-hook',
      transcriptPath: '/tmp/g.jsonl',
    });
  });

  it('returns a non-zero code for invalid tool input', async () => {
    const code = await runStopHookCli({
      argv: ['--tool', 'not-a-tool'],
      stdin: stdinFrom('{}'),
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      stderr: { write: () => true },
    });
    expect(code).toBe(2);
  });
});
