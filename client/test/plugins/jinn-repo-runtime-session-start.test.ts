import { afterEach, describe, expect, it } from 'vitest';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const sh = promisify(execFile);
const HOOK = fileURLToPath(
  new URL('../../plugins/jinn-repo-runtime/hooks/session-start', import.meta.url),
);
const BASE_COMMIT = 'a'.repeat(40);
const RELAY_INPUT_HEAD = 'b'.repeat(40);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runSessionStartProbe(
  spec: Record<string, unknown>,
  gitHead = BASE_COMMIT,
): Promise<{ readonly gitArgs: string[]; readonly repoExists: boolean }> {
  const workingDir = await mkdtemp(join(tmpdir(), 'jinn-repo-runtime-session-start-'));
  tempDirs.push(workingDir);
  const binDir = join(workingDir, 'bin');
  const gitLog = join(workingDir, 'git.log');
  await mkdir(binDir);
  await writeFile(join(workingDir, 'task.json'), JSON.stringify({ spec }));
  await writeFile(
    join(binDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$GIT_LOG"',
      'if [[ "$1" == "-C" && "$3" == "rev-parse" ]]; then',
      '  printf "%s\\n" "$GIT_HEAD"',
      'fi',
    ].join('\n'),
  );
  await chmod(join(binDir, 'git'), 0o755);

  const result = await sh('bash', [HOOK], {
    cwd: workingDir,
    env: {
      ...process.env,
      WORKING_DIR: workingDir,
      GIT_LOG: gitLog,
      GIT_HEAD: gitHead,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
  });
  expect(result.stdout).toBe('');

  try {
    return {
      gitArgs: (await readFile(gitLog, 'utf8')).trim().split('\n').filter(Boolean),
      repoExists: await access(join(workingDir, 'repo')).then(
        () => true,
        () => false,
      ),
    };
  } catch {
    return {
      gitArgs: [],
      repoExists: await access(join(workingDir, 'repo')).then(
        () => true,
        () => false,
      ),
    };
  }
}

async function runSessionStart(spec: Record<string, unknown>): Promise<string[]> {
  return (await runSessionStartProbe(spec)).gitArgs;
}

function liveIssueSpec(workspaceRepository?: string): Record<string, unknown> {
  return {
    repo: 'Jinn-Network/mono',
    base_commit: BASE_COMMIT,
    ...(workspaceRepository === undefined
      ? {}
      : { relay: { workspaceRepository, inputHead: RELAY_INPUT_HEAD } }),
  };
}

describe('jinn-repo-runtime session-start hook', () => {
  it('fetches a legacy live issue from its outer repository at the outer base commit', async () => {
    const gitArgs = await runSessionStart(liveIssueSpec());

    expect(gitArgs).toContain('remote add origin https://github.com/Jinn-Network/mono.git');
    expect(gitArgs).toContain(`fetch --depth 1 --quiet origin ${BASE_COMMIT}`);
    expect(gitArgs).toContain('checkout --quiet FETCH_HEAD');
  });

  it('fetches an initial Relay round from its target workspace repository at the outer base commit', async () => {
    const gitArgs = await runSessionStart(liveIssueSpec('upstream-org/upstream-repo'));

    expect(gitArgs).toContain('remote add origin https://github.com/upstream-org/upstream-repo.git');
    expect(gitArgs).toContain(`fetch --depth 1 --quiet origin ${BASE_COMMIT}`);
    expect(gitArgs).not.toContain(`fetch --depth 1 --quiet origin ${RELAY_INPUT_HEAD}`);
  });

  it('fetches a repair Relay round from its managed-fork workspace repository at the outer base commit', async () => {
    const gitArgs = await runSessionStart(liveIssueSpec('managed-fork/relay-repair'));

    expect(gitArgs).toContain('remote add origin https://github.com/managed-fork/relay-repair.git');
    expect(gitArgs).toContain(`fetch --depth 1 --quiet origin ${BASE_COMMIT}`);
    expect(gitArgs).not.toContain(`fetch --depth 1 --quiet origin ${RELAY_INPUT_HEAD}`);
  });

  it('rejects a non-GitHub workspace value before spawning Git', async () => {
    const gitArgs = await runSessionStart(liveIssueSpec('https://github.com/managed-fork/relay-repair'));

    expect(gitArgs).toEqual([]);
  });

  it.each([
    ['an empty Relay object', {}],
    ['an empty Relay workspace repository', { workspaceRepository: '' }],
    ['a non-object Relay value', 'not-an-object'],
  ])('rejects %s before spawning Git', async (_caseName, relay) => {
    const gitArgs = await runSessionStart({
      repo: 'Jinn-Network/mono',
      base_commit: BASE_COMMIT,
      relay,
    });

    expect(gitArgs).toEqual([]);
  });

  it.each([
    ['short', 'abc123'],
    ['uppercase', 'A'.repeat(40)],
    ['non-hex', 'g'.repeat(40)],
  ])('rejects a %s base commit before spawning Git', async (_label, baseCommit) => {
    const gitArgs = await runSessionStart({
      ...liveIssueSpec(),
      base_commit: baseCommit,
    });

    expect(gitArgs).toEqual([]);
  });

  it('removes the checkout when post-check HEAD differs from the requested base', async () => {
    const result = await runSessionStartProbe(
      liveIssueSpec(),
      'b'.repeat(40),
    );

    expect(result.gitArgs).toContain(`fetch --depth 1 --quiet origin ${BASE_COMMIT}`);
    expect(result.repoExists).toBe(false);
  });
});
