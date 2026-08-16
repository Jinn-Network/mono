import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { continueSnapshotRule } from '../../../src/trajectory/harness-bundle-rules/continue.js';
import { getRule } from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('continueSnapshotRule', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'continue-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('declares the continue tool brand', () => {
    expect(continueSnapshotRule.tool).toBe('continue');
  });

  it('registers itself on import', () => {
    expect(getRule('continue')).toBe(continueSnapshotRule);
  });

  it('includes ~/.continue/config.yaml', async () => {
    const paths = await continueSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, '.continue', 'config.yaml'));
  });

  it('returns one path per file under ~/.continue/prompts/', async () => {
    const promptsDir = path.join(home, '.continue', 'prompts');
    await mkdir(path.join(promptsDir, 'sub'), { recursive: true });
    await writeFile(path.join(promptsDir, 'a.prompt'), 'a');
    await writeFile(path.join(promptsDir, 'sub', 'b.prompt'), 'b');

    const paths = await continueSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(promptsDir, 'a.prompt'));
    expect(paths).toContain(path.join(promptsDir, 'sub', 'b.prompt'));
  });

  it('returns one path per file under ~/.continue/assistants/', async () => {
    const assistantsDir = path.join(home, '.continue', 'assistants');
    await mkdir(path.join(assistantsDir, 'team'), { recursive: true });
    await writeFile(path.join(assistantsDir, 'review.yaml'), 'review');
    await writeFile(path.join(assistantsDir, 'team', 'pair.yaml'), 'pair');

    const paths = await continueSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(assistantsDir, 'review.yaml'));
    expect(paths).toContain(path.join(assistantsDir, 'team', 'pair.yaml'));
  });

  it('does not throw when ~/.continue is absent', async () => {
    const paths = await continueSnapshotRule.candidatePaths({ home });
    expect(Array.isArray(paths)).toBe(true);
    expect(paths).toContain(path.join(home, '.continue', 'config.yaml'));
  });

  it('returns absolute paths', async () => {
    const paths = await continueSnapshotRule.candidatePaths({ home });
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});
