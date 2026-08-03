/**
 * Regression coverage for the `learner-public.v1` impl-state hash profile
 * (#2118 — the recorded digest migration).
 *
 * Authority:
 *   - docs/superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md
 *     §3.2 (the profile) and §4.1 (the exhaustive top-level classification)
 *   - docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md
 *     §4.2 (one hashing procedure, three uses)
 *   - docs/runbooks/learner-public-v1-digest-migration.md (the migration note)
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashImplStateDir,
  harnessHashOptions,
  HashProfileViolationError,
} from '../../src/harnesses/freeze.js';
import {
  LEARNER_PUBLIC_V1,
  resolveHashProfile,
  hashProfileForHarness,
  UnknownHashProfileError,
} from '../../src/harnesses/hash-profile.js';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import { DEFAULT_HARNESS } from '../../src/harnesses/engine/registry.js';
import { CODEX_HARNESS, HERMES_AGENT_HARNESS } from '../../src/harnesses/names.js';
import { LearnerHarness } from '../../src/harnesses/impls/learner/index.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../src/harnesses/impls/learner/types.js';
import type { Harness, HarnessContext, Solution } from '../../src/harnesses/types.js';

class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;
  async runTask(_inputs: TaskSessionInputs): Promise<void> {}
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(dir: string, relPath: string, content: string): Promise<void> {
  const full = join(dir, ...relPath.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

// ── The fork-healing fixture ────────────────────────────────────────────────
//
// This exact tree, hashed under `learner-public.v1`, is the shared fixture the
// policy-identity package pins its `jinn.harness-state.v1` loadout digest to
// (substrate §4.2). Any change to the file set, the contents, or the profile
// changes FORK_HEALING_FIXTURE_DIGEST — and that is the point: the constant is
// the tripwire. Contents are UTF-8 with LF endings and a trailing newline.
//
// Three roots contribute to the digest (per-file sha256 recorded so a second
// implementation can reproduce the constant without running this one):
//   notes/2026-08-03-note.md   'note one\n'
//     d6de6053618973c2e7af46a5206073f4bffe35c2674ce997d3fbe32dfb6f2078
//   policy.json                '{"revertThreshold":3}\n'
//     ef419f699076f8ad73068cf0004548fef901117e4a85c9dc9eee9828520f78d3
//   skills/alpha/SKILL.md      '# alpha\n'
//     a6098732ccd311fb1f4cf46a2e05389ac24f7207f9be513a0d1d423d8109b2c7
//
// Four roots are populated and contribute nothing:
//   .git/HEAD                    'ref: refs/heads/main\n'
//   operator-requests/req-1.json '{"id":"req-1"}\n'
//   secrets/token                'sk-fixture\n'
//   transcripts/run-1/session.md 'transcript\n'
//
// Outer input, path-sorted and joined with LF (no trailing newline):
//   notes/2026-08-03-note.md:<h>\npolicy.json:<h>\nskills/alpha/SKILL.md:<h>
const FORK_HEALING_FIXTURE_DIGEST =
  '90b25998166464fbb356ce7738149e7f173a78b6bff4d6896aaa96445e89abd8';

async function buildForkHealingFixture(opts: { withIgnoredRoots: boolean }): Promise<string> {
  const dir = await tmp('fork-healing-');
  await write(dir, 'notes/2026-08-03-note.md', 'note one\n');
  await write(dir, 'policy.json', '{"revertThreshold":3}\n');
  await write(dir, 'skills/alpha/SKILL.md', '# alpha\n');
  if (opts.withIgnoredRoots) {
    await write(dir, '.git/HEAD', 'ref: refs/heads/main\n');
    await write(dir, 'operator-requests/req-1.json', '{"id":"req-1"}\n');
    await write(dir, 'secrets/token', 'sk-fixture\n');
    await write(dir, 'transcripts/run-1/session.md', 'transcript\n');
  }
  return dir;
}

describe('learner-public.v1 profile definition', () => {
  it('registers the canonical ignore list in canonical order', () => {
    const profile = resolveHashProfile(LEARNER_PUBLIC_V1);
    expect(profile.id).toBe('learner-public.v1');
    expect([...profile.ignoreRelPaths]).toEqual(['.git', 'operator-requests', 'secrets', 'transcripts']);
  });

  it('classifies every allowed root from the spike table', () => {
    const profile = resolveHashProfile(LEARNER_PUBLIC_V1);
    expect([...profile.allowedDirs].sort()).toEqual([
      '.archive', 'agents', 'configs', 'hooks', 'notes', 'patterns',
      'plans', 'runs', 'skills', 'strategies', 'tests', 'tools', 'tunables',
    ]);
    expect([...profile.allowedFiles]).toEqual(['policy.json']);
  });

  it('fails closed on an unregistered profile id', () => {
    expect(() => resolveHashProfile('learner-public.v2')).toThrow(UnknownHashProfileError);
  });
});

describe('learner-public.v1 exclusions', () => {
  it('excludes all four private roots from the digest', async () => {
    const withRoots = await buildForkHealingFixture({ withIgnoredRoots: true });
    const withoutRoots = await buildForkHealingFixture({ withIgnoredRoots: false });
    try {
      const a = await hashImplStateDir(withRoots, { profile: LEARNER_PUBLIC_V1 });
      const b = await hashImplStateDir(withoutRoots, { profile: LEARNER_PUBLIC_V1 });
      expect(a).toBe(b);
    } finally {
      await rm(withRoots, { recursive: true, force: true });
      await rm(withoutRoots, { recursive: true, force: true });
    }
  });

  it('is unmoved by content changes inside every excluded root', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      const before = await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 });
      await write(dir, '.git/HEAD', 'ref: refs/heads/other\n');
      await write(dir, '.git/objects/ab/cdef', 'blob\n');
      await write(dir, 'secrets/token', 'sk-rotated\n');
      await write(dir, 'secrets/nested/deep/key.pem', 'PRIVATE\n');
      await write(dir, 'transcripts/run-1/session.md', 'a much longer transcript\n');
      await write(dir, 'transcripts/run-2/session.md', 'second run\n');
      await write(dir, 'operator-requests/req-1.json', '{"id":"req-1","state":"granted"}\n');
      await write(dir, 'operator-requests/req-2.json', '{"id":"req-2"}\n');
      const after = await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 });
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still tracks content changes under contributing roots', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      const before = await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 });
      await write(dir, 'skills/alpha/SKILL.md', '# alpha v2\n');
      expect(await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).not.toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('differs from the pre-migration `.git`-only digest of the same tree', async () => {
    // The recorded break: this is why pre-migration on-chain codeDigests are a
    // permanently non-joining population.
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      const legacy = await hashImplStateDir(dir, { ignoreRelPaths: ['.git'] });
      const migrated = await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 });
      expect(migrated).not.toBe(legacy);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('learner-public.v1 fail-closed classification', () => {
  it('refuses an unclassified top-level directory', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      await write(dir, 'scratch/notes.md', 'unclassified\n');
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(/scratch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unclassified top-level file', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      await write(dir, 'README.md', 'unclassified\n');
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows a regular file only where the table names a file', async () => {
    // `skills` is an allowed DIRECTORY; a regular file called `skills` is not an
    // allowed top-level file, so it fails closed. Directory-ness is part of the
    // classification, not just the name.
    const dir = await buildForkHealingFixture({ withIgnoredRoots: false });
    try {
      await rm(join(dir, 'skills'), { recursive: true, force: true });
      await writeFile(join(dir, 'skills'), 'not a directory\n', 'utf8');
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a top-level directory named for an allowed file', async () => {
    // `policy.json` is classified as an allowed top-level FILE only. A
    // directory by that name is not an allowed top-level directory, so it
    // fails closed — the mirror image of "allows a regular file only where
    // the table names a file" above.
    const dir = await tmp('policy-json-dir-');
    try {
      await mkdir(join(dir, 'policy.json'), { recursive: true });
      await writeFile(join(dir, 'policy.json', 'nested.txt'), 'x\n', 'utf8');
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a symlink at the top level rather than following it', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: false });
    try {
      await symlink(join(dir, 'policy.json'), join(dir, 'agents'));
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a symlink nested inside a contributing root', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: false });
    try {
      await symlink(join(dir, 'policy.json'), join(dir, 'skills', 'link.md'));
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores an excluded root without classifying what is inside it', async () => {
    // `.git` holds arbitrary bytes including symlinks; the profile must skip
    // the whole subtree before any classification runs.
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      await symlink(join(dir, 'policy.json'), join(dir, '.git', 'link'));
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).resolves.toMatch(
        /^[0-9a-f]{64}$/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a caller supplying both a profile and an ad hoc ignore list', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: false });
    try {
      await expect(
        hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1, ignoreRelPaths: ['.git'] }),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('learner-public.v1 ignore precedes classification', () => {
  it('silently ignores a top-level FILE named for an excluded root', async () => {
    // `secrets` is an excluded root, and `shouldIgnore` matches on relPath
    // alone before depth-0 classification ever runs — so a top-level regular
    // *file* called `secrets` is ignored the same as the directory would be,
    // even though `secrets` is not in `allowedFiles` and a same-named file
    // would otherwise fail closed as unclassified. This is pinned as current
    // deliberate behavior, not implied by the spike table alone.
    const withFile = await tmp('secrets-file-');
    const withoutFile = await tmp('secrets-file-baseline-');
    try {
      await write(withFile, 'notes/a.md', 'a\n');
      await writeFile(join(withFile, 'secrets'), 'not a directory\n', 'utf8');
      await write(withoutFile, 'notes/a.md', 'a\n');
      const withDigest = await hashImplStateDir(withFile, { profile: LEARNER_PUBLIC_V1 });
      const withoutDigest = await hashImplStateDir(withoutFile, { profile: LEARNER_PUBLIC_V1 });
      expect(withDigest).toBe(withoutDigest);
    } finally {
      await rm(withFile, { recursive: true, force: true });
      await rm(withoutFile, { recursive: true, force: true });
    }
  });
});

describe('fork-healing fixture digest constant', () => {
  it('hashes the stated fixture tree to the recorded constant', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      expect(await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).toBe(
        FORK_HEALING_FIXTURE_DIGEST,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('learner-public.v1 code-unit sort order', () => {
  // DEEP review finding: `localeCompare` resolves against the host's LANG via
  // ICU, so the same tree hashed the same profile on two machines with
  // different locales could disagree on entry order and therefore on the
  // digest. Code-unit (`<`/`>`) comparison is locale-independent and is the
  // one order reproducible from the profile's published description alone.
  it('sorts entries by UTF-16 code unit, not locale collation', async () => {
    const dir = await tmp('code-unit-sort-');
    try {
      await write(dir, 'notes/Bravo.md', 'B\n');
      await write(dir, 'notes/alpha.md', 'a\n');
      // Code-unit order: 'B' (U+0042) < 'a' (U+0061), so "Bravo.md" sorts
      // before "alpha.md" — the reverse of case-insensitive locale collation,
      // which would place "alpha.md" first on primary-letter comparison.
      expect(await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).toBe(
        'a3d6b71dea3ca7dc352679fb91219370aa32d19b906c829739bb20dac5aa0340',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is independent of host locale collation (ICU en_US would sort ä before z)', async () => {
    const dir = await tmp('locale-independent-');
    try {
      await write(dir, 'skills/ä.md', 'a-umlaut\n');
      await write(dir, 'skills/z.md', 'zed\n');
      // Code-unit order: 'z' (U+007A) < 'ä' (U+00E4), so "z.md" sorts before
      // "ä.md" here. An ICU en_US collator (localeCompare's default) treats
      // "ä" as a variant of "a" and would sort it before "z", producing a
      // different digest. Pinning code-unit order means this digest does not
      // depend on the operator's `LANG`.
      expect(await hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).toBe(
        '8263413c2426c54b9af3b62e9809dd5724490aa6bbba1e839c9873a84827f3de',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('learner-public.v1 control-character refusal', () => {
  it('refuses a control character in a path component', async () => {
    const dir = await tmp('control-char-');
    try {
      await mkdir(join(dir, 'skills'), { recursive: true });
      // POSIX allows any byte except NUL and `/` in a filename. A literal LF
      // inside a path component would otherwise forge the LF-joined
      // "<relPath>:<fileHash>" combining format, merging two entries into one
      // line. Written directly via fs, not the `write()` helper, because the
      // helper splits on `/` and this control character is not a separator.
      await writeFile(join(dir, 'skills', 'bad\nname.md'), 'x\n', 'utf8');
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        HashProfileViolationError,
      );
      await expect(hashImplStateDir(dir, { profile: LEARNER_PUBLIC_V1 })).rejects.toThrow(
        /control character/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('one scheme, three uses', () => {
  const fixtureHarness: Harness = {
    name: 'learner-shaped',
    version: '0.1.0',
    freezeStateHashProfile: LEARNER_PUBLIC_V1,
    supports: () => true,
    async run(): Promise<Solution> {
      return { artifact: {} as any, rationale: [] } as any;
    },
  };

  function makeCtx(implStateDir: string): HarnessContext {
    return {
      task: { id: 't1', solverType: 'prediction.v1' } as any,
      implStateDir,
      workingDir: implStateDir,
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 0,
      trajectory: { addSpan: () => {} } as any,
      mode: 'frozen',
    };
  }

  it('the freeze fence, the delivery codeDigest, and the status surface agree', async () => {
    const dir = await buildForkHealingFixture({ withIgnoredRoots: true });
    try {
      // 1. fence + delivery codeDigest (same producer: the fence's return value
      //    is what the engine stamps on the envelope).
      const fenced = await runHarnessWithFreezeFence(fixtureHarness, makeCtx(dir));
      expect(fenced.ok).toBe(true);
      const fenceDigest = fenced.ok ? fenced.codeDigest : '';

      // 2. the status surface's resolution path (main.ts resolves the profile
      //    from the configured harness name alone).
      const statusProfile = hashProfileForHarness(DEFAULT_HARNESS);
      expect(statusProfile).toBe(LEARNER_PUBLIC_V1);
      const statusDigest = await hashImplStateDir(dir, { profile: statusProfile! });

      expect(fenceDigest).toBe(statusDigest);
      expect(fenceDigest).toBe(FORK_HEALING_FIXTURE_DIGEST);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the shipped learner harness declares the profile the status surface resolves', () => {
    const learner = new LearnerHarness({ adapter: new NoOpAdapter() });
    expect(learner.freezeStateHashProfile).toBe(LEARNER_PUBLIC_V1);
    expect(hashProfileForHarness(learner.name)).toBe(learner.freezeStateHashProfile);
  });

  it('agrees with a constructed codex learner instance, same as claude-code', () => {
    const learner = new LearnerHarness({ adapter: new NoOpAdapter(), name: CODEX_HARNESS });
    expect(learner.freezeStateHashProfile).toBe(LEARNER_PUBLIC_V1);
    expect(hashProfileForHarness(learner.name)).toBe(learner.freezeStateHashProfile);
  });

  it('leaves harnesses without a registered public profile on their own ignore list', () => {
    expect(hashProfileForHarness(HERMES_AGENT_HARNESS)).toBeUndefined();
    expect(harnessHashOptions({ freezeStateHashIgnore: ['auth', '.env'] })).toEqual({
      ignoreRelPaths: ['auth', '.env'],
    });
  });

  it('prefers a declared profile over a legacy ignore list', () => {
    expect(
      harnessHashOptions({ freezeStateHashProfile: LEARNER_PUBLIC_V1, freezeStateHashIgnore: ['.git'] }),
    ).toEqual({ profile: LEARNER_PUBLIC_V1 });
    expect(harnessHashOptions({})).toBeUndefined();
  });
});
