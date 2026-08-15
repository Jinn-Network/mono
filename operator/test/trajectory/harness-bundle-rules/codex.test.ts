import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { codexSnapshotRule } from '../../../src/trajectory/harness-bundle-rules/codex.js';
import { getRule } from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('codexSnapshotRule', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('declares the codex tool brand', () => {
    expect(codexSnapshotRule.tool).toBe('codex');
  });

  it('registers itself on import', () => {
    expect(getRule('codex')).toBe(codexSnapshotRule);
  });

  it('includes ~/.codex/config.toml', async () => {
    const paths = await codexSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, '.codex', 'config.toml'));
  });

  it('extracts instructions/prompt-file references from config.toml', async () => {
    const codexDir = path.join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      path.join(codexDir, 'config.toml'),
      [
        '# example codex config',
        'model = "o3"',
        `instructions_file = "${path.join(codexDir, 'instructions.md')}"`,
        `prompt_file = "${path.join(codexDir, 'prompt.md')}"`,
      ].join('\n'),
    );

    const paths = await codexSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(codexDir, 'instructions.md'));
    expect(paths).toContain(path.join(codexDir, 'prompt.md'));
  });

  it('expands ~ in config.toml-referenced paths', async () => {
    const codexDir = path.join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      path.join(codexDir, 'config.toml'),
      'instructions_file = "~/codex-instructions.md"\n',
    );

    const paths = await codexSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, 'codex-instructions.md'));
  });

  it('returns one path per file under ~/.codex/prompts/', async () => {
    const promptsDir = path.join(home, '.codex', 'prompts');
    await mkdir(path.join(promptsDir, 'sub'), { recursive: true });
    await writeFile(path.join(promptsDir, 'a.md'), 'a');
    await writeFile(path.join(promptsDir, 'sub', 'b.md'), 'b');

    const paths = await codexSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(promptsDir, 'a.md'));
    expect(paths).toContain(path.join(promptsDir, 'sub', 'b.md'));
  });

  it('does not throw when ~/.codex is absent', async () => {
    const paths = await codexSnapshotRule.candidatePaths({ home });
    expect(Array.isArray(paths)).toBe(true);
    expect(paths).toContain(path.join(home, '.codex', 'config.toml'));
  });

  it('returns absolute paths', async () => {
    const paths = await codexSnapshotRule.candidatePaths({ home });
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});
