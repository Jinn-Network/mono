import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { geminiCliSnapshotRule } from '../../../src/trajectory/harness-bundle-rules/gemini-cli.js';
import { getRule } from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('geminiCliSnapshotRule', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'gemini-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('declares the gemini-cli tool brand', () => {
    expect(geminiCliSnapshotRule.tool).toBe('gemini-cli');
  });

  it('registers itself on import', () => {
    expect(getRule('gemini-cli')).toBe(geminiCliSnapshotRule);
  });

  it('includes ~/.gemini/settings.json', async () => {
    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, '.gemini', 'settings.json'));
  });

  it('extracts prompt-file references from settings.json', async () => {
    const dir = path.join(home, '.gemini');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        model: 'gemini-2.5-pro',
        systemPromptFile: path.join(dir, 'system_prompt.md'),
        promptFiles: [path.join(dir, 'a.md'), path.join(dir, 'b.md')],
      }),
    );

    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(dir, 'system_prompt.md'));
    expect(paths).toContain(path.join(dir, 'a.md'));
    expect(paths).toContain(path.join(dir, 'b.md'));
  });

  it('expands ~ in settings-referenced prompt paths', async () => {
    const dir = path.join(home, '.gemini');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ systemPromptFile: '~/gemini-prompt.md' }),
    );

    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, 'gemini-prompt.md'));
  });

  it('returns one path per file under ~/.gemini/prompts/', async () => {
    const promptsDir = path.join(home, '.gemini', 'prompts');
    await mkdir(path.join(promptsDir, 'sub'), { recursive: true });
    await writeFile(path.join(promptsDir, 'p1.md'), 'p1');
    await writeFile(path.join(promptsDir, 'sub', 'p2.md'), 'p2');

    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(promptsDir, 'p1.md'));
    expect(paths).toContain(path.join(promptsDir, 'sub', 'p2.md'));
  });

  it('does not throw when ~/.gemini is absent', async () => {
    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    expect(Array.isArray(paths)).toBe(true);
    expect(paths).toContain(path.join(home, '.gemini', 'settings.json'));
  });

  it('tolerates malformed settings.json without throwing', async () => {
    const dir = path.join(home, '.gemini');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'settings.json'), '{ not valid json');

    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(dir, 'settings.json'));
  });

  it('returns absolute paths', async () => {
    const paths = await geminiCliSnapshotRule.candidatePaths({ home });
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});
