/**
 * `jinn requester init` — class 1's first-touch verb (B0a, issue #2446).
 *
 * The consumer-class table gives an external requester a blessed surface of
 * "record schemas + `jinn` CLI" and key custody of "CLI keystore,
 * machine-local", and the class-1 quickstart is *post a task with the `jinn`
 * CLI*. This verb is that first touch: wallet, keystore, creator Safe, testnet
 * funds. It registers no OLAS service, stakes nothing, and deploys no mech —
 * a person who wants work done is not onboarded as a supplier.
 *
 * It is deliberately a separate verb rather than a mode on `jinn init`, whose
 * documented contract ("does not contact the RPC or create services") the
 * operator path still depends on.
 */
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import type { FleetBootstrapResult } from '../../earning/types.js';

const EXAMPLE_CLI = 'JINN_PASSWORD=... jinn requester init';

export interface RequesterCommandDeps {
  loadConfig: typeof defaultLoadConfig;
  getConfigPathFromArgs: typeof defaultGetConfigPathFromArgs;
  resolveCliPassword: typeof defaultResolveCliPassword;
  /**
   * Requester-only onboarding walk. Production wires this to
   * `FleetBootstrapper.ensureRequesterSafe`. Injected so the CLI surface is
   * testable without a chain.
   */
  ensureRequesterSafe(input: {
    readonly earningDir: string;
    readonly chain: 'base' | 'base-sepolia';
    readonly rpcUrl: string;
    readonly password: string;
  }): Promise<FleetBootstrapResult>;
}

const PRODUCTION_DEPS: RequesterCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  resolveCliPassword: defaultResolveCliPassword,
  async ensureRequesterSafe(input) {
    const bootstrapper = new FleetBootstrapper({
      earningDir: input.earningDir,
      chain: input.chain,
      rpcUrl: input.rpcUrl,
    });
    return bootstrapper.ensureRequesterSafe(input.password);
  },
};

export function createRequesterCommand(deps: RequesterCommandDeps = PRODUCTION_DEPS): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    let parsed;
    try {
      parsed = parseArgs({ args: ctx.argv, options: { ...COMMON_FLAGS }, allowPositionals: true });
    } catch (err) {
      return emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: EXAMPLE_CLI,
          details: { field: 'flags' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }

    if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'init') {
      return emitEnvelope(
        {
          code: 'invalid_invocation',
          message: 'requester requires the `init` subcommand.',
          exampleCli: EXAMPLE_CLI,
          details: { field: 'subcommand', expected: 'init' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }

    const password = deps.resolveCliPassword(ctx.argv, ctx.env);
    if (!password.ok) {
      return emitEnvelope(
        {
          code: 'invalid_invocation',
          message: password.message,
          hint: 'Choose a passphrase and set JINN_PASSWORD. It encrypts the keystore on this machine and is never sent anywhere.',
          exampleCli: EXAMPLE_CLI,
          details: { field: 'keystore password', expected: 'non-empty string via environment or fd' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }

    const configPath = deps.getConfigPathFromArgs(ctx.argv);
    const config = deps.loadConfig(configPath);
    const chain: 'base' | 'base-sepolia' = config.network === 'testnet' ? 'base-sepolia' : 'base';

    let result: FleetBootstrapResult;
    try {
      result = await deps.ensureRequesterSafe({
        earningDir: config.earningDir,
        chain,
        rpcUrl: config.rpcUrl,
        password: password.password,
      });
    } catch (err) {
      return emitEnvelope(
        {
          code: 'fatal',
          message: 'Requester init could not complete.',
          exampleCli: EXAMPLE_CLI,
          details: { cause: err instanceof Error ? err.message : String(err) },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }

    if (!result.ok) {
      const funding = result.funding;
      if (funding) {
        return emitEnvelope(
          {
            code: 'funding_required',
            message: result.message,
            hint:
              `Send ${chain === 'base-sepolia' ? 'Base Sepolia' : 'Base'} ETH to ` +
              `${funding.master_address}, then run \`jinn requester init\` again. ` +
              'This funds the creator Safe deployment only.',
            exampleCli: EXAMPLE_CLI,
            details: {
              address: funding.master_address,
              asset: 'ETH',
              needWei: funding.eth_required,
              haveWei: funding.eth_balance,
              blocks: 'tasks-submit',
            },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
      }
      return emitEnvelope(
        {
          code: 'fatal',
          message: result.message,
          exampleCli: EXAMPLE_CLI,
          ...(result.rawErrorMessage === undefined ? {} : { details: { cause: result.rawErrorMessage } }),
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }

    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      chain,
      master: result.fleet_state.master_address,
      creatorSafe: result.fleet_state.fleet_safe_address,
      keystoreDir: config.earningDir,
      nextStep: {
        cli: 'jinn tasks submit',
        purpose: 'Describe the work you want done and post it.',
      },
    };

    emitResult(
      payload,
      (v) => {
        const value = v as typeof payload;
        return (
          `Requester ready on ${value.chain}.\n` +
          `Wallet: ${value.master}\n` +
          `Creator Safe: ${value.creatorSafe}\n` +
          `Next: ${value.nextStep.cli}\n` +
          'Backup: your JINN_PASSWORD and the mnemonic in this keystore are the only way to recover this wallet. ' +
          'Run `jinn keys backup` to export the mnemonic.'
        );
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
  }

  return {
    name: 'requester',
    summary: 'Requester-only onboarding: wallet, keystore, and creator Safe',
    helpText: `Usage: JINN_PASSWORD=... jinn requester init [--human] [--json] [--config <path>]

Idempotent. Creates the encrypted keystore if absent, then deploys the
creator Safe that funds and owns the tasks you post. On testnet it drains
the CDP faucet toward the small amount that deployment needs.

Registers no service, stakes nothing, and deploys no mech. Those belong to
operators who supply work, not to requesters who ask for it.

When the wallet is short, this exits with \`funding_required\` naming the
address to fund and the exact shortfall for Safe deployment.

Examples:
  JINN_PASSWORD=secret jinn requester init
  JINN_PASSWORD=secret jinn requester init --human
`,
    run,
  };
}

const command: CommandModule = createRequesterCommand();
export default command;
