import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import {
  gatherIntrospectionRaw as defaultGatherIntrospectionRaw,
} from '../introspection-context.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import {
  parseWithdrawArgv as defaultParseWithdrawArgv,
  validateWithdrawArgs as defaultValidateWithdrawArgs,
} from '../../withdraw/args.js';
import {
  computeSweepWouldSend as defaultComputeSweepWouldSend,
  runWithdrawPlan as defaultRunWithdrawPlan,
  withdrawNeedsInteractiveConfirm as defaultWithdrawNeedsInteractiveConfirm,
} from '../../withdraw/run-withdraw-plan.js';
import { decryptMnemonic as defaultDecryptMnemonic } from '../../earning/wallet.js';
import { FleetStateStore } from '../../earning/store.js';
import { createJinnPublicClient as defaultCreateJinnPublicClient } from '../../earning/viem-clients.js';
import {
  checkDaemonGuard as defaultCheckDaemonGuard,
  daemonGuardEnvelope,
} from '../daemon-guard.js';

interface SweepEntry {
  from: string;
  role: string;
  asset: 'native' | 'bond' | 'reward';
  amountWei: string;
}

function displayServiceIndex(chainIndex: number): number {
  return Math.max(0, chainIndex - 1);
}

export interface WithdrawDeps extends BaseCommandDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  resolveCliPassword: typeof defaultResolveCliPassword;
  parseWithdrawArgv: typeof defaultParseWithdrawArgv;
  validateWithdrawArgs: typeof defaultValidateWithdrawArgs;
  computeSweepWouldSend: typeof defaultComputeSweepWouldSend;
  runWithdrawPlan: typeof defaultRunWithdrawPlan;
  withdrawNeedsInteractiveConfirm: typeof defaultWithdrawNeedsInteractiveConfirm;
  decryptMnemonic: typeof defaultDecryptMnemonic;
  fleetStateStoreFactory: (earningDir: string) => FleetStateStore;
  createJinnPublicClient: typeof defaultCreateJinnPublicClient;
  checkDaemonGuard: typeof defaultCheckDaemonGuard;
}

const PRODUCTION_DEPS: WithdrawDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  resolveCliPassword: defaultResolveCliPassword,
  parseWithdrawArgv: defaultParseWithdrawArgv,
  validateWithdrawArgs: defaultValidateWithdrawArgs,
  computeSweepWouldSend: defaultComputeSweepWouldSend,
  runWithdrawPlan: defaultRunWithdrawPlan,
  withdrawNeedsInteractiveConfirm: defaultWithdrawNeedsInteractiveConfirm,
  decryptMnemonic: defaultDecryptMnemonic,
  fleetStateStoreFactory: (earningDir) => new FleetStateStore(earningDir),
  createJinnPublicClient: defaultCreateJinnPublicClient,
  checkDaemonGuard: defaultCheckDaemonGuard,
};

export function createWithdrawCommand(deps: WithdrawDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'withdraw',
    summary: 'Sweep master / agents per withdraw flags',
    helpText: `Usage: jinn withdraw --to <address> [amount flags] [--dry-run | --yes] [--human]

Supports the same amount flags as the standalone withdraw helper:
  --jinn-amount / --amount / --jinn-wei / --drain-jinn
  --eth-amount / --eth-wei / --drain-eth
  --sweep-agents / --min-sweep-wei / --master-gas-reserve-wei
  --password-fd N

Large or drain operations require --yes (no TTY prompt).

Examples:
  jinn withdraw --to 0xDEST --dry-run
  jinn withdraw --to 0xDEST --eth-amount 0.01 --yes
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = deps.parseWithdrawArgv(ctx.argv);
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn withdraw --to 0xDEST --dry-run',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      if (parsed.help) {
        ctx.writer.write(
          `See \`jinn withdraw --help\` in the command module helpText, or \`jinn withdraw --human\` for the readable terminal form.\n`,
        );
        return;
      }

      try {
        deps.validateWithdrawArgs(parsed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const details =
          message.includes('--to') && message.includes('required')
            ? { field: '--to' as const, expected: 'Ethereum address' }
            : { field: 'flags' as const, expected: message };
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message,
            exampleCli: 'jinn withdraw --to 0xDEST --drain-eth --yes',
            details,
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      const sweep: SweepEntry[] = [];
      const masterAddr = raw.fleet?.master_address ?? raw.master.address;
      if (masterAddr) {
        sweep.push({
          from: masterAddr,
          role: 'master',
          asset: 'native',
          amountWei: raw.master.balanceWei ?? '0',
        });
      }
      for (const svc of raw.fleet?.services ?? []) {
        const di = displayServiceIndex(svc.index);
        if (svc.agent_address) {
          sweep.push({
            from: svc.agent_address,
            role: `service.${di}.agent`,
            asset: 'native',
            amountWei: '0',
          });
        }
        if (svc.safe_address) {
          sweep.push({
            from: svc.safe_address,
            role: `service.${di}.multisig`,
            asset: 'native',
            amountWei: '0',
          });
        }
      }

      const dryRun = parsed.dryRun;
      const yes = parsed.yes;

      if (dryRun) {
        emitDryRun(ctx, {
          verb: 'withdraw',
          description: `Would run withdraw plan (${sweep.length} wallet hint rows) to ${parsed.to}`,
          plan: sweep.map(s => ({ ...s, to: parsed.to })),
        });
        return;
      }

      if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

      const pw = deps.resolveCliPassword(ctx.argv, ctx.env);
      if (!pw.ok) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: pw.message,
            exampleCli: 'jinn withdraw --to 0xDEST --yes',
            details: { field: 'keystore password' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const configPath =
        deps.getConfigPathFromArgs(ctx.argv ?? []) ?? deps.getConfigPathFromArgs(process.argv.slice(2));
      const config = deps.loadConfig(configPath);

      // D0a P3 (#525/#562/#897): below, `runWithdrawPlan` sweeps the master
      // EOA and every agent EOA with no cross-process lock against a
      // concurrently running `jinn run` daemon signing from the same keys.
      const daemonGuard = deps.checkDaemonGuard({ earningDir: config.earningDir, env: ctx.env });
      if (daemonGuard.blocked) {
        emitEnvelope(
          daemonGuardEnvelope(daemonGuard, 'jinn withdraw --to 0xDEST --yes'),
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const networkChain = config.network === 'testnet' ? 'base-sepolia' : 'base';
      const publicClient = deps.createJinnPublicClient(config.rpcUrl, networkChain);
      const store = deps.fleetStateStoreFactory(config.earningDir);
      let sweepWouldSend = false;
      try {
        const mnemonic = await deps.decryptMnemonic(await store.loadMnemonicKeystore(), pw.password);
        const fleet = await store.tryLoadExisting();
        const to = parsed.to as string;
        sweepWouldSend = await deps.computeSweepWouldSend(
          publicClient,
          mnemonic,
          fleet,
          to,
          parsed.minSweepWei,
        );
      } catch {
        // best-effort; withdraw will surface decrypt errors
      }

      if (deps.withdrawNeedsInteractiveConfirm(parsed, { sweepWouldSend }) && !parsed.yes) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message:
              'Large or drain-style withdraw requires explicit --yes (non-interactive CLI has no confirmation prompt).',
            exampleCli: 'jinn withdraw --to 0xDEST --drain-eth --yes',
            details: { field: 'confirmation' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      try {
        await deps.runWithdrawPlan({
          password: pw.password,
          config,
          parsed,
          log: () => {},
          warn: (s: string) => {
            process.stderr.write(s + '\n');
          },
        });
        emitResult(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            verb: 'withdraw',
            to: parsed.to,
            dryRun: false,
            status: 'complete',
          },
          (v) => {
            const value = v as { to: string };
            return `Withdraw plan complete.\nDestination: ${value.to}`;
          },
          {
            json: parsed.json,
            human: parsed.human,
            writer: ctx.writer,
            stdoutIsTty: ctx.stdoutIsTty,
            noColor: Boolean(ctx.env['NO_COLOR']),
          },
        );
      } catch (e) {
        emitEnvelope(
          {
            code: 'fatal',
            message: e instanceof Error ? e.message : String(e),
            details: { cause: e instanceof Error ? e.message : String(e) },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
      }
    },
  };
}

const command: CommandModule = createWithdrawCommand();
export default command;
