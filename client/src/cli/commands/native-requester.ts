/**
 * `jinn native-vertical request` is the production boundary for the Phase B requester.
 * Readiness is side-effect free. Execution remains protected by an explicit flag, an
 * environment interlock, and password-gated role custody.
 */
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';

const OPTIONS = {
  ...COMMON_FLAGS,
  network: { type: 'string' as const },
  fixture: { type: 'string' as const },
  'run-id': { type: 'string' as const },
  execute: { type: 'boolean' as const, default: false },
};

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

export interface NativeRequesterPreflightReport {
  readonly chainId: 84532;
  readonly contractsVerified: true;
  readonly contractCodeVerified: true;
  readonly fundingVerified: true;
  readonly transactionCapsVerified: true;
}

export interface NativeRequesterCommandDeps {
  installShutdownHandlers?: (close: () => Promise<void>) => void;
  preflightRequest(input: {
    readonly network: 'base-sepolia';
    readonly fixture: 'prediction-forecast-golden.json';
    readonly runId: string;
  }): Promise<NativeRequesterPreflightReport>;
  loadExecutor(input: { readonly password: string }): Promise<{
    close?: () => Promise<void>;
    request(input: {
      readonly network: 'base-sepolia';
      readonly fixture: 'prediction-forecast-golden.json';
      readonly runId: string;
    }): Promise<{
      readonly taskDigest: `sha256:${string}`;
      readonly submissionDigest: `sha256:${string}`;
      readonly taskId: string;
      readonly transactionHash: `0x${string}`;
      readonly sourceSequence: string;
      readonly sourceEntryDigest: `sha256:${string}`;
    }>;
  }>;
}

function invalid(ctx: CommandContext, message: string): never {
  return emitEnvelope({
    code: 'invalid_invocation',
    message,
    exampleCli: 'jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>',
  }, { writer: ctx.writer, exit: ctx.exit });
}

export function createNativeRequesterCommand(deps?: NativeRequesterCommandDeps): CommandModule {
  return {
    name: 'native-vertical',
    summary: 'Native requester vertical for Base Sepolia',
    helpText: `Usage:
  jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>

Status:
  The default invocation performs read-only target, contract, funding, and cap checks.
  Live execution requires all explicit authorization controls described below.

Options:
  --network <name>    Must be base-sepolia
  --fixture <name>    Must be prediction-forecast-golden.json
  --run-id <id>       Durable native requester run identifier
  --execute           Permit the already-preflighted requester operation; also requires JINN_NATIVE_VERTICAL_EXECUTE=1

Examples:
  jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id operator-run-20260802
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed: Parsed;
      try {
        parsed = parseArgs({ args: ctx.argv, options: OPTIONS, allowPositionals: true }) as Parsed;
      } catch (error) {
        invalid(ctx, error instanceof Error ? error.message : String(error));
      }
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'request') {
        invalid(ctx, 'native-vertical requires the `request` subcommand');
      }
      if (parsed.values.network !== 'base-sepolia') {
        invalid(ctx, 'native-vertical requires --network base-sepolia');
      }
      if (parsed.values.fixture !== 'prediction-forecast-golden.json') {
        invalid(ctx, 'native-vertical requires --fixture prediction-forecast-golden.json');
      }
      if (typeof parsed.values['run-id'] !== 'string' || parsed.values['run-id'].length === 0) {
        invalid(ctx, 'native-vertical requires a non-empty --run-id');
      }

      if (deps !== undefined) {
        const runId = parsed.values['run-id'];
        let preflight: NativeRequesterPreflightReport;
        try {
          preflight = await deps.preflightRequest({
            network: 'base-sepolia',
            fixture: 'prediction-forecast-golden.json',
            runId,
          });
        } catch (cause) {
          return emitEnvelope({
            code: 'bootstrap_incomplete',
            message: 'Native requester preflight refused before execution authority was loaded.',
            hint: 'Correct the chain, contract-code, funding, and transaction-cap checks, then retry.',
            exampleCli: 'jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>',
            details: {
              feature: 'native-vertical',
              state: 'preflight-refused',
              sideEffects: false,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          }, { writer: ctx.writer, exit: ctx.exit });
        }
        if (parsed.values.execute !== true) {
          ctx.writer.write(`${JSON.stringify({
            schemaVersion: 1,
            kind: 'native_vertical_request_readiness',
            network: 'base-sepolia',
            fixture: 'prediction-forecast-golden.json',
            runId,
            executeAuthorized: false,
            sideEffects: false,
            preflight,
          })}\n`);
          return;
        }
        if (ctx.env.JINN_NATIVE_VERTICAL_EXECUTE !== '1' || !ctx.env.JINN_PASSWORD) {
          return emitEnvelope({
            code: 'invalid_invocation',
            message: 'Native requester execution requires --execute, JINN_NATIVE_VERTICAL_EXECUTE=1, and JINN_PASSWORD.',
            hint: 'Omit --execute for the read-only readiness report.',
            exampleCli: 'jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>',
            details: { feature: 'native-vertical', state: 'execute-authority-missing', sideEffects: false },
          }, { writer: ctx.writer, exit: ctx.exit });
        }
        const executor = await deps.loadExecutor({ password: ctx.env.JINN_PASSWORD });
        if (executor.close !== undefined) deps.installShutdownHandlers?.(executor.close);
        const result = await executor.request({
          network: 'base-sepolia',
          fixture: 'prediction-forecast-golden.json',
          runId,
        });
        ctx.writer.write(`${JSON.stringify({
          schemaVersion: 1,
          kind: 'native_vertical_request_announced',
          network: 'base-sepolia',
          fixture: 'prediction-forecast-golden.json',
          runId,
          executeAuthorized: true,
          sideEffects: true,
          result,
        })}\n`);
        return;
      }

      // This is deliberately before configuration, chain reads, role loading, or postTask.
      emitEnvelope({
        code: 'bootstrap_incomplete',
        message: 'The native requester is feature-disabled in this build.',
        hint: 'Native daemon composition and operational enablement are not yet available.',
        exampleCli: 'jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>',
        details: { feature: 'native-vertical', state: 'feature-disabled' },
      }, { writer: ctx.writer, exit: ctx.exit });
    },
  };
}

const productionDeps: NativeRequesterCommandDeps = {
  installShutdownHandlers(close) {
    const stop = () => {
      void close().catch((cause: unknown) => {
        process.exitCode = 1;
        process.stderr.write(`native requester shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  },
  async preflightRequest(input) {
    const { preflightNativeRequesterCommand } = await import('../../daemon/native-production-deployment.js');
    return preflightNativeRequesterCommand(input);
  },
  async loadExecutor(input) {
    const { loadNativeRequesterCommandExecutor } = await import('../../daemon/native-production-deployment.js');
    return loadNativeRequesterCommandExecutor(input);
  },
};

export default createNativeRequesterCommand(productionDeps);
