import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_MARKETPLACE_PATCH_BYTES,
  MarketplacePatchApplicationError,
  MarketplacePatchCheckError,
  MarketplacePatchValidationError,
  applyMarketplacePatchToWorktree,
  type MarketplacePatchGitRunner,
  type MarketplacePatchLstat,
  validateMarketplacePatch,
} from '../../src/lifecycle/marketplace-patch.js';

const MAX_BYTES = 2 * 1024 * 1024;
const EMPTY_GIT_OUTPUT = new Uint8Array();
const missingExceptTrustedRoot: MarketplacePatchLstat = async (path) => (
  path === '/trusted/worktree' ? 'directory' : 'missing'
);

function indexStageRecord(
  path: string,
  mode = '100644',
  stage = '0',
): Uint8Array {
  return Buffer.from(
    `${mode} ${'a'.repeat(40)} ${stage}\t${path}\0`,
    'utf8',
  );
}

function modificationPatch(path = 'src/value.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

function exactSizePatch(size: number): Uint8Array {
  const prefix = [
    'diff --git a/large.txt b/large.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/large.txt',
    '@@ -0,0 +1 @@',
    '+',
  ].join('\n');
  const suffix = '\n';
  const payloadBytes = size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (payloadBytes < 0) throw new Error('Requested patch size is too small');
  return Buffer.from(`${prefix}${'x'.repeat(payloadBytes)}${suffix}`, 'utf8');
}

function expectValidationReason(artifact: Uint8Array | string, reason: string): void {
  try {
    validateMarketplacePatch(
      typeof artifact === 'string' ? Buffer.from(artifact, 'utf8') : artifact,
    );
    throw new Error('Expected patch validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplacePatchValidationError);
    expect(error).toMatchObject({ reason });
  }
}

function patchWithPathSurface(
  surface:
    | 'diff-old'
    | 'diff-new'
    | 'old-marker'
    | 'new-marker'
    | 'rename-from'
    | 'rename-to'
    | 'copy-from'
    | 'copy-to',
  unsafePath: string,
): string {
  if (surface === 'rename-from' || surface === 'rename-to') {
    return [
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      `rename from ${surface === 'rename-from' ? unsafePath : 'old.txt'}`,
      `rename to ${surface === 'rename-to' ? unsafePath : 'new.txt'}`,
      '',
    ].join('\n');
  }
  if (surface === 'copy-from' || surface === 'copy-to') {
    return [
      'diff --git a/source.txt b/copied.txt',
      'similarity index 100%',
      `copy from ${surface === 'copy-from' ? unsafePath : 'source.txt'}`,
      `copy to ${surface === 'copy-to' ? unsafePath : 'copied.txt'}`,
      '',
    ].join('\n');
  }

  const diffOld = surface === 'diff-old' ? unsafePath : 'a/safe.txt';
  const diffNew = surface === 'diff-new' ? unsafePath : 'b/safe.txt';
  const oldMarker = surface === 'old-marker' ? unsafePath : 'a/safe.txt';
  const newMarker = surface === 'new-marker' ? unsafePath : 'b/safe.txt';
  return [
    `diff --git ${diffOld} ${diffNew}`,
    'index 1111111..2222222 100644',
    `--- ${oldMarker}`,
    `+++ ${newMarker}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

describe('marketplace patch validation', () => {
  it('accepts an artifact exactly at the 2 MiB byte limit', () => {
    const artifact = exactSizePatch(MAX_BYTES);

    expect(artifact.byteLength).toBe(MAX_BYTES);
    expect(validateMarketplacePatch(artifact)).toEqual({
      byteLength: MAX_BYTES,
      touchedPaths: ['large.txt'],
    });
    expect(MAX_MARKETPLACE_PATCH_BYTES).toBe(MAX_BYTES);
  });

  it('rejects an artifact one byte over the 2 MiB limit', () => {
    expectValidationReason(exactSizePatch(MAX_BYTES + 1), 'artifact-too-large');
  });

  it('measures multibyte artifacts as bytes rather than JavaScript characters', () => {
    const base = modificationPatch();
    const oversized = `${base}${'€'.repeat(Math.ceil(MAX_BYTES / 3))}`;

    expect(oversized.length).toBeLessThan(MAX_BYTES);
    expectValidationReason(Buffer.from(oversized, 'utf8'), 'artifact-too-large');
  });

  it('rejects invalid UTF-8', () => {
    const bytes = Buffer.concat([
      Buffer.from(modificationPatch(), 'utf8'),
      Buffer.from([0xc3, 0x28]),
    ]);

    expectValidationReason(bytes, 'invalid-utf8');
  });

  it('rejects NUL bytes', () => {
    const bytes = Buffer.concat([
      Buffer.from(modificationPatch(), 'utf8'),
      Buffer.from([0]),
    ]);

    expectValidationReason(bytes, 'nul-byte');
  });

  it.each([
    'GIT binary patch',
    'Binary files a/image.png and b/image.png differ',
  ])('rejects the binary-diff marker %s', (marker) => {
    expectValidationReason(`${modificationPatch()}${marker}\n`, 'binary-patch');
  });

  it.each([
    ['POSIX absolute path', '/etc/passwd'],
    ['Windows drive path', 'C:\\Windows\\system.ini'],
    ['UNC path', '\\\\server\\share\\secret.txt'],
    ['forward-slash traversal', 'a/../../secret.txt'],
    ['backslash traversal', 'a\\..\\..\\secret.txt'],
    ['lowercase Git metadata component', 'a/src/.git/config'],
    ['case-variant Git metadata component', 'a/src/.GiT/config'],
    ['package manifest', 'a/operator/package.json'],
    ['package lock', 'a/operator/yarn.lock'],
    ['Yarn configuration', 'a/client/.yarnrc.yml'],
    ['Yarn plugin', 'a/client/.yarn/plugins/plugin.cjs'],
    ['installed dependency', 'a/client/node_modules/better-sqlite3/install.js'],
    ['PnP loader', 'a/client/.pnp.cjs'],
    ['trusted sandbox config shadow', 'a/client/jinn-autopilot-trusted.yml'],
    ['TypeScript control', 'a/client/tsconfig.json'],
    ['Vitest control', 'a/client/vitest.config.ts'],
    ['existing test', 'a/operator/test/security.test.ts'],
    ['co-located test', 'a/operator/src/security.test.ts'],
    ['test snapshot', 'a/operator/src/__snapshots__/security.test.ts.snap'],
  ])('rejects %s', (_name, unsafePath) => {
    expectValidationReason(
      patchWithPathSurface('old-marker', unsafePath),
      'unsafe-path',
    );
  });

  it('rejects a Windows drive path hidden behind a Git side prefix', () => {
    expectValidationReason(
      patchWithPathSurface('old-marker', 'a/C:/Windows/system.ini'),
      'unsafe-path',
    );
  });

  it.each([
    'diff-old',
    'diff-new',
    'old-marker',
    'new-marker',
    'rename-from',
    'rename-to',
    'copy-from',
    'copy-to',
  ] as const)('validates the %s path surface', (surface) => {
    expectValidationReason(
      patchWithPathSurface(surface, '../secret.txt'),
      'unsafe-path',
    );
  });

  it.each([
    [
      'missing diff target',
      [
        'diff --git a/safe.txt',
        '--- a/safe.txt',
        '+++ b/safe.txt',
        '',
      ].join('\n'),
    ],
    [
      'ambiguous diff target separator',
      [
        'diff --git a/old b/decoy.txt b/new.txt',
        '--- a/old b/decoy.txt',
        '+++ b/new.txt',
        '',
      ].join('\n'),
    ],
    [
      'unterminated quoted path',
      [
        'diff --git "a/safe.txt b/safe.txt',
        '--- a/safe.txt',
        '+++ b/safe.txt',
        '',
      ].join('\n'),
    ],
    [
      'empty path component',
      modificationPatch('src//value.ts'),
    ],
    [
      'dot path component',
      modificationPatch('src/./value.ts'),
    ],
    [
      'control character in path',
      modificationPatch('src/\u0001value.ts'),
    ],
  ])('rejects malformed or ambiguous paths: %s', (_name, patch) => {
    expectValidationReason(patch, 'malformed-patch');
  });

  it('permits /dev/null only as an add or delete marker', () => {
    const add = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+new',
      '',
    ].join('\n');
    const remove = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old',
      '',
    ].join('\n');

    expect(validateMarketplacePatch(Buffer.from(add))).toMatchObject({
      touchedPaths: ['new.txt'],
    });
    expect(validateMarketplacePatch(Buffer.from(remove))).toMatchObject({
      touchedPaths: ['old.txt'],
    });
    expectValidationReason(
      patchWithPathSurface('diff-old', '/dev/null'),
      'unsafe-path',
    );
    expectValidationReason(
      [
        'diff --git a/safe.txt b/safe.txt',
        '--- /dev/null',
        '+++ /dev/null',
        '',
      ].join('\n'),
      'malformed-patch',
    );
  });

  it.each([
    'old mode',
    'new mode',
    'new file mode',
    'deleted file mode',
  ])('rejects symlink mode in a %s line', (modeLine) => {
    expectValidationReason(
      [
        'diff --git a/safe.txt b/safe.txt',
        `${modeLine} 120000`,
        '--- a/safe.txt',
        '+++ b/safe.txt',
        '',
      ].join('\n'),
      'unsupported-mode',
    );
  });

  it.each([
    'old mode',
    'new mode',
    'new file mode',
    'deleted file mode',
  ])('rejects gitlink mode in a %s line', (modeLine) => {
    expectValidationReason(
      [
        'diff --git a/safe.txt b/safe.txt',
        `${modeLine} 160000`,
        '--- a/safe.txt',
        '+++ b/safe.txt',
        '',
      ].join('\n'),
      'unsupported-mode',
    );
  });

  it.each(['120000', '160000'])('rejects unsafe %s index mode', (mode) => {
    expectValidationReason(
      [
        'diff --git a/safe.txt b/safe.txt',
        `index 1111111..2222222 ${mode}`,
        '--- a/safe.txt',
        '+++ b/safe.txt',
        '',
      ].join('\n'),
      'unsupported-mode',
    );
  });

  it('rejects unsupported regular-file mode transitions', () => {
    expectValidationReason(
      [
        'diff --git a/safe.txt b/safe.txt',
        'old mode 100644',
        'new mode 100600',
        '',
      ].join('\n'),
      'unsupported-mode',
    );
  });

  it('accepts the supported executable-bit transition', () => {
    const patch = [
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');

    expect(validateMarketplacePatch(Buffer.from(patch))).toMatchObject({
      touchedPaths: ['script.sh'],
    });
  });

  it('returns sorted, deduplicated repository-relative touched paths', () => {
    const patch = [
      modificationPatch('zeta/value.ts').trimEnd(),
      'diff --git a/old name.txt b/alpha/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to alpha/new name.txt',
      '',
    ].join('\n');

    expect(validateMarketplacePatch(Buffer.from(patch))).toEqual({
      byteLength: Buffer.byteLength(patch),
      touchedPaths: ['alpha/new name.txt', 'old name.txt', 'zeta/value.ts'],
    });
  });

  it('decodes unambiguous Git-quoted UTF-8 paths', () => {
    const patch = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      'index 1111111..2222222 100644',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      '',
    ].join('\n');

    expect(validateMarketplacePatch(Buffer.from(patch))).toMatchObject({
      touchedPaths: ['café.txt'],
    });
  });

  it('does not let a later plain-diff file hide behind a completed Git hunk', () => {
    const patch = [
      'diff --git a/safe.txt b/safe.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/safe.txt',
      '@@ -0,0 +1 @@',
      '+safe',
      '--- /dev/null',
      '+++ b/../secret.txt',
      '@@ -0,0 +1 @@',
      '+secret',
      '',
    ].join('\n');

    expectValidationReason(patch, 'unsafe-path');
  });
});

describe('marketplace patch worktree application', () => {
  it('rejects a mode-less content diff targeting an untracked filesystem symlink', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'marketplace-patch-untracked-link-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      symlinkSync('target-before', join(repository, 'link'));
      const oldBlob = execFileSync('git', ['hash-object', '--stdin'], {
        cwd: repository,
        encoding: 'utf8',
        input: 'target-before',
      }).trim();
      const newBlob = execFileSync('git', ['hash-object', '--stdin'], {
        cwd: repository,
        encoding: 'utf8',
        input: 'target-after',
      }).trim();
      const artifact = Buffer.from([
        'diff --git a/link b/link',
        `index ${oldBlob.slice(0, 7)}..${newBlob.slice(0, 7)}`,
        '--- a/link',
        '+++ b/link',
        '@@ -1 +1 @@',
        '-target-before',
        '\\ No newline at end of file',
        '+target-after',
        '\\ No newline at end of file',
        '',
      ].join('\n'));

      await expect(applyMarketplacePatchToWorktree({
        artifact,
        worktreePath: repository,
      })).rejects.toMatchObject({
        reason: 'unsafe-filesystem-symlink',
      });
      expect(readlinkSync(join(repository, 'link'))).toBe('target-before');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects a mode-less content diff targeting a tracked symlink without repointing it', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'marketplace-patch-symlink-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      symlinkSync('target-before', join(repository, 'link'));
      execFileSync('git', ['add', '--', 'link'], { cwd: repository });
      const oldBlob = execFileSync('git', ['hash-object', '--stdin'], {
        cwd: repository,
        encoding: 'utf8',
        input: 'target-before',
      }).trim();
      const newBlob = execFileSync('git', ['hash-object', '--stdin'], {
        cwd: repository,
        encoding: 'utf8',
        input: 'target-after',
      }).trim();
      const artifact = Buffer.from([
        'diff --git a/link b/link',
        `index ${oldBlob.slice(0, 7)}..${newBlob.slice(0, 7)}`,
        '--- a/link',
        '+++ b/link',
        '@@ -1 +1 @@',
        '-target-before',
        '\\ No newline at end of file',
        '+target-after',
        '\\ No newline at end of file',
        '',
      ].join('\n'));

      await expect(applyMarketplacePatchToWorktree({
        artifact,
        worktreePath: repository,
      })).rejects.toMatchObject({
        reason: 'unsafe-filesystem-symlink',
      });
      expect(readlinkSync(join(repository, 'link'))).toBe('target-before');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects a filesystem symlink ancestor without modifying its target', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'marketplace-patch-link-ancestor-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      mkdirSync(join(repository, 'real-directory'));
      writeFileSync(join(repository, 'real-directory', 'value.txt'), 'old\n');
      symlinkSync('real-directory', join(repository, 'linked-directory'));

      await expect(applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch('linked-directory/value.txt')),
        worktreePath: repository,
      })).rejects.toMatchObject({
        reason: 'unsafe-filesystem-symlink',
      });
      expect(
        execFileSync(
          'git',
          ['hash-object', 'real-directory/value.txt'],
          { cwd: repository, encoding: 'utf8' },
        ).trim(),
      ).toBe(
        execFileSync(
          'git',
          ['hash-object', '--stdin'],
          { cwd: repository, input: 'old\n', encoding: 'utf8' },
        ).trim(),
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects a tracked gitlink observed from a real Git index', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'marketplace-patch-gitlink-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: repository,
      });
      execFileSync('git', ['config', 'user.name', 'Patch Test'], {
        cwd: repository,
      });
      writeFileSync(join(repository, 'seed.txt'), 'seed\n');
      execFileSync('git', ['add', '--', 'seed.txt'], { cwd: repository });
      execFileSync('git', ['commit', '--quiet', '-m', 'seed'], {
        cwd: repository,
      });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim();
      execFileSync(
        'git',
        ['update-index', '--add', '--cacheinfo', `160000,${commit},vendor/module`],
        { cwd: repository },
      );

      await expect(applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch('vendor/module')),
        worktreePath: repository,
      })).rejects.toMatchObject({
        reason: 'unsafe-existing-mode',
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects a patch below a tracked gitlink ancestor', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'marketplace-patch-gitlink-child-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: repository,
      });
      execFileSync('git', ['config', 'user.name', 'Patch Test'], {
        cwd: repository,
      });
      writeFileSync(join(repository, 'seed.txt'), 'seed\n');
      execFileSync('git', ['add', '--', 'seed.txt'], { cwd: repository });
      execFileSync('git', ['commit', '--quiet', '-m', 'seed'], {
        cwd: repository,
      });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim();
      execFileSync(
        'git',
        ['update-index', '--add', '--cacheinfo', `160000,${commit},vendor/module`],
        { cwd: repository },
      );
      mkdirSync(join(repository, 'vendor', 'module'), { recursive: true });
      writeFileSync(join(repository, 'vendor', 'module', 'new.txt'), 'old\n');

      await expect(applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch('vendor/module/new.txt')),
        worktreePath: repository,
      })).rejects.toMatchObject({
        reason: 'unsafe-existing-mode',
      });
      expect(
        execFileSync(
          'git',
          ['hash-object', '--stdin'],
          { cwd: repository, input: 'old\n', encoding: 'utf8' },
        ).trim(),
      ).toBe(
        execFileSync(
          'git',
          ['hash-object', 'vendor/module/new.txt'],
          { cwd: repository, encoding: 'utf8' },
        ).trim(),
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('runs check before apply, uses stdin/argument arrays, and never requests three-way merge', async () => {
    const artifact = Buffer.from(modificationPatch());
    const events: string[] = [];
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
      stdin: Uint8Array;
    }> = [];
    const lstatPath: MarketplacePatchLstat = async (path) => {
      events.push(`lstat:${path}`);
      if (path === '/trusted/worktree' || path.endsWith('/src')) return 'directory';
      return 'regular-file';
    };
    const runGit: MarketplacePatchGitRunner = async (command, args, options) => {
      events.push(`git:${args.join(' ')}`);
      calls.push({
        command,
        args: [...args],
        cwd: options.cwd,
        stdin: Uint8Array.from(options.stdin),
      });
      if (args[0] === '--literal-pathspecs') {
        return Buffer.concat([
          indexStageRecord('src/value.ts'),
          indexStageRecord('src/other.ts'),
        ]);
      }
      return EMPTY_GIT_OUTPUT;
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact,
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath,
    })).resolves.toMatchObject({ touchedPaths: ['src/value.ts'] });

    expect(events).toEqual([
      'lstat:/trusted/worktree',
      'lstat:/trusted/worktree/src',
      'lstat:/trusted/worktree/src/value.ts',
      'git:--literal-pathspecs ls-files --stage -z -- src src/value.ts',
      'git:apply --check',
      'git:apply',
    ]);
    expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
      {
        command: 'git',
        args: [
          '--literal-pathspecs',
          'ls-files',
          '--stage',
          '-z',
          '--',
          'src',
          'src/value.ts',
        ],
        cwd: '/trusted/worktree',
      },
      {
        command: 'git',
        args: ['apply', '--check'],
        cwd: '/trusted/worktree',
      },
      {
        command: 'git',
        args: ['apply'],
        cwd: '/trusted/worktree',
      },
    ]);
    expect(calls.every((call) => !call.args.includes('--3way'))).toBe(true);
    expect(calls[0]!.stdin).toHaveLength(0);
    expect(Buffer.from(calls[1]!.stdin).equals(artifact)).toBe(true);
    expect(Buffer.from(calls[2]!.stdin).equals(artifact)).toBe(true);
  });

  it('does not invoke Git when validation fails', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      return EMPTY_GIT_OUTPUT;
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from('not a patch'),
      worktreePath: '/trusted/worktree',
      runGit,
    })).rejects.toMatchObject({
      reason: 'malformed-patch',
    });
    expect(calls).toEqual([]);
  });

  it('rejects an untrusted worktree path with a stable error before invoking Git', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      return EMPTY_GIT_OUTPUT;
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch()),
      worktreePath: 'relative/worktree',
      runGit,
    })).rejects.toMatchObject({
      reason: 'invalid-worktree-path',
    });
    expect(calls).toEqual([]);
  });

  it('fails closed with a stable check error and does not apply', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === '--literal-pathspecs') return EMPTY_GIT_OUTPUT;
      throw new Error('patch does not apply');
    };

    let thrown: unknown;
    try {
      await applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch()),
        worktreePath: '/trusted/worktree',
        runGit,
        lstatPath: missingExceptTrustedRoot,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MarketplacePatchCheckError);
    expect(thrown).toMatchObject({ reason: 'git-check-failed' });
    expect(calls).toEqual([
      [
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '-z',
        '--',
        'src',
        'src/value.ts',
      ],
      ['apply', '--check'],
    ]);
  });

  it('exposes a stable application error after a successful check', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'apply' && args.length === 1) {
        throw new Error('worktree changed after check');
      }
      return EMPTY_GIT_OUTPUT;
    };

    let thrown: unknown;
    try {
      await applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch()),
        worktreePath: '/trusted/worktree',
        runGit,
        lstatPath: missingExceptTrustedRoot,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MarketplacePatchApplicationError);
    expect(thrown).toMatchObject({ reason: 'git-apply-failed' });
    expect(calls).toEqual([
      [
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '-z',
        '--',
        'src',
        'src/value.ts',
      ],
      ['apply', '--check'],
      ['apply'],
    ]);
  });

  it('uses an immutable artifact snapshot across the check/apply boundary', async () => {
    const artifact = Buffer.from(modificationPatch());
    const expected = Buffer.from(artifact);
    const observed: Buffer[] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args, options) => {
      if (args[0] === 'apply') {
        observed.push(Buffer.from(options.stdin));
        options.stdin.fill(0);
      }
      return EMPTY_GIT_OUTPUT;
    };

    await applyMarketplacePatchToWorktree({
      artifact,
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath: missingExceptTrustedRoot,
    });

    expect(observed).toHaveLength(2);
    expect(observed[0]!.equals(expected)).toBe(true);
    expect(observed[1]!.equals(expected)).toBe(true);
    expect(artifact.equals(expected)).toBe(true);
  });

  it.each([
    ['symlink', '120000'],
    ['gitlink', '160000'],
    ['unsupported regular mode', '100600'],
  ])('rejects an existing tracked %s before checking or applying', async (_name, mode) => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] !== '--literal-pathspecs') {
        throw new Error('apply command must not run');
      }
      return indexStageRecord('vendor/module', mode);
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch('vendor/module')),
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath: missingExceptTrustedRoot,
    })).rejects.toMatchObject({
      reason: 'unsafe-existing-mode',
    });
    expect(calls).toEqual([[
      '--literal-pathspecs',
      'ls-files',
      '--stage',
      '-z',
      '--',
      'vendor',
      'vendor/module',
    ]]);
  });

  it.each([
    [
      'malformed record',
      Buffer.from('not-an-index-record\0'),
    ],
    [
      'non-NUL-terminated',
      Buffer.from(`100644 ${'a'.repeat(40)} 0\tsrc/value.ts`),
    ],
    [
      'duplicate',
      Buffer.concat([
        indexStageRecord('src/value.ts'),
        indexStageRecord('src/value.ts'),
      ]),
    ],
    [
      'unexpected path',
      indexStageRecord('other.ts'),
    ],
    [
      'non-zero merge stage',
      indexStageRecord('src/value.ts', '100644', '1'),
    ],
  ])('rejects %s index output before checking or applying', async (_name, output) => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] !== '--literal-pathspecs') {
        throw new Error('apply command must not run');
      }
      return output;
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch()),
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath: missingExceptTrustedRoot,
    })).rejects.toMatchObject({
      reason: 'malformed-index-output',
    });
    expect(calls).toHaveLength(1);
  });

  it('exposes a stable index-inspection error without checking or applying', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      throw new Error('index unavailable');
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch()),
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath: missingExceptTrustedRoot,
    })).rejects.toMatchObject({
      reason: 'git-index-inspection-failed',
    });
    expect(calls).toHaveLength(1);
  });

  it('queries index ancestors and rejects a gitlink record before apply commands', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] !== '--literal-pathspecs') {
        throw new Error('apply command must not run');
      }
      return indexStageRecord('vendor/module', '160000');
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch('vendor/module/new.txt')),
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath: missingExceptTrustedRoot,
    })).rejects.toMatchObject({
      reason: 'unsafe-existing-mode',
    });
    expect(calls).toEqual([[
      '--literal-pathspecs',
      'ls-files',
      '--stage',
      '-z',
      '--',
      'vendor',
      'vendor/module',
      'vendor/module/new.txt',
    ]]);
  });

  it.each([
    ['touched path', '/trusted/worktree/src/value.ts'],
    ['ancestor', '/trusted/worktree/src'],
  ])('rejects a filesystem symlink at the %s before invoking Git', async (
    _name,
    symlinkPath,
  ) => {
    const gitCalls: string[][] = [];
    const inspected: string[] = [];
    const lstatPath: MarketplacePatchLstat = async (path) => {
      inspected.push(path);
      if (path === symlinkPath) return 'symlink';
      if (path === '/trusted/worktree' || path.endsWith('/src')) return 'directory';
      return 'regular-file';
    };
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      gitCalls.push([...args]);
      return EMPTY_GIT_OUTPUT;
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch()),
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath,
    })).rejects.toMatchObject({
      reason: 'unsafe-filesystem-symlink',
    });
    expect(inspected).toContain(symlinkPath);
    expect(gitCalls).toEqual([]);
  });

  it.each([
    ['non-directory ancestor', async (path: string) => (
      path.endsWith('/src') ? 'regular-file' as const : 'directory' as const
    ), 'unsafe-filesystem-type'],
    ['missing worktree root', async () => 'missing' as const, 'filesystem-inspection-failed'],
    ['inspection failure', async () => {
      throw new Error('lstat unavailable');
    }, 'filesystem-inspection-failed'],
  ])('fails closed for %s without invoking Git', async (
    _name,
    lstatPath,
    reason,
  ) => {
    const gitCalls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      gitCalls.push([...args]);
      return EMPTY_GIT_OUTPUT;
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact: Buffer.from(modificationPatch()),
      worktreePath: '/trusted/worktree',
      runGit,
      lstatPath,
    })).rejects.toMatchObject({ reason });
    expect(gitCalls).toEqual([]);
  });
});
