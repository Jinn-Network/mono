import { describe, expect, it, vi } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  runSessionCli,
  type SessionProtocol,
} from '../../src/cli/session.js';

const MANIFEST_PATH = '/attempt/manifest.json';
const MANIFEST: AttemptManifest = {
  version: 2,
  attemptId: '11111111-1111-4111-8111-111111111111',
  runnerId: 'host-123-11111111-1111-4111-8111-111111111111',
  host: 'host',
  phase: 'review',
  subject: 'pr-9',
  issueNumber: 8,
  prNumber: 9,
  branch: 'topic',
  targetBase: 'next',
  expectedHead: 'a'.repeat(40),
  claimOid: 'b'.repeat(40),
  reviewGeneration: '22222222-2222-4222-8222-222222222222',
  reviewRefOid: 'c'.repeat(40),
  selectedLogin: 'reviewer',
  repository: {
    root: '/repository',
    gitCommonDir: '/repository/.git',
    remoteName: 'origin',
    remoteUrlHash: 'd'.repeat(64),
  },
  processState: 'running',
  pid: 123,
  paths: {
    attemptDir: '/attempt',
    worktree: '/attempt/worktree',
    manifest: MANIFEST_PATH,
    log: '/attempt/session.log',
    ghConfigDir: '/attempt/gh-config',
    askpass: '/attempt/askpass',
  },
  timestamps: {
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    childStartedAt: '2026-07-20T00:00:00.000Z',
  },
};

function protocol(): SessionProtocol & {
  calls: Array<{ operation: string; payload?: unknown }>;
} {
  const calls: Array<{ operation: string; payload?: unknown }> = [];
  return {
    calls,
    checkpoint: async () => { calls.push({ operation: 'checkpoint' }); },
    implementationComplete: async (_manifest, summary) => {
      calls.push({ operation: 'implementation-complete', payload: summary });
    },
    reviewVerdict: async (_manifest, state, body) => {
      calls.push({ operation: 'review-verdict', payload: { state, body } });
    },
    reviewFixPublish: async () => { calls.push({ operation: 'review-fix-publish' }); },
    mergePrepComplete: async (_manifest, summary) => {
      calls.push({ operation: 'merge-prep-complete', payload: summary });
    },
    human: async (_manifest, reason) => {
      calls.push({ operation: 'human', payload: reason });
    },
  };
}

function deps(
  manifest: AttemptManifest,
  handler: SessionProtocol = protocol(),
) {
  const readManifest = vi.fn(() => manifest);
  return {
    protocol: handler,
    env: { JINN_AUTOPILOT_SESSION_MANIFEST: MANIFEST_PATH },
    readManifest,
    readTextFile: vi.fn((path: string) => {
      if (path === '/summary') return 'summary text\n';
      if (path === '/body') return 'review body\n';
      if (path === '/reason') return 'human reason\n';
      throw new Error('unexpected file');
    }),
  };
}

describe('session CLI grammar', () => {
  it.each([
    {
      argv: ['checkpoint'],
      manifest: MANIFEST,
      expected: { operation: 'checkpoint' },
    },
    {
      argv: ['implementation-complete', '--summary-file', '/summary'],
      manifest: { ...MANIFEST, phase: 'implement' as const, subject: 'issue-8', prNumber: undefined, reviewGeneration: undefined, reviewRefOid: undefined },
      expected: { operation: 'implementation-complete', payload: 'summary text\n' },
    },
    {
      argv: ['review-verdict', '--state', 'APPROVE', '--body-file', '/body'],
      manifest: MANIFEST,
      expected: { operation: 'review-verdict', payload: { state: 'APPROVE', body: 'review body\n' } },
    },
    {
      argv: ['review-verdict', '--state', 'REQUEST_CHANGES', '--body-file', '/body'],
      manifest: MANIFEST,
      expected: { operation: 'review-verdict', payload: { state: 'REQUEST_CHANGES', body: 'review body\n' } },
    },
    {
      argv: ['review-fix-publish'],
      manifest: MANIFEST,
      expected: { operation: 'review-fix-publish' },
    },
    {
      argv: ['merge-prep-complete', '--summary-file', '/summary'],
      manifest: { ...MANIFEST, phase: 'merge-prep' as const, reviewGeneration: undefined, reviewRefOid: undefined },
      expected: { operation: 'merge-prep-complete', payload: 'summary text\n' },
    },
    {
      argv: ['human', '--reason-file', '/reason'],
      manifest: MANIFEST,
      expected: { operation: 'human', payload: 'human reason\n' },
    },
  ])('parses and delegates $argv.0 after manifest validation', async ({
    argv,
    manifest,
    expected,
  }) => {
    const handler = protocol();
    const injected = deps(manifest, handler);

    await runSessionCli(argv, injected);

    expect(injected.readManifest).toHaveBeenCalledTimes(1);
    expect(injected.readManifest).toHaveBeenCalledWith(MANIFEST_PATH);
    expect(handler.calls).toEqual([expected]);
  });

  it.each([
    { argv: [] },
    { argv: ['unknown'] },
    { argv: ['checkpoint', 'trailing'] },
    { argv: ['implementation-complete'] },
    { argv: ['implementation-complete', '--summary-file'] },
    { argv: ['implementation-complete', '--wrong', '/summary'] },
    { argv: ['review-verdict', '--state', 'COMMENT', '--body-file', '/body'] },
    { argv: ['review-verdict', '--state', 'APPROVE'] },
    { argv: ['review-verdict', '--body-file', '/body', '--state', 'APPROVE'] },
    { argv: ['review-fix-publish', '--extra'] },
    { argv: ['merge-prep-complete', '--summary-file', '/summary', 'trailing'] },
    { argv: ['human', '--reason-file', '/reason', '--extra'] },
  ])('rejects unknown, trailing, missing, or malformed input: $argv', async ({ argv }) => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);

    await expect(runSessionCli(argv, injected)).rejects.toThrow(/usage|unknown|invalid|requires/i);
    expect(handler.calls).toEqual([]);
    expect(injected.readManifest).not.toHaveBeenCalled();
  });

  it('requires the manifest environment variable', async () => {
    const handler = protocol();
    const injected = {
      ...deps(MANIFEST, handler),
      env: {},
    };
    await expect(runSessionCli(['checkpoint'], injected)).rejects.toThrow(
      /JINN_AUTOPILOT_SESSION_MANIFEST/,
    );
    expect(handler.calls).toEqual([]);
  });

  it('rejects a command that does not match the manifest phase', async () => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);
    await expect(runSessionCli([
      'implementation-complete', '--summary-file', '/summary',
    ], injected)).rejects.toThrow(/not valid for review/);
    expect(handler.calls).toEqual([]);
  });

  it('re-reads and strictly validates the manifest before delegation', async () => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);
    injected.readManifest.mockImplementation(() => {
      throw new Error('Unknown field: token');
    });
    await expect(runSessionCli(['checkpoint'], injected)).rejects.toThrow(/Unknown field: token/);
    expect(handler.calls).toEqual([]);
  });
});

describe('production session protocol', () => {
  it('fails closed with operation not wired after validating the manifest', async () => {
    const injected = deps(MANIFEST);
    await expect(runSessionCli(['checkpoint'], {
      env: injected.env,
      readManifest: injected.readManifest,
      readTextFile: injected.readTextFile,
    })).rejects.toThrow(/operation not wired/i);
    expect(injected.readManifest).toHaveBeenCalledTimes(1);
  });
});
