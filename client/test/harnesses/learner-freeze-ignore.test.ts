import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { LearnerHarness } from '../../src/harnesses/impls/learner/index.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../src/harnesses/impls/learner/types.js';

/** Minimal no-op adapter to satisfy the required `adapter` field. */
class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;
  async runTask(_inputs: TaskSessionInputs): Promise<void> {}
}

describe('learner harness freezeStateHashIgnore', () => {
  it('declares .git as ignored', () => {
    const h = new LearnerHarness({ adapter: new NoOpAdapter() });
    expect(h.freezeStateHashIgnore).toContain('.git');
  });

  it('codeDigest is stable across differing .git contents when .git is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learner-freeze-'));
    try {
      await writeFile(join(dir, 'skill.md'), 'content-A', 'utf8');
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
      const ignore = ['.git'] as const;
      const before = await hashImplStateDir(dir, { ignoreRelPaths: ignore });
      // Mutate ONLY .git — digest must not change.
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other', 'utf8');
      const after = await hashImplStateDir(dir, { ignoreRelPaths: ignore });
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
