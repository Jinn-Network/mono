import { describe, expect, it } from 'vitest';
import { captureImportCommand } from '../../../src/cli/commands/capture.js';

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
});
