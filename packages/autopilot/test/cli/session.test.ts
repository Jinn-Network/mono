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
    reviewVerdict: async (_manifest, state, body) => {
      calls.push({ operation: 'review-verdict', payload: { state, body } });
      return state === 'APPROVE'
        ? { status: 'approved', head: SUCCESS_HEAD }
        : { status: 'fixing', head: SUCCESS_HEAD };
    },
    reviewFixPublish: async () => {
      calls.push({ operation: 'review-fix-publish' });
      return {
        status: 'published',
        head: SUCCESS_HEAD,
        reviewRefOid: REVIEW_REF,
      };
    },
    mergePrepComplete: async (_manifest, summary) => {
      calls.push({ operation: 'merge-prep-complete', payload: summary });
      return { status: 'complete', head: SUCCESS_HEAD };
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
      argv: ['review-verdict', '--state', 'REQUEST_CHANGES', '--body-file', BODY_PATH],
      manifest: MANIFEST,
      expected: { operation: 'review-verdict', payload: { state: 'REQUEST_CHANGES', body: 'review body\n' } },
    },
    {
      argv: ['review-fix-publish'],
      manifest: MANIFEST,
      expected: { operation: 'review-fix-publish' },
    },
    {
      argv: ['merge-prep-complete', '--summary-file', SUMMARY_PATH],
      manifest: { ...MANIFEST, phase: 'merge-prep' as const, targetBaseOid: 'e'.repeat(40), reviewGeneration: undefined, reviewRefOid: undefined, reviewApprovalPolicy: undefined },
      expected: { operation: 'merge-prep-complete', payload: 'summary text\n' },
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
    { argv: ['review-verdict', '--body-file', BODY_PATH, '--state', 'APPROVE'] },
    { argv: ['review-fix-publish', '--extra'] },
    { argv: ['merge-prep-complete', '--summary-file', SUMMARY_PATH, 'trailing'] },
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

  it.each([
    {
      name: 'stale checkpoint',
      argv: ['checkpoint'],
      manifest: {
        ...MANIFEST,
        phase: 'implement' as const,
        subject: 'issue-8',
        prNumber: 9,
        reviewGeneration: undefined,
        reviewRefOid: undefined,
        reviewApprovalPolicy: undefined,
      },
      method: 'checkpoint' as const,
      outcome: { status: 'stale' as const, head: NONTERMINAL_HEAD },
    },
    {
      name: 'partial implementation completion',
      argv: ['implementation-complete', '--summary-file', SUMMARY_PATH],
      manifest: {
        ...MANIFEST,
        phase: 'implement' as const,
        subject: 'issue-8',
        prNumber: 9,
        reviewGeneration: undefined,
        reviewRefOid: undefined,
        reviewApprovalPolicy: undefined,
      },
      method: 'implementationComplete' as const,
      outcome: {
        status: 'partial' as const,
        head: NONTERMINAL_HEAD,
        pending: 'ready' as const,
      },
    },
    {
      name: 'ambiguous review verdict',
      argv: ['review-verdict', '--state', 'APPROVE', '--body-file', BODY_PATH],
      manifest: MANIFEST,
      method: 'reviewVerdict' as const,
      outcome: { status: 'ambiguous' as const, head: NONTERMINAL_HEAD },
    },
    {
      name: 'stale review fix publication',
      argv: ['review-fix-publish'],
      manifest: MANIFEST,
      method: 'reviewFixPublish' as const,
      outcome: { status: 'stale' as const, head: NONTERMINAL_HEAD },
    },
    {
      name: 'partial merge preparation',
      argv: ['merge-prep-complete', '--summary-file', SUMMARY_PATH],
      manifest: {
        ...MANIFEST,
        phase: 'merge-prep' as const,
        targetBaseOid: 'e'.repeat(40),
        reviewGeneration: undefined,
        reviewRefOid: undefined,
        reviewApprovalPolicy: undefined,
      },
      method: 'mergePrepComplete' as const,
      outcome: {
        status: 'partial' as const,
        head: NONTERMINAL_HEAD,
        pending: 'publication' as const,
      },
    },
  ])('emits $name and exits nonzero', async ({
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

describe('production session protocol', () => {
  it('delegates implementation, review, and merge-prep handlers', async () => {
    const implementation = protocol();
    const review = protocol();
    const mergePrep = protocol();
    const production = makeProductionSessionProtocol(
      {},
      () => implementation,
      () => review,
      () => mergePrep,
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
    const mergeManifest = {
      ...MANIFEST,
      phase: 'merge-prep' as const,
      targetBaseOid: 'e'.repeat(40),
      reviewGeneration: undefined,
      reviewRefOid: undefined,
      reviewApprovalPolicy: undefined,
    };
    await production.mergePrepComplete(mergeManifest, 'summary');
    await production.human(mergeManifest, 'merge reason');
    expect(mergePrep.calls).toEqual([
      { operation: 'merge-prep-complete', payload: 'summary' },
      { operation: 'human', payload: 'merge reason' },
    ]);
  });

  it('regression (#1883): an implement-phase operation succeeds with a reviewer login configured but no reviewer token, and never constructs the review or merge-prep session ports', async () => {
    const implementation = protocol();
    const production = makeProductionSessionProtocol(
      // Realistic misconfiguration-shaped env: a reviewer login is
      // configured (JINN_REVIEW_BOT_LOGIN) but its token is not (as it would
      // be if a coordinator runtime scrubbed the secret-shaped
      // JINN_REVIEW_GH_TOKEN while leaving the non-secret-shaped login
      // through). An implement-phase operation must not demand it — only
      // the credential the operation's own phase actually needs.
      { JINN_REVIEW_BOT_LOGIN: 'review-bot', GH_TOKEN: 'impl-secret' },
      () => implementation,
      () => { throw new Error('review session port must not be constructed for an implement-phase operation'); },
      () => { throw new Error('merge-prep session port must not be constructed for an implement-phase operation'); },
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

    await expect(production.checkpoint(implementationManifest)).resolves.toEqual({
      status: 'published',
      head: SUCCESS_HEAD,
    });
    expect(implementation.calls).toEqual([{ operation: 'checkpoint' }]);
  });

  it('regression: publishes a review verdict with no JINN_REVIEW_* env vars, resolving the reviewer credential from the attempt token file', async () => {
    // Live-bug shape: a v2 review session's verdict-publication step must
    // never run the dispatcher's arming assertion (identity.ts
    // assertReviewIdentities / credentials.ts resolveCredentialPool's
    // reviewBotLogin<->reviewGhToken pairing check) — those gate the
    // DISPATCHER'S OWN boot for `--mode active/recover/observe`, not a
    // session. A session is identified by argv routing to `session` (see
    // shouldRouteToSession in scripts/run-autopilot-v2.ts, which hands off to
    // this CLI BEFORE any dispatcher-config parsing) and carries only
    // JINN_AUTOPILOT_SESSION_MANIFEST plus whatever non-secret-shaped env
    // survived the coordinator runtime's scrub — here, JINN_REVIEW_BOT_LOGIN
    // (not secret-shaped) survives while JINN_REVIEW_GH_TOKEN (secret-shaped)
    // does not, exactly mirroring the Hermes runtime's env scrub. This drives
    // a review-verdict operation through the real CLI argv routing and lazy
    // phase-scoped protocol construction with that exact environment and
    // asserts it resolves cleanly, never touching the implementation or
    // merge-prep ports.
    const review = protocol();
    const env = {
      JINN_AUTOPILOT_SESSION_MANIFEST: MANIFEST_PATH,
      JINN_REVIEW_BOT_LOGIN: 'review-bot',
    };
    const production = makeProductionSessionProtocol(
      env,
      () => { throw new Error('implementation session port must not be constructed for a review-phase operation'); },
      () => review,
      () => { throw new Error('merge-prep session port must not be constructed for a review-phase operation'); },
    );
    const injected = { ...deps(MANIFEST, production), env };

    const execution = await runSessionCli(
      ['review-verdict', '--state', 'APPROVE', '--body-file', BODY_PATH],
      injected,
    );

    expect(execution.exitCode).toBe(0);
    expect(review.calls).toEqual([
      { operation: 'review-verdict', payload: { state: 'APPROVE', body: 'review body\n' } },
    ]);
  });
});
