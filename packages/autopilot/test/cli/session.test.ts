import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeProductionSessionProtocol,
  readBoundedUtf8File,
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
  reviewApprovalPolicy: 'approve-eligible',
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
    readTextFile: vi.fn((path: string): string => {
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
      manifest: { ...MANIFEST, phase: 'implement' as const, subject: 'issue-8', prNumber: 9, reviewGeneration: undefined, reviewRefOid: undefined, reviewApprovalPolicy: undefined },
      expected: { operation: 'checkpoint' },
    },
    {
      argv: ['implementation-complete', '--summary-file', '/summary'],
      manifest: { ...MANIFEST, phase: 'implement' as const, subject: 'issue-8', prNumber: undefined, reviewGeneration: undefined, reviewRefOid: undefined, reviewApprovalPolicy: undefined },
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
      manifest: { ...MANIFEST, phase: 'merge-prep' as const, reviewGeneration: undefined, reviewRefOid: undefined, reviewApprovalPolicy: undefined },
      expected: { operation: 'merge-prep-complete', payload: 'summary text\n' },
    },
    {
      argv: ['human', '--reason-file', '/reason'],
      manifest: { ...MANIFEST, phase: 'implement' as const, subject: 'issue-8', prNumber: 9, reviewGeneration: undefined, reviewRefOid: undefined, reviewApprovalPolicy: undefined },
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

  it('wires Human holds for review manifests', async () => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);
    await runSessionCli(['human', '--reason-file', '/reason'], injected);
    expect(handler.calls).toEqual([
      { operation: 'human', payload: 'human reason\n' },
    ]);
  });

  it('wires checkpoints only for implementation manifests in this task', async () => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);
    await expect(runSessionCli(['checkpoint'], injected))
      .rejects.toThrow(/not valid for review/);
    expect(handler.calls).toEqual([]);
  });

  it('rejects unbounded injected summary and reason text before delegation', async () => {
    const implementation = {
      ...MANIFEST,
      phase: 'implement' as const,
      subject: 'issue-8',
      prNumber: 9,
      reviewGeneration: undefined,
      reviewRefOid: undefined,
      reviewApprovalPolicy: undefined,
    };
    for (const argv of [
      ['implementation-complete', '--summary-file', '/summary'],
      ['human', '--reason-file', '/reason'],
    ]) {
      const handler = protocol();
      const injected = deps(implementation, handler);
      injected.readTextFile.mockReturnValue('x'.repeat(65_537));
      await expect(runSessionCli(argv, injected)).rejects.toThrow(/65,536 bytes/i);
      expect(handler.calls).toEqual([]);
    }
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

describe('bounded UTF-8 session input', () => {
  it('rejects malformed UTF-8 and files larger than 65,536 bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-session-input-'));
    const malformed = join(dir, 'malformed');
    const oversized = join(dir, 'oversized');
    writeFileSync(malformed, Buffer.from([0xc3, 0x28]));
    writeFileSync(oversized, Buffer.alloc(65_537, 0x61));

    expect(() => readBoundedUtf8File(malformed)).toThrow(/UTF-8/i);
    expect(() => readBoundedUtf8File(oversized)).toThrow(/65,536 bytes/i);
  });
});

describe('production session protocol', () => {
  it('delegates implementation and review handlers while keeping later phases unwired', async () => {
    const implementation = protocol();
    const review = protocol();
    const production = makeProductionSessionProtocol(
      {},
      () => implementation,
      () => review,
    );
    const implementationManifest = {
      ...MANIFEST,
      phase: 'implement' as const,
      subject: 'issue-8',
      prNumber: 9,
      reviewGeneration: undefined,
      reviewRefOid: undefined,
      reviewApprovalPolicy: undefined,
    };

    await production.checkpoint(implementationManifest);
    await production.implementationComplete(implementationManifest, 'summary');
    await production.human(implementationManifest, 'reason');
    expect(implementation.calls).toEqual([
      { operation: 'checkpoint' },
      { operation: 'implementation-complete', payload: 'summary' },
      { operation: 'human', payload: 'reason' },
    ]);
    await production.reviewVerdict(MANIFEST, 'APPROVE', 'body');
    await production.reviewFixPublish(MANIFEST);
    await production.human(MANIFEST, 'review reason');
    expect(review.calls).toEqual([
      { operation: 'review-verdict', payload: { state: 'APPROVE', body: 'body' } },
      { operation: 'review-fix-publish' },
      { operation: 'human', payload: 'review reason' },
    ]);
    await expect(production.mergePrepComplete(MANIFEST, 'summary'))
      .rejects.toThrow(/operation not wired/i);
  });

});
