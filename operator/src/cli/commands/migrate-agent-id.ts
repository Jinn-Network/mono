/**
 * `jinn migrate-agent-id` — backfill ERC-8004 `agent_id` on `complete`
 * services that pre-date jinn-mono-j07.
 *
 * The same migration runs automatically on `jinn run` startup (gated by
 * `runLegacyMigrations`, default true). This command exists so operators
 * can:
 *   - run the migration explicitly (debuggable, verbose)
 *   - re-run after a transient RPC failure without restarting the daemon
 *   - opt-in after disabling the auto-run
 *
 * See `operator/src/earning/migrate-agent-id.ts` and jinn-mono-jgp.
 */

import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import {
  runLegacyAgentIdMigration as defaultRunMigration,
  type MigrateAgentIdsResult,
} from '../../earning/migrate-agent-id.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';

function envelopeDebug(env: NodeJS.ProcessEnv): boolean {
  return env['JINN_DEBUG'] === '1';
}

function humanResult(payload: {
  migrated: Array<{ index: number; agentId: string | null }>;
  skipped: Array<{ index: number; agentId: string | null }>;
  failed: Array<{ index: number; error: string }>;
}): string {
  const lines: string[] = ['Legacy agent_id migration complete.'];
  lines.push(`  migrated: ${payload.migrated.length}`);
  for (const m of payload.migrated) {
    lines.push(`    #${m.index} agentId=${m.agentId ?? '(unknown)'}`);
  }
  lines.push(`  skipped:  ${payload.skipped.length}`);
  for (const s of payload.skipped) {
    lines.push(`    #${s.index} agentId=${s.agentId ?? '(unknown)'}`);
  }
  lines.push(`  failed:   ${payload.failed.length}`);
  for (const f of payload.failed) {
    lines.push(`    #${f.index} ${f.error}`);
  }
  return lines.join('\n');
}

export interface MigrateAgentIdDeps {
  loadConfig: typeof defaultLoadConfig;
  getConfigPathFromArgs: typeof defaultGetConfigPathFromArgs;
  resolveCliPassword: typeof defaultResolveCliPassword;
  runMigration: typeof defaultRunMigration;
}

const PRODUCTION_DEPS: MigrateAgentIdDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  resolveCliPassword: defaultResolveCliPassword,
  runMigration: defaultRunMigration,
};

export function createMigrateAgentIdCommand(
  deps: MigrateAgentIdDeps = PRODUCTION_DEPS,
): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    let json = false;
    let human = false;
    let configPath: string | undefined;

    try {
      const parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
      json = Boolean(parsed.values.json);
      human = Boolean(parsed.values.human);
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
          hint: 'Run `jinn migrate-agent-id --help` for supported flags.',
          exampleCli: 'jinn migrate-agent-id --json',
          details: { field: 'argv', expected: message },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const password = deps.resolveCliPassword(ctx.argv, ctx.env);
    if (!password.ok) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: password.message,
          hint: 'Set JINN_PASSWORD or pass --password-fd N, then re-run.',
          exampleCli: 'jinn migrate-agent-id --json',
          details: {
            field: 'keystore password',
            expected: 'non-empty string via environment or fd',
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(configPath);
    const network = config.network === 'testnet' ? 'base-sepolia' : 'base';

    let result: MigrateAgentIdsResult;
    try {
      result = await deps.runMigration({
        earningDir: config.earningDir,
        network,
        rpcUrl: config.rpcUrl,
        password: password.password,
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
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
              : 'Legacy agent_id migration failed with an unexpected error.',
          details,
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      migrated: result.migrated.map((s) => ({
        index: s.index,
        agentId: s.agent_id ?? null,
      })),
      skipped: result.skipped.map((s) => ({
        index: s.index,
        agentId: s.agent_id ?? null,
      })),
      failed: result.failed.map((f) => ({
        index: f.service.index,
        error: f.error,
      })),
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
    name: 'migrate-agent-id',
    summary: 'Backfill ERC-8004 agent_id on legacy complete services (jinn-mono-jgp)',
    helpText: `Usage: jinn migrate-agent-id [--human] [--config <path>] [--password-fd <fd>]

Idempotent. Detects services with state == 'complete' && agent_id == null
and runs the ERC-8004 IdentityRegistry mint flow for each. Services that
already have an agent_id (or whose agent EOA already owns an NFT on-chain,
recovered via Registered event scan) are not re-minted.

The same migration runs automatically on \`jinn run\` startup unless
\`runLegacyMigrations: false\` is set in config (or
JINN_RUN_LEGACY_MIGRATIONS=0). This command is the explicit entry point
for debugging or after a transient failure.

Examples:
  jinn migrate-agent-id
  jinn migrate-agent-id --human
  jinn migrate-agent-id --json
`,
    run,
  };
}

const command: CommandModule = createMigrateAgentIdCommand();
export default command;
