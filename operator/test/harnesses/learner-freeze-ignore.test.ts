import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { LEARNER_PUBLIC_V1, resolveHashProfile } from '../../src/harnesses/hash-profile.js';
import { LearnerHarness } from '../../src/harnesses/impls/learner/index.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../src/harnesses/impls/learner/types.js';

/** Minimal no-op adapter to satisfy the required `adapter` field. */
class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;
  async runTask(_inputs: TaskSessionInputs): Promise<void> {}
}

describe('learner harness freeze-digest exclusions', () => {
  it('declares the learner-public.v1 profile, which ignores .git', () => {
    const h = new LearnerHarness({ adapter: new NoOpAdapter() });
    expect(h.freezeStateHashProfile).toBe(LEARNER_PUBLIC_V1);
    expect([...resolveHashProfile(h.freezeStateHashProfile).ignoreRelPaths]).toContain('.git');
  });

  it('codeDigest is stable across differing .git contents under the profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learner-freeze-'));
    try {
      // `skills/` is a profile-classified root; a bare top-level `skill.md`
      // would now fail closed, so the fixture uses the real shape.
      await mkdir(join(dir, 'skills'), { recursive: true });
      await writeFile(join(dir, 'skills', 'skill.md'), 'content-A', 'utf8');
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
      const before = await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 });
      // Mutate ONLY .git — digest must not change.
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other', 'utf8');
      const after = await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 });
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
