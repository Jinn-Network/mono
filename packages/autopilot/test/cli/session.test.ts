// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { gitOid } from '../../src/lifecycle/types.js';
import {
  makeProductionSessionProtocol,
  readBoundedUtf8File,
  runSessionCli,
  type SessionProtocol,
} from '../../src/cli/session.js';

const MANIFEST_PATH = '/attempt/manifest.json';
const SUMMARY_PATH = '/attempt/reports/summary.md';
const BODY_PATH = '/attempt/reports/body.md';
const REASON_PATH = '/attempt/reports/reason.md';
const FOLLOW_UPS_PATH = '/attempt/reports/review-follow-ups.json';
const FOLLOW_UPS_JSON = JSON.stringify({
  followUps: [{
    type: 'chore',
    title: 'Rename helper',
    body: 'Non-blocking',
    effort: 'low',
    priority: 'p3',
  }],
});
const FOLLOW_UPS_PARSED = [{
  type: 'chore',
  title: 'Rename helper',
  body: 'Non-blocking',
  effort: 'low',
  priority: 'p3',
}];
const SUCCESS_HEAD = gitOid('a'.repeat(40));
const NONTERMINAL_HEAD = gitOid('d'.repeat(40));
const REVIEW_REF = gitOid('c'.repeat(40));
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
    tokenFile: '/attempt/gh-token',
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
    checkpoint: async () => {
      calls.push({ operation: 'checkpoint' });
      return { status: 'published', head: SUCCESS_HEAD };
    },
    implementationComplete: async (_manifest, summary) => {
      calls.push({ operation: 'implementation-complete', payload: summary });
      return { status: 'complete', head: SUCCESS_HEAD };
    },
    reviewVerdict: async (_manifest, state, body, followUps) => {
      calls.push({
        operation: 'review-verdict',
        payload: followUps === undefined
          ? { state, body }
          : { state, body, followUps },
      });
      return state === 'APPROVE'
        ? { status: 'approved', head: SUCCESS_HEAD }
        : { status: 'requested-changes', head: SUCCESS_HEAD };
    },
    reviewFindings: async (_manifest, findings) => {
      calls.push({ operation: 'review-findings', payload: findings });
      return {
        status: 'filed',
        head: SUCCESS_HEAD,
        childNumber: 9001,
        created: true,
      };
    },
    human: async (_manifest, reason) => {
      calls.push({ operation: 'human', payload: reason });
      return { status: 'human', head: SUCCESS_HEAD };
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
    validateReportFile: (_reportsDirectory: string, candidate: string) =>
      candidate,
    writeOutput: vi.fn(),
    setExitCode: vi.fn(),
    readTextFile: vi.fn((path: string): string => {
      if (path === SUMMARY_PATH) return 'summary text\n';
      if (path === BODY_PATH) return 'review body\n';
      if (path === REASON_PATH) return 'human reason\n';
      if (path === FOLLOW_UPS_PATH) return FOLLOW_UPS_JSON;
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
      argv: ['implementation-complete', '--summary-file', SUMMARY_PATH],
      manifest: { ...MANIFEST, phase: 'implement' as const, subject: 'issue-8', prNumber: undefined, reviewGeneration: undefined, reviewRefOid: undefined, reviewApprovalPolicy: undefined },
      expected: { operation: 'implementation-complete', payload: 'summary text\n' },
    },
    {
      argv: ['review-verdict', '--state', 'APPROVE', '--body-file', BODY_PATH],
      manifest: MANIFEST,
      expected: { operation: 'review-verdict', payload: { state: 'APPROVE', body: 'review body\n' } },
    },
    {
      argv: [
        'review-verdict', '--state', 'APPROVE',
        '--body-file', BODY_PATH,
        '--follow-ups-file', FOLLOW_UPS_PATH,
      ],
      manifest: MANIFEST,
      expected: {
        operation: 'review-verdict',
        payload: {
          state: 'APPROVE',
          body: 'review body\n',
          followUps: FOLLOW_UPS_PARSED,
        },
      },
    },
    {
      argv: [
        'review-verdict',
        '--body-file', BODY_PATH,
        '--follow-ups-file', FOLLOW_UPS_PATH,
        '--state', 'APPROVE',
      ],
      manifest: MANIFEST,
      expected: {
        operation: 'review-verdict',
        payload: {
          state: 'APPROVE',
          body: 'review body\n',
          followUps: FOLLOW_UPS_PARSED,
        },
      },
    },
    {
      argv: ['review-verdict', '--state', 'REQUEST_CHANGES', '--body-file', BODY_PATH],
      manifest: MANIFEST,
      expected: { operation: 'review-verdict', payload: { state: 'REQUEST_CHANGES', body: 'review body\n' } },
    },
    {
      argv: ['review-findings', '--file', BODY_PATH],
      manifest: MANIFEST,
      expected: { operation: 'review-findings', payload: 'review body\n' },
    },
    {
      argv: ['human', '--reason-file', REASON_PATH],
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
    { argv: ['implementation-complete', '--wrong', SUMMARY_PATH] },
    { argv: ['review-verdict', '--state', 'COMMENT', '--body-file', BODY_PATH] },
    { argv: ['review-verdict', '--state', 'APPROVE'] },
    { argv: ['review-verdict', '--follow-ups-file', FOLLOW_UPS_PATH] },
    {
      argv: [
        'review-verdict', '--state', 'REQUEST_CHANGES',
        '--body-file', BODY_PATH,
        '--follow-ups-file', FOLLOW_UPS_PATH,
      ],
    },
    {
      argv: [
        'review-verdict', '--state', 'APPROVE',
        '--body-file', BODY_PATH,
        '--follow-ups-file',
      ],
    },
    {
      argv: [
        'review-verdict', '--state', 'APPROVE',
        '--body-file', BODY_PATH,
        '--unknown-flag', 'x',
      ],
    },
    { argv: ['human', '--reason-file', REASON_PATH, '--extra'] },
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
      'implementation-complete', '--summary-file', SUMMARY_PATH,
    ], injected)).rejects.toThrow(/not valid for review/);
    expect(handler.calls).toEqual([]);
  });

  it('wires Human holds for review manifests', async () => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);
    await runSessionCli(['human', '--reason-file', REASON_PATH], injected);
    expect(handler.calls).toEqual([
      { operation: 'human', payload: 'human reason\n' },
    ]);
  });

  it('accepts an empty follow-ups array on APPROVE', async () => {
    const emptyPath = '/attempt/reports/empty-follow-ups.json';
    const handler = protocol();
    const injected = {
      ...deps(MANIFEST, handler),
      readTextFile: vi.fn((path: string): string => {
        if (path === BODY_PATH) return 'review body\n';
        if (path === emptyPath) return '{"followUps":[]}';
        throw new Error('unexpected file');
      }),
    };
    await runSessionCli([
      'review-verdict', '--state', 'APPROVE',
      '--body-file', BODY_PATH,
      '--follow-ups-file', emptyPath,
    ], injected);
    expect(handler.calls).toEqual([{
      operation: 'review-verdict',
      payload: {
        state: 'APPROVE',
        body: 'review body\n',
        followUps: [],
      },
    }]);
  });

  it('rejects a malformed follow-ups file payload', async () => {
    const badPath = '/attempt/reports/bad-follow-ups.json';
    const handler = protocol();
    const injected = {
      ...deps(MANIFEST, handler),
      readTextFile: vi.fn((path: string): string => {
        if (path === BODY_PATH) return 'review body\n';
        if (path === badPath) {
          return JSON.stringify({
            followUps: Array.from({ length: 6 }, (_, i) => ({
              type: 'fix',
              title: `Item ${i}`,
              body: 'x',
              effort: 'low',
              priority: 'p2',
            })),
          });
        }
        throw new Error('unexpected file');
      }),
    };
    await expect(runSessionCli([
      'review-verdict', '--state', 'APPROVE',
      '--body-file', BODY_PATH,
      '--follow-ups-file', badPath,
    ], injected)).rejects.toThrow(/at most 5/i);
    expect(handler.calls).toEqual([]);
  });

  it('wires checkpoints only for implementation manifests in this task', async () => {
    const handler = protocol();
    const injected = deps(MANIFEST, handler);
    await expect(runSessionCli(['checkpoint'], injected))
      .rejects.toThrow(/not valid for review/);
    expect(handler.calls).toEqual([]);
  });

  it.each([
    'relative-summary.md',
    '/attempt/worktree/summary.md',
    '/attempt/reports',
    '/attempt/reports/../manifest.json',
  ])('rejects session payload outside the attempt reports directory: %s', async (path) => {
    const handler = protocol();
    const implementation = {
      ...MANIFEST,
      phase: 'implement' as const,
      subject: 'issue-8',
      prNumber: 9,
      reviewGeneration: undefined,
      reviewRefOid: undefined,
      reviewApprovalPolicy: undefined,
    };
    const injected = deps(implementation, handler);

    await expect(runSessionCli([
      'implementation-complete', '--summary-file', path,
    ], injected)).rejects.toThrow(/attempt reports directory/i);
    expect(handler.calls).toEqual([]);
    expect(injected.readTextFile).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'directory'])(
    'rejects a %s payload even when its lexical path is report-scoped',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'jinn-session-report-'));
      const reports = join(root, 'reports');
      const payload = join(reports, 'payload.md');
      mkdirSync(reports);
      if (kind === 'symlink') {
        const outside = join(root, 'outside.md');
        writeFileSync(outside, 'outside');
        symlinkSync(outside, payload);
      } else {
        mkdirSync(payload);
      }
      const manifest: AttemptManifest = {
        ...MANIFEST,
        phase: 'implement',
        subject: 'issue-8',
        reviewGeneration: undefined,
        reviewRefOid: undefined,
        reviewApprovalPolicy: undefined,
        paths: {
          ...MANIFEST.paths,
          manifest: join(root, 'manifest.json'),
          worktree: join(root, 'worktree'),
        },
      };
      const injected = deps(manifest);
      delete (injected as Partial<typeof injected>).validateReportFile;
      injected.env.JINN_AUTOPILOT_SESSION_MANIFEST = manifest.paths.manifest;

      await expect(runSessionCli([
        'implementation-complete',
        '--summary-file',
        payload,
      ], injected)).rejects.toThrow(/regular non-symbolic file/i);
      expect(injected.readTextFile).not.toHaveBeenCalled();
    },
  );

  it('emits a structured successful outcome and leaves the exit code clear', async () => {
    const handler = protocol();
    const implementation = {
      ...MANIFEST,
      phase: 'implement' as const,
      subject: 'issue-8',
      prNumber: 9,
      reviewGeneration: undefined,
      reviewRefOid: undefined,
      reviewApprovalPolicy: undefined,
    };
    const injected = deps(implementation, handler);

    const result = await runSessionCli(['checkpoint'], injected);

    expect(result).toEqual({
      operation: 'checkpoint',
      outcome: { status: 'published', head: SUCCESS_HEAD },
      exitCode: 0,
    });
    expect(injected.writeOutput).toHaveBeenCalledWith(
      `${JSON.stringify(result)}\n`,
    );
    expect(injected.setExitCode).not.toHaveBeenCalled();
  });

('emits $name and exits nonzero', async ({
    argv,
    manifest,
    method,
    outcome,
  }) => {
    const handler = protocol();
    handler[method] = vi.fn(async () => outcome) as never;
    const injected = deps(manifest, handler);

    const result = await runSessionCli(argv, injected);

    expect(result).toEqual({
      operation: argv[0],
      outcome,
      exitCode: 2,
    });
    expect(injected.writeOutput).toHaveBeenCalledWith(
      `${JSON.stringify(result)}\n`,
    );
    expect(injected.setExitCode).toHaveBeenCalledWith(2);
  });

  it('surfaces a partial implementation-complete result\'s detail in the CLI output (#1883)', async () => {
    // `ensureCompletionProjection`'s catch blocks used to swallow the
    // thrown error entirely, leaving `autopilot session
    // implementation-complete` reporting only that something is pending,
    // never why. `detail` must flow through the CLI's JSON output
    // unchanged.
    const manifest = {
      ...MANIFEST,
      phase: 'implement' as const,
      subject: 'issue-8',
      prNumber: 9,
      reviewGeneration: undefined,
      reviewRefOid: undefined,
      reviewApprovalPolicy: undefined,
    };
    const handler = protocol();
    const detail =
      'Pull request record has not caught up with the published head after 3 attempts';
    handler.implementationComplete = vi.fn(async () => ({
      status: 'partial' as const,
      head: NONTERMINAL_HEAD,
      pending: 'project' as const,
      detail,
    }));
    const injected = deps(manifest, handler);

    const result = await runSessionCli(
      ['implementation-complete', '--summary-file', SUMMARY_PATH],
      injected,
    );

    expect(result.outcome).toMatchObject({ detail });
    expect(injected.writeOutput).toHaveBeenCalledWith(
      `${JSON.stringify(result)}\n`,
    );
    const written = (injected.writeOutput as ReturnType<typeof vi.fn>).mock.calls
      .at(-1)?.[0] as string;
    expect(JSON.parse(written).outcome.detail).toBe(detail);
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
      ['implementation-complete', '--summary-file', SUMMARY_PATH],
      ['human', '--reason-file', REASON_PATH],
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

