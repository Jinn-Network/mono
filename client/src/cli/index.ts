/**
 * jinn CLI dispatcher.
 *
 * Contract: spec/2026-04-14-client-surface.md §2 (verbs), §6 (error envelope),
 * §7 (behavioral rules).
 *
 * Adding a verb: create `commands/<name>.ts` exporting a default CommandModule,
 * then import and push into COMMANDS below.
 */

import type { CommandContext, CommandModule } from './command.js';
import { emitEnvelope } from '../errors/envelope.js';
import { renderTopLevelHelp, renderCommandHelp } from './help.js';
import { ConfigLoadError } from '../config.js';
import { IntrospectionUnauthorizedError } from './introspection-context.js';

import versionCommand from './commands/version.js';
import doctorCommand from './commands/doctor.js';
import initCommand from './commands/init.js';
import quickstartCommand from './commands/quickstart.js';
import authCommand from './commands/auth.js';
import bootstrapCommand from './commands/bootstrap.js';
import fundRequirementsCommand from './commands/fund-requirements.js';
import runCommand from './commands/run.js';
import stopCommand from './commands/stop.js';
import killCommand from './commands/kill.js';
import statusCommand from './commands/status.js';
import fleetCommand from './commands/fleet.js';
import balanceCommand from './commands/balance.js';
import historyCommand from './commands/history.js';
import rewardsCommand from './commands/rewards.js';
import logsCommand from './commands/logs.js';
import fleetManageCommand from './commands/fleet-scale.js';
import claimRewardsCommand from './commands/claim-rewards.js';
import withdrawCommand from './commands/withdraw.js';
import keysCommand from './commands/keys-backup.js';
import updateCommand from './commands/update.js';
import mcpCommand from './commands/mcp.js';
import migrateAgentIdCommand from './commands/migrate-agent-id.js';
import backfillFailedDeliveriesCommand from './commands/backfill-failed-deliveries.js';
import conformanceCommand from './commands/conformance.js';
import evidenceCommand from './commands/evidence.js';
import createCommand from './commands/create.js';
import uiCommand from './commands/ui.js';
import tasksCommand from './commands/tasks.js';
import solverNetsCommand from './commands/solver-nets.js';
import harnessesCommand from './commands/harnesses.js';
import solverPluginsCommand from './commands/solver-plugins.js';
import integrationsCommand from './commands/integrations.js';
import predictionScoreboardCommand from './commands/prediction-scoreboard.js';
import captureCommand from './commands/capture.js';
import codedigestRevertCheckCommand from './commands/codedigest-revert-check.js';
import evalCommand from './commands/eval.js';
import scrubCommand from './commands/scrub.js';
import nativeRequesterCommand from './commands/native-requester.js';
import bootstrapRetryCommand from './commands/bootstrap-retry.js';
import onboardingCompleteCommand from './commands/onboarding-complete.js';
import policyCommand from './commands/policy.js';
import wiringCommand from './commands/wiring.js';

const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  quickstartCommand,
  authCommand,
  bootstrapCommand,
  bootstrapRetryCommand,
  onboardingCompleteCommand,
  fundRequirementsCommand,
  runCommand,
  stopCommand,
  killCommand,
  statusCommand,
  fleetCommand,
  balanceCommand,
  historyCommand,
  rewardsCommand,
  logsCommand,
  fleetManageCommand,
  claimRewardsCommand,
  withdrawCommand,
  keysCommand,
  updateCommand,
  mcpCommand,
  migrateAgentIdCommand,
  backfillFailedDeliveriesCommand,
  conformanceCommand,
  evidenceCommand,
  createCommand,
  uiCommand,
  tasksCommand,
  solverNetsCommand,
  predictionScoreboardCommand,
  captureCommand,
  harnessesCommand,
  solverPluginsCommand,
  integrationsCommand,
  codedigestRevertCheckCommand,
  evalCommand,
  scrubCommand,
  nativeRequesterCommand,
  policyCommand,
  wiringCommand,
];

/**
 * All registered CLI commands. Used by skill generators and conformance checks to keep
 * SKILL.md and operator docs in sync with the actual registry.
 * The internal `fleet-manage` alias is excluded; use the public `fleet <subverb>` form.
 */
export const CLI_COMMANDS: ReadonlyArray<CommandModule> = COMMANDS.filter(
  (c) => c.name !== 'fleet-manage',
);

function publicCommandNames(commands: CommandModule[]): string[] {
  return commands.filter((c) => c.name !== 'fleet-manage').map((c) => c.name);
}

export interface RunCliOptions {
  writer?: { write: (s: string) => boolean };
  exit?: (code: number) => void;
  stdoutIsTty?: boolean;
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<void> {
  const writer = opts.writer ?? process.stdout;
  const exit = opts.exit ?? ((c: number) => { process.exit(c); });
  const stdoutIsTty = opts.stdoutIsTty ?? Boolean(process.stdout.isTTY);

  // No args → top-level help, exit 0.
  if (argv.length === 0) {
    writer.write(renderTopLevelHelp(COMMANDS) + '\n');
    return;
  }

  const [verb, ...rest] = argv;
  const isFleetManage = verb === 'fleet' && rest.length > 0 && !rest[0]!.startsWith('-');

  // --help at the top level
  if (verb === '--help' || verb === '-h') {
    writer.write(renderTopLevelHelp(COMMANDS) + '\n');
    return;
  }

  const command = isFleetManage
    ? COMMANDS.find((c) => c.name === 'fleet-manage')
    : COMMANDS.find((c) => c.name === verb);
  if (!command) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown verb: ${verb}`,
        hint: 'Run `jinn --help` for the list of verbs.',
        exampleCli: 'jinn --help',
        details: {
          field: 'subcommand',
          expected: publicCommandNames(COMMANDS).join('|'),
        },
      },
      { writer, exit },
    );
    return;
  }

  const commandArgv = rest;
  const exampleInvocation = isFleetManage ? `jinn fleet ${rest[0]}` : `jinn ${verb}`;

  // Per-verb --help short-circuit (before any command-specific parsing)
  if (commandArgv.includes('--help') || commandArgv.includes('-h')) {
    writer.write(renderCommandHelp(command) + '\n');
    return;
  }

  const ctx: CommandContext = {
    argv: commandArgv,
    stdoutIsTty,
    writer,
    exit,
    env: process.env,
  };

  try {
    await command.run(ctx);
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      const details: Record<string, unknown> = {
        field: 'config',
        code: err.code,
        ...(err.details ?? {}),
      };
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err.message,
          hint: 'Fix the configuration inputs and re-run the command.',
          exampleCli: exampleInvocation,
          details,
        },
        { writer, exit },
      );
      return;
    }
    if (err instanceof IntrospectionUnauthorizedError) {
      // §14.5 / issue #2404: /v1/status's 401 gets a machine-readable shape
      // rather than falling into the generic `fatal` bucket below.
      // `ErrorCode` has no `unauthorized` member — don't mint one; `reason`
      // in `details` carries the discriminator instead.
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err.message,
          hint: 'Restart the daemon (it regenerates the token) or point --config at the right instance.',
          exampleCli: exampleInvocation,
          details: { reason: 'unauthorized', verb },
        },
        { writer, exit },
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const details: Record<string, unknown> = { cause: message, verb };
    const debug = process.env['JINN_DEBUG'] === '1';
    if (debug && err instanceof Error && err.stack) {
      details.stack = err.stack;
    }
    emitEnvelope(
      {
        code: 'fatal',
        message,
        details,
      },
      { writer, exit },
    );
  }
}
