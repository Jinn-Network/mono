import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureImportCommand, importCaptureToStore } from '../../../src/cli/commands/capture.js';
import { CapturesStore } from '../../../src/store/captures.js';
import { Store } from '../../../src/store/store.js';

describe('capture CLI command helpers', () => {
  it('normalizes import arguments for trace files', () => {
    expect(captureImportCommand({
      file: 'trace.json',
      repo: '.',
      license: 'MIT',
      readFile: () => Buffer.from('{"spans":[]}'),
    })).toMatchObject({
      ok: true,
      action: 'capture import',
      tool: 'generic',
      repo: '.',
      license: 'MIT',
      bytes: 12,
      format: 'json',
    });
  });

  it('infers aider/jsonl transcript imports', () => {
    expect(captureImportCommand({
      file: '.aider.chat.history.jsonl',
      readFile: () => Buffer.from('{}\n'),
    })).toMatchObject({ tool: 'aider', format: 'jsonl' });
  });

  it('scrubs credentials before persisting imported transcript spans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-capture-import-'));
    try {
      const dbPath = join(dir, 'captures.sqlite');
      const transcriptPath = join(dir, 'claude-session.jsonl');
      const apiKey = `sk-${'a'.repeat(24)}`;
      const bearer = `Bearer ${'b'.repeat(24)}`;
      const token = 'ghp_imported_transcript_token';
      writeFileSync(
        transcriptPath,
        [
          {
            type: 'user',
            timestamp: '2026-05-07T00:00:00.000Z',
            message: {
              content: `please use api_key=${apiKey}\npassword=hunter2`,
            },
          },
          {
            type: 'assistant',
            timestamp: '2026-05-07T00:00:01.000Z',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'fetch',
                  input: {
                    token,
                    nested: { apiKey },
                    command: `curl -H "Authorization: ${bearer}" https://example.test`,
                  },
                },
              ],
            },
          },
          {
            type: 'user',
            timestamp: '2026-05-07T00:00:02.000Z',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_1',
                  content: `OPENAI_API_KEY=${apiKey}\npassword: hunter2`,
                },
              ],
            },
          },
        ].map((record) => JSON.stringify(record)).join('\n'),
      );

      const imported = await importCaptureToStore({
        file: transcriptPath,
        tool: 'claude-code',
        sessionId: 'sess-secret-import',
        dbPath,
      });

      const store = new Store(dbPath);
      try {
        const captures = new CapturesStore(store);
        const pending = captures.getBySession(imported.sessionId);
        const spans = captures.getSpansBySession(imported.sessionId);
        const serialized = JSON.stringify(spans);

        expect(imported.spans).toBe(3);
        expect(pending?.spanCount).toBe(3);
        expect(pending?.redactedSpanCount).toBe(3);
        expect(serialized).not.toContain(apiKey);
        expect(serialized).not.toContain(token);
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain(bearer);
        expect(serialized).toContain('<REDACTED>');

        const redactedKeys = spans.flatMap((span) => span.redactedKeys);
        expect(redactedKeys).toEqual(expect.arrayContaining([
          'message.content.api_key',
          'message.content.password',
          'tool.args.token',
          'tool.args.nested.apiKey',
          'tool.args.command',
          'tool.result.OPENAI_API_KEY',
          'tool.result.password',
        ]));
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scrubs credentials from imported edit diffs before persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-capture-import-'));
    try {
      const dbPath = join(dir, 'captures.sqlite');
      const transcriptPath = join(dir, '.aider.analytics.log.jsonl');
      const apiKey = `sk-${'c'.repeat(24)}`;
      writeFileSync(
        transcriptPath,
        JSON.stringify({
          event: 'edit',
          timestamp: '2026-05-07T00:00:00.000Z',
          path: join(dir, 'app.ts'),
          diff: `+OPENAI_API_KEY=${apiKey}\n+password=hunter2\n+console.log("ok")`,
        }) + '\n',
      );

      const imported = await importCaptureToStore({
        file: transcriptPath,
        tool: 'aider',
        sessionId: 'sess-secret-diff-import',
        dbPath,
      });

      const store = new Store(dbPath);
      try {
        const captures = new CapturesStore(store);
        const pending = captures.getBySession(imported.sessionId);
        const spans = captures.getSpansBySession(imported.sessionId);
        const serialized = JSON.stringify(spans);

        expect(pending?.redactedSpanCount).toBe(1);
        expect(serialized).not.toContain(apiKey);
        expect(serialized).not.toContain('hunter2');
        expect(spans[0].redactedKeys).toEqual(expect.arrayContaining([
          'file.diff.OPENAI_API_KEY',
          'file.diff.password',
        ]));
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
