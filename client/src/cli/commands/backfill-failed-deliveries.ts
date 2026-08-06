/**
 * `jinn backfill-failed-deliveries` — reclassify FAILED task_runs as
 * COMPLETE when their on-chain delivery transaction actually succeeded
 * (#506).
 *
 * Background: `insertArtifact()` used to throw on databases still carrying
 * the legacy `artifacts.desired_state_id NOT NULL` column (fixed in #511,
 * commit 65de316e8). The engine's error-classification catch turned that
 * throw into a FAILED run even though the on-chain delivery had already
 * landed. This command scans historical FAILED rows whose `failureReason`
 * carries the `artifacts.desired_state_id` constraint signature, checks
 * each candidate's recorded `deliveryTxHash` receipt as secondary
 * confirmation, and reclassifies the ones whose delivery succeeded.
 * `deliveryTxHash` + a successful receipt alone is NOT sufficient grounds —
 * see the scoping note in the harness module below. No wallet/password is
 * required — this only reads chain state and writes to the local SQLite DB.
 *
 * Caveat: reclassified rows have no `artifacts` row and no ERC-8004
 * metadata anchor (that write is exactly what failed) — this command does
 * not reconstruct either, it only corrects `task_runs.state`.
 *
 * See `client/src/harnesses/engine/backfill-failed-deliveries.ts` and
 * `client/src/store/task-run-persistence.ts#reclassifyFailedAsComplete`.
 */

import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { Store } from '../../store/store.js';
import { TaskRunPersistence } from '../../store/task-run-persistence.js';
import {
  backfillFailedDeliveries as defaultBackfillFailedDeliveries,
  type BackfillFailedDeliveriesResult,
} from '../../harnesses/engine/backfill-failed-deliveries.js';
import { createJinnPublicClient, type JinnOnchainNetwork } from '../../earning/viem-clients.js';

function envelopeDebug(env: NodeJS.ProcessEnv): boolean {
  return env['JINN_DEBUG'] === '1';
}

function humanResult(payload: BackfillFailedDeliveriesResult & { dryRun: boolean }): string {
  const lines: string[] = [
    payload.dryRun ? 'Failed-delivery backfill (dry run) complete.' : 'Failed-delivery backfill complete.',
  ];
  lines.push(`  reclassified: ${payload.reclassified.length}`);
  for (const r of payload.reclassified) {
    lines.push(`    ${r.requestId} — was: ${r.originalFailureReason ?? '(no failure reason recorded)'}`);
  }
  lines.push(`  skipped:      ${payload.skipped.length}`);
  for (const s of payload.skipped) {
    lines.push(`    ${s.requestId} — ${s.reason}`);
  }
  lines.push(`  failed:       ${payload.failed.length}`);
  for (const f of payload.failed) {
    lines.push(`    ${f.requestId} — ${f.error}`);
  }
  return lines.join('\n');
}

export interface RunBackfillFailedDeliveriesArgs {
  dbPath: string;
  rpcUrls: readonly string[];
  network: JinnOnchainNetwork;
  dryRun: boolean;
}

async function defaultRunBackfill(
  args: RunBackfillFailedDeliveriesArgs,
): Promise<BackfillFailedDeliveriesResult> {
  const store = new Store(args.dbPath);
  try {
    const persistence = new TaskRunPersistence(store.db);
    const publicClient = createJinnPublicClient(args.rpcUrls, args.network);
    return await defaultBackfillFailedDeliveries({ persistence, publicClient, dryRun: args.dryRun });
  } finally {
    store.close();
  }
}

export interface BackfillFailedDeliveriesCommandDeps extends BaseCommandDeps {
  runBackfill: typeof defaultRunBackfill;
}

const PRODUCTION_DEPS: BackfillFailedDeliveriesCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  runBackfill: defaultRunBackfill,
};

export function createBackfillFailedDeliveriesCommand(
  deps: BackfillFailedDeliveriesCommandDeps = PRODUCTION_DEPS,
): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    let json = false;
    let human = false;
    let configPath: string | undefined;
    let dryRun = false;

    try {
      const parsed = parseCommandArgs(ctx.argv, {
        ...COMMON_FLAGS,
        'dry-run': { type: 'boolean' as const, default: false },
      });
      json = Boolean(parsed.values.json);
      human = Boolean(parsed.values.human);
      dryRun = Boolean(parsed.values['dry-run']);
      configPath =
        typeof parsed.values.config === 'string' && parsed.values.config.length > 0
          ? parsed.values.config
          : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: 'Invalid command-line arguments.',
          hint: 'Run `jinn backfill-failed-deliveries --help` for supported flags.',
          exampleCli: 'jinn backfill-failed-deliveries --dry-run --json',
          details: { field: 'argv', expected: message },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(configPath);
    const network: JinnOnchainNetwork = config.network === 'testnet' ? 'base-sepolia' : 'base';

    let result: BackfillFailedDeliveriesResult;
    try {
      result = await deps.runBackfill({
        dbPath: config.dbPath,
        rpcUrls: config.rpcUrls,
        network,
        dryRun,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      const details: Record<string, unknown> = { cause };
      if (envelopeDebug(ctx.env) && err instanceof Error && err.stack) {
        details.stack = err.stack;
      }
      emitEnvelope(
        {
          code: 'fatal',
          message:
            err instanceof Error && err.message.trim().length > 0
              ? err.message
              : 'Failed-delivery backfill failed with an unexpected error.',
          details,
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      dryRun,
      reclassified: result.reclassified,
      skipped: result.skipped,
      failed: result.failed,
    };

    emitResult(payload, (v) => humanResult(v as typeof payload), {
      json,
      human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    ctx.exit(0);
  }

  return {
    name: 'backfill-failed-deliveries',
    summary: 'Reclassify FAILED runs as COMPLETE when their delivery tx actually succeeded (#506)',
    helpText: `Usage: jinn backfill-failed-deliveries [--dry-run] [--human] [--config <path>]

Scans FAILED task_runs whose failure reason matches the #506
artifacts.desired_state_id constraint signature, checks each candidate's
recorded deliveryTxHash receipt as secondary confirmation, and reclassifies
rows whose delivery transaction succeeded as COMPLETE. Rows with a
non-matching failure reason, no deliveryTxHash, a reverted receipt, or an
RPC error are left FAILED and reported separately. Idempotent —
already-COMPLETE rows are never touched, and re-running finds nothing left
to reclassify.

Reclassified rows have no artifacts row and no ERC-8004 metadata anchor
(that write is exactly what failed) — this command does not reconstruct
either, it only corrects task_runs.state.

No wallet or password is required.

Examples:
  jinn backfill-failed-deliveries --dry-run
  jinn backfill-failed-deliveries --json
`,
    run,
  };
}

const command: CommandModule = createBackfillFailedDeliveriesCommand();
export default command;
