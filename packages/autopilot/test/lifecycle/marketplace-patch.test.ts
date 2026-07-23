import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  MAX_MARKETPLACE_PATCH_BYTES,
  MarketplacePatchApplicationError,
  MarketplacePatchCheckError,
  MarketplacePatchValidationError,
  applyMarketplacePatchToWorktree,
  type MarketplacePatchGitRunner,
  validateMarketplacePatch,
} from '../../src/lifecycle/marketplace-patch.js';

const MAX_BYTES = 2 * 1024 * 1024;

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
  it('runs check before apply, uses stdin/argument arrays, and never requests three-way merge', async () => {
    const artifact = Buffer.from(modificationPatch());
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
      stdin: Uint8Array;
    }> = [];
    const runGit: MarketplacePatchGitRunner = async (command, args, options) => {
      calls.push({
        command,
        args: [...args],
        cwd: options.cwd,
        stdin: Uint8Array.from(options.stdin),
      });
    };

    await expect(applyMarketplacePatchToWorktree({
      artifact,
      worktreePath: '/trusted/worktree',
      runGit,
    })).resolves.toMatchObject({ touchedPaths: ['src/value.ts'] });

    expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
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
    expect(Buffer.from(calls[0]!.stdin).equals(artifact)).toBe(true);
    expect(Buffer.from(calls[1]!.stdin).equals(artifact)).toBe(true);
  });

  it('does not invoke Git when validation fails', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
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
      throw new Error('patch does not apply');
    };

    let thrown: unknown;
    try {
      await applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch()),
        worktreePath: '/trusted/worktree',
        runGit,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MarketplacePatchCheckError);
    expect(thrown).toMatchObject({ reason: 'git-check-failed' });
    expect(calls).toEqual([['apply', '--check']]);
  });

  it('exposes a stable application error after a successful check', async () => {
    const calls: string[][] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'apply' && args.length === 1) {
        throw new Error('worktree changed after check');
      }
    };

    let thrown: unknown;
    try {
      await applyMarketplacePatchToWorktree({
        artifact: Buffer.from(modificationPatch()),
        worktreePath: '/trusted/worktree',
        runGit,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MarketplacePatchApplicationError);
    expect(thrown).toMatchObject({ reason: 'git-apply-failed' });
    expect(calls).toEqual([
      ['apply', '--check'],
      ['apply'],
    ]);
  });

  it('uses an immutable artifact snapshot across the check/apply boundary', async () => {
    const artifact = Buffer.from(modificationPatch());
    const expected = Buffer.from(artifact);
    const observed: Buffer[] = [];
    const runGit: MarketplacePatchGitRunner = async (_command, _args, options) => {
      observed.push(Buffer.from(options.stdin));
      options.stdin.fill(0);
    };

    await applyMarketplacePatchToWorktree({
      artifact,
      worktreePath: '/trusted/worktree',
      runGit,
    });

    expect(observed).toHaveLength(2);
    expect(observed[0]!.equals(expected)).toBe(true);
    expect(observed[1]!.equals(expected)).toBe(true);
    expect(artifact.equals(expected)).toBe(true);
  });
});
