import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchIssue, WORKTREES_BASE } from '../../src/dispatcher/dispatch.js';
import type { ReadyIssue, DispatcherConfig } from '../../src/dispatcher/types.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../../src/dispatcher/dispatch.js';

// ---------------------------------------------------------------------------
// Derive the expected REPO_ROOT / worktree path.
// dispatch.ts computes REPO_ROOT as four levels up from src/dispatcher/:
//   src/dispatcher → src → packages/eng-loop → packages → repo root
// We replicate the same derivation so the test stays in sync automatically.
// The canonical task-worktree path is `<jinn-mono_worktrees>/<N>` per CLAUDE.md
// AI rule #1 — we import WORKTREES_BASE from dispatch.ts so the test stays in
// sync if that resolution logic changes.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// test/dispatcher → test → packages/eng-loop → packages → repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const EXPECTED_WORKTREE_PATH = join(WORKTREES_BASE, '418');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUE: ReadyIssue = {
  number: 418,
  title: 'feat(operator-app): expose generator health',
  shape: 'feat',
  blockedOn: 'Nothing',
  blockedOnIssue: null,
  effort: 'Medium',
  priority: 'P1',
  status: 'Todo',
  onBoard: true,
  author: 'alice',
  projectItemId: 'PVTI_418',
};

const CFG: DispatcherConfig = {
  concurrencyCap: 3,
  openPrBackpressure: 5,
  wallClockMs: 4 * 60 * 60 * 1000,
  defaultImplementer: 'claude',
  authorAllowlist: ['alice'],
};

/**
 * Canned `gh project field-list` JSON.
 * Mirrors the real shape with the Status field that has an "In Progress" option.
 */
const FIELD_LIST_JSON = JSON.stringify({
  fields: [
    {
      id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
      name: 'Blocked on',
      options: [
        { id: '122744bf', name: 'Nothing' },
        { id: 'a20d20ac', name: 'Human' },
        { id: 'e3e1b0c4', name: 'Another issue' },
      ],
    },
    {
      id: 'PVTSSF_STATUS_FIELD_ID',
      name: 'Status',
      options: [
        { id: 'opt_todo', name: 'Todo' },
        { id: 'opt_in_progress', name: 'In Progress' },
        { id: 'opt_in_review', name: 'In Review' },
        { id: 'opt_done', name: 'Done' },
      ],
    },
    {
      id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRw',
      name: 'Effort',
      options: [
        { id: 'ef2a043d', name: 'Low' },
        { id: '6539eb71', name: 'Medium' },
        { id: '081839fa', name: 'High' },
      ],
    },
  ],
});

/**
 * Canned `git worktree list --porcelain` output — no jinn-mono_worktrees/418
 * worktree exists yet, so dispatchIssue must create it.
 */
const WORKTREE_LIST_EMPTY = [
  `worktree ${REPO_ROOT}`,
  'HEAD cdecb61a1f4e1274bda7ab6bb626cca6c465d86e',
  'branch refs/heads/next',
  '',
].join('\n');

/**
 * Canned `git worktree list --porcelain` output — jinn-mono_worktrees/418
 * worktree already exists (simulates dispatcher pre-created it before spawning).
 */
const WORKTREE_LIST_WITH_418 = [
  `worktree ${REPO_ROOT}`,
  'HEAD cdecb61a1f4e1274bda7ab6bb626cca6c465d86e',
  'branch refs/heads/next',
  '',
  `worktree ${EXPECTED_WORKTREE_PATH}`,
  'HEAD abc123def456abc123def456abc123def456abc1',
  'branch refs/heads/feat/418-expose-generator-health',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Records of every command issued to the runner. */
type RunnerCall = { cmd: string; args: string[] };

/**
 * Create a fake runner that responds with empty worktree list (no pre-existing
 * jinn-mono_worktrees/418), so git worktree add will be called.
 */
function makeRunner(
  worktreeListOutput: string = WORKTREE_LIST_EMPTY,
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    // git worktree list --porcelain → simulate existing worktrees
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return worktreeListOutput;
    // git worktree add → void (empty stdout)
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') return '';
    // gh project field-list → field JSON
    if (cmd === 'gh' && args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST_JSON;
    // gh project item-edit → void (empty stdout)
    if (cmd === 'gh' && args[0] === 'project' && args[1] === 'item-edit') return '';
    // Post-#585: gh project item-list is NOT called by dispatchIssue —
    // the project item id arrives on ReadyIssue.projectItemId. If this
    // branch is reached, dispatch.ts has regressed.
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

/** Records of every spawn call. */
type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

function makeSpawn(
  fakePid: number = 99999,
): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts: opts as Record<string, unknown> });
    return { pid: fakePid };
  };
  return { spawn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchIssue', () => {
  it('creates a jinn-mono_worktrees/<N> worktree off origin/next on a <shape>/<N>-<slug> branch (absolute path)', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    const worktreeCall = calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add',
    );
    expect(worktreeCall).toBeDefined();

    // Third arg is the worktree path — must be the absolute path (not relative)
    const worktreePath = worktreeCall!.args[2];
    expect(worktreePath).toBe(EXPECTED_WORKTREE_PATH);
    // Confirm it is absolute (starts with /)
    expect(worktreePath).toMatch(/^\//);
    // Confirm it ends with jinn-mono_worktrees/418
    expect(worktreePath).toMatch(/jinn-mono_worktrees\/418$/);

    // -b flag must be present
    const bFlagIdx = worktreeCall!.args.indexOf('-b');
    expect(bFlagIdx).toBeGreaterThan(-1);

    // Branch name starts with feat/418-
    const branchName = worktreeCall!.args[bFlagIdx + 1];
    expect(branchName).toMatch(/^feat\/418-/);

    // Final arg is origin/next
    expect(worktreeCall!.args[worktreeCall!.args.length - 1]).toBe('origin/next');
  });

  it('skips git worktree add when the worktree already exists (idempotent)', async () => {
    // Supply a worktree list that already contains jinn-mono_worktrees/418
    const { runner, calls } = makeRunner(WORKTREE_LIST_WITH_418);
    const { spawn } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    // git worktree list must have been called (to detect existing worktree)
    const listCall = calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'list',
    );
    expect(listCall).toBeDefined();

    // git worktree add must NOT have been called
    const addCall = calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add',
    );
    expect(addCall).toBeUndefined();

    // Spawn still happens (session still created)
    expect(spawn).toBeDefined();
  });

  it('sets the issue Project Status to In Progress BEFORE creating the worktree', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    // Find the indices of the Status item-edit call and the git worktree list call
    const itemEditIdx = calls.findIndex(
      (c) => c.cmd === 'gh' && c.args[0] === 'project' && c.args[1] === 'item-edit',
    );
    const worktreeListIdx = calls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'list',
    );

    // Both must be found
    expect(itemEditIdx).toBeGreaterThan(-1);
    expect(worktreeListIdx).toBeGreaterThan(-1);

    // Status set BEFORE worktree list/add
    expect(itemEditIdx).toBeLessThan(worktreeListIdx);

    // Also verify the correct option id is used
    const editCall = calls[itemEditIdx];
    expect(editCall.args).toContain('--single-select-option-id');
    const optIdx = editCall.args.indexOf('--single-select-option-id');
    expect(editCall.args[optIdx + 1]).toBe('opt_in_progress');
  });

  it('sets the issue Project Status to In Progress', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    // Must have called gh project item-edit with --single-select-option-id opt_in_progress
    const editCall = calls.find(
      (c) => c.cmd === 'gh' && c.args[0] === 'project' && c.args[1] === 'item-edit',
    );
    expect(editCall).toBeDefined();
    expect(editCall!.args).toContain('--single-select-option-id');
    const optIdx = editCall!.args.indexOf('--single-select-option-id');
    expect(editCall!.args[optIdx + 1]).toBe('opt_in_progress');
  });

  it('spawns with a prompt containing the headless-override block', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    expect(calls).toHaveLength(1);
    const [spawnCall] = calls;

    // The prompt is passed via -p / --print flag
    const pFlagIdx = spawnCall.args.indexOf('-p');
    expect(pFlagIdx).toBeGreaterThan(-1);
    const prompt = spawnCall.args[pFlagIdx + 1];

    // (b) headless-override block — check for a distinctive phrase from headless-override.md
    expect(prompt).toContain('non-interactive');
  });

  it('spawns with a prompt containing the CLAUDE.md canon', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    const [spawnCall] = calls;
    const pFlagIdx = spawnCall.args.indexOf('-p');
    const prompt = spawnCall.args[pFlagIdx + 1];

    // (a) CLAUDE.md canon — check for a distinctive phrase from CLAUDE.md
    expect(prompt).toContain('CLAUDE.md');
  });

  it('spawns with a prompt containing the handbook canon', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    const [spawnCall] = calls;
    const pFlagIdx = spawnCall.args.indexOf('-p');
    const prompt = spawnCall.args[pFlagIdx + 1];

    // (a) handbook — check for a distinctive phrase from the engineering handbook
    expect(prompt).toContain('handbook');
  });

  it('spawns with a prompt containing the implement-issue skill invocation on issue #418', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    const [spawnCall] = calls;
    const pFlagIdx = spawnCall.args.indexOf('-p');
    const prompt = spawnCall.args[pFlagIdx + 1];

    // (c) implement-issue + issue number
    expect(prompt).toContain('implement-issue');
    expect(prompt).toContain('#418');
  });

  it('spawns with a prompt telling the session the worktree is pre-created (C1 fix)', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    const [spawnCall] = calls;
    const pFlagIdx = spawnCall.args.indexOf('-p');
    const prompt = spawnCall.args[pFlagIdx + 1];

    // The dispatcher must tell the session not to create a new worktree, because
    // the worktree is pre-created before spawn. This prevents the double
    // `git worktree add` failure (C1).
    expect(prompt).toContain('already exists');
    expect(prompt).toContain('do not create a new worktree');
    // And must contain the absolute worktree path
    expect(prompt).toContain(EXPECTED_WORKTREE_PATH);
  });

  it('does NOT pass --mode plan or --permission-mode plan to the spawn', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn });

    const [spawnCall] = calls;
    const { args } = spawnCall;

    // Check that neither '--mode' nor '--permission-mode' is followed by 'plan'
    // (We must not find the posture flags; the prompt itself may mention "plan" as
    // part of skill names like "writing-plans", which is fine.)
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--mode' || args[i] === '--permission-mode') {
        expect(args[i + 1]).not.toBe('plan');
      }
    }
    // The flags themselves must not appear at all
    expect(args).not.toContain('--mode');
    expect(args).not.toContain('--permission-mode');
  });

  it('returns an InFlightSession with the correct issue number, branch, absolute worktree path, pid, and startedAt', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn(77777);

    const before = Date.now();
    const session = await dispatchIssue(ISSUE, CFG, { runner, spawn });
    const after = Date.now();

    expect(session.issueNumber).toBe(418);
    expect(session.branch).toMatch(/^feat\/418-/);
    // Worktree path must be the absolute path (reliability fix)
    expect(session.worktreePath).toBe(EXPECTED_WORKTREE_PATH);
    expect(session.worktreePath).toMatch(/^\//);
    expect(session.worktreePath).toMatch(/jinn-mono_worktrees\/418$/);
    expect(session.pid).toBe(77777);
    expect(session.startedAt).toBeGreaterThanOrEqual(before);
    expect(session.startedAt).toBeLessThanOrEqual(after);

    // The branch in the session must match the -b branch in the worktree-add call
    const worktreeCall = calls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add',
    );
    const bFlagIdx = worktreeCall!.args.indexOf('-b');
    expect(session.branch).toBe(worktreeCall!.args[bFlagIdx + 1]);
  });
});
