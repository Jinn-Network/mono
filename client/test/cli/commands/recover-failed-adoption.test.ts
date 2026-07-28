import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createRecoverFailedAdoptionCommand,
  runFailedAdoptionRecovery,
  type RecoverFailedAdoptionCommandDeps,
} from '../../../src/cli/commands/recover-failed-adoption.js';
import type { CommandContext } from '../../../src/cli/command.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { Store } from '../../../src/store/store.js';

const REQUEST_ID = `0x${'e5'.repeat(32)}`;

function commandContext(argv: string[]): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: {
        write(value: string) {
          writes.push(value);
          return true;
        },
      },
      exit(code: number) {
        exits.push(code);
      },
      env: {},
    },
    writes,
    exits,
  };
}

function deps(
  result: ReturnType<RecoverFailedAdoptionCommandDeps['runRecovery']> = {
    status: 'eligible',
    requestId: REQUEST_ID,
    previousState: TaskRunState.FAILED,
    targetState: TaskRunState.AWAITING_ADOPTION,
  },
): RecoverFailedAdoptionCommandDeps & {
  runRecovery: ReturnType<typeof vi.fn>;
} {
  return {
    loadConfig: vi.fn(() => ({
      dbPath: '/operator/jinn.db',
    }) as ReturnType<RecoverFailedAdoptionCommandDeps['loadConfig']>),
    getConfigPathFromArgs: vi.fn(() => undefined),
    runRecovery: vi.fn(() => result),
  };
}

function parsedOutput(writes: string[]): Record<string, unknown> {
  return JSON.parse(writes.join('').trim()) as Record<string, unknown>;
}

describe('recover-failed-adoption command', () => {
  it.each([
    ['missing request', ['--dry-run'], /request-id/i],
    ['malformed request', ['--request-id', '1197', '--dry-run'], /request-id/i],
    ['missing mode', ['--request-id', REQUEST_ID], /dry-run.*apply|apply.*dry-run/i],
    [
      'conflicting modes',
      ['--request-id', REQUEST_ID, '--dry-run', '--apply'],
      /dry-run.*apply|apply.*dry-run/i,
    ],
  ])('refuses %s without invoking recovery', async (_name, argv, message) => {
    const fake = deps();
    const command = createRecoverFailedAdoptionCommand(fake);
    const { ctx, writes, exits } = commandContext(argv);

    await command.run(ctx);

    expect(fake.runRecovery).not.toHaveBeenCalled();
    expect(exits).toHaveLength(1);
    expect(exits[0]).not.toBe(0);
    expect(parsedOutput(writes)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringMatching(message),
    });
  });

  it.each([
    ['dry-run', '--dry-run', 'eligible'],
    ['apply', '--apply', 'recovered'],
  ] as const)(
    'forwards the exact request in %s mode',
    async (mode, flag, status) => {
      const fake = deps({
        status,
        requestId: REQUEST_ID,
        previousState: TaskRunState.FAILED,
        targetState: TaskRunState.AWAITING_ADOPTION,
      });
      const command = createRecoverFailedAdoptionCommand(fake);
      const { ctx, writes, exits } = commandContext([
        '--request-id',
        REQUEST_ID,
        flag,
        '--json',
      ]);

      await command.run(ctx);

      expect(fake.runRecovery).toHaveBeenCalledWith({
        dbPath: '/operator/jinn.db',
        requestId: REQUEST_ID,
        mode,
      });
      expect(exits).toEqual([0]);
      expect(parsedOutput(writes)).toEqual({
        schemaVersion: 1,
        verb: 'recover-failed-adoption',
        mode,
        status,
        requestId: REQUEST_ID,
        previousState: TaskRunState.FAILED,
        targetState: TaskRunState.AWAITING_ADOPTION,
      });
    },
  );

  it('returns a bounded non-zero refusal without serializing durable payloads', async () => {
    const fake = deps({
      status: 'refused',
      requestId: REQUEST_ID,
      reason: 'persisted failure reason is not the recoverable identity contradiction',
    });
    const command = createRecoverFailedAdoptionCommand(fake);
    const { ctx, writes, exits } = commandContext([
      '--request-id',
      REQUEST_ID,
      '--dry-run',
      '--json',
    ]);

    await command.run(ctx);

    expect(exits).toHaveLength(1);
    expect(exits[0]).not.toBe(0);
    const output = parsedOutput(writes);
    expect(output).toEqual({
      schemaVersion: 1,
      verb: 'recover-failed-adoption',
      mode: 'dry-run',
      status: 'refused',
      requestId: REQUEST_ID,
      reason:
        'persisted failure reason is not the recoverable identity contradiction',
    });
    expect(JSON.stringify(output)).not.toMatch(
      /task_payload|solution_outputs|gh-token|mnemonic/i,
    );
  });

  it('renders a concise human dry-run result', async () => {
    const fake = deps();
    const command = createRecoverFailedAdoptionCommand(fake);
    const { ctx, writes, exits } = commandContext([
      '--request-id',
      REQUEST_ID,
      '--dry-run',
      '--human',
    ]);

    await command.run(ctx);

    expect(exits).toEqual([0]);
    expect(writes.join('')).toContain('eligible');
    expect(writes.join('')).toContain(REQUEST_ID);
    expect(writes.join('')).not.toContain('task_payload');
  });

  it('opens the production dry-run database read-only without backfills', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jinn-recovery-dry-run-'));
    const dbPath = join(tempDir, 'jinn.db');
    const legacyRequestId = `0x${'aa'.repeat(32)}`;
    try {
      const store = new Store(dbPath);
      try {
        store.db.prepare(`
          INSERT INTO task_runs (
            request_id,
            task_cid,
            onchain_creation_tx,
            onchain_creation_block,
            state,
            state_updated_at,
            window_start_ts,
            window_end_ts,
            task_payload,
            solver_net_manifest_cid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          legacyRequestId,
          'legacy-task-cid',
          `0x${'01'.repeat(32)}`,
          1,
          TaskRunState.FAILED,
          1,
          1,
          2,
          JSON.stringify({ solverNetManifestCid: 'must-not-be-backfilled' }),
        );
      } finally {
        store.close();
      }
      const before = readFileSync(dbPath);

      expect(runFailedAdoptionRecovery({
        dbPath,
        requestId: REQUEST_ID,
        mode: 'dry-run',
      })).toMatchObject({
        status: 'refused',
        requestId: REQUEST_ID,
        reason: expect.stringMatching(/not found/i),
      });

      expect(readFileSync(dbPath)).toEqual(before);
      const inspector = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(inspector.prepare(`
          SELECT solver_net_manifest_cid
          FROM task_runs
          WHERE request_id = ?
        `).get(legacyRequestId)).toEqual({
          solver_net_manifest_cid: null,
        });
      } finally {
        inspector.close();
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
