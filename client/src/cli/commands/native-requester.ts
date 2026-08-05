/**
 * `jinn native-vertical request` is the production boundary for the Phase B requester.
 * Readiness is side-effect free. Execution remains protected by an explicit flag, an
 * environment interlock, and password-gated role custody.
 *
 * `jinn native-vertical identity` is the sibling keygen/listing tool: it mints (or opens) an
 * encrypted role identity store for a named role set and prints role -> did:key keyIds only,
 * so trust-catalog authoring (#2431/#2432) has something to bind without ever seeing key bytes.
 */
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import {
  IdentityStoreError,
  listRoleIdentityKeyIds,
  NATIVE_ROLE_IDENTITY_ROLES,
  type NativeRoleIdentityRole,
} from '../../daemon/role-identities.js';

const OPTIONS = {
  ...COMMON_FLAGS,
  network: { type: 'string' as const },
  fixture: { type: 'string' as const },
  'run-id': { type: 'string' as const },
  execute: { type: 'boolean' as const, default: false },
  store: { type: 'string' as const },
  roles: { type: 'string' as const },
  create: { type: 'boolean' as const, default: false },
};

/**
 * The four role sets a native process actually opens at boot (mirrors
 * `buildRequesterHost`/`buildSolverHost`/`buildEvaluatorHost` in
 * `daemon/native-production-deployment.ts`). Free-form role lists are deliberately not
 * accepted here: a store owning any other combination is one boot refuses to open.
 */
// Exported (not just used internally) so tests can assert the four-set partition against the
// real implementation instead of a hardcoded literal that can silently drift from it.
export const ROLE_SETS = {
  requester: new Set<NativeRoleIdentityRole>(['requester-submission', 'requester-discovery']),
  admission: new Set<NativeRoleIdentityRole>(['admission']),
  solver: new Set<NativeRoleIdentityRole>(['solver-delivery', 'solver-settlement', 'solver-discovery']),
  evaluator: new Set<NativeRoleIdentityRole>(['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery']),
} as const;

export type RoleSetName = keyof typeof ROLE_SETS;

function isRoleSetName(value: unknown): value is RoleSetName {
  return typeof value === 'string' && Object.hasOwn(ROLE_SETS, value);
}

/** Same canonical-order derivation `RoleIdentitySet.open` uses, so stores stay byte-compatible. */
export function orderedRolesForSet(name: RoleSetName): readonly NativeRoleIdentityRole[] {
  const members = ROLE_SETS[name];
  return NATIVE_ROLE_IDENTITY_ROLES.filter((role) => members.has(role));
}

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

const IDENTITY_EXAMPLE_CLI = 'jinn native-vertical identity --store <absolute path> --roles requester|admission|solver|evaluator [--create]';

function invalidIdentity(ctx: CommandContext, message: string): never {
  return emitEnvelope({
    code: 'invalid_invocation',
    message,
    exampleCli: IDENTITY_EXAMPLE_CLI,
  }, { writer: ctx.writer, exit: ctx.exit });
}

async function runIdentity(ctx: CommandContext, parsed: Parsed): Promise<void> {
  if (parsed.positionals.length !== 1) {
    return invalidIdentity(ctx, 'native-vertical identity takes no positional arguments beyond `identity`');
  }
  const store = parsed.values.store;
  if (typeof store !== 'string' || store.length === 0) {
    return invalidIdentity(ctx, 'native-vertical identity requires --store <absolute path>');
  }
  const roleSet = parsed.values.roles;
  if (!isRoleSetName(roleSet)) {
    return invalidIdentity(ctx, 'native-vertical identity requires --roles requester|admission|solver|evaluator');
  }
  const password = ctx.env.JINN_PASSWORD;
  if (typeof password !== 'string' || password.length === 0) {
    return invalidIdentity(ctx, 'native-vertical identity requires JINN_PASSWORD (no --password-fd or keystore-file fallback)');
  }
  const create = parsed.values.create === true;

  let result: Awaited<ReturnType<typeof listRoleIdentityKeyIds>>;
  try {
    result = await listRoleIdentityKeyIds({
      storePath: store,
      password,
      ownedRoles: orderedRolesForSet(roleSet),
      create,
    });
  } catch (cause) {
    const message = cause instanceof IdentityStoreError ? cause.message : (cause instanceof Error ? cause.message : String(cause));
    // `listRoleIdentityKeyIds` speaks its own `create: true` boolean parameter; the CLI operator
    // types `--create`. Reword at this surface rather than teach the library about flag syntax.
    return invalidIdentity(ctx, message.replace('create: true', '--create'));
  }

  emitResult(
    {
      schemaVersion: 1,
      kind: 'native_role_identity_listing',
      store,
      roleSet,
      created: result.created,
      identities: result.identities,
    },
    (value) => {
      const listing = value as { readonly identities: readonly { readonly role: string; readonly keyId: string }[] };
      return listing.identities.map((identity) => `${identity.role}\t${identity.keyId}`).join('\n');
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env.NO_COLOR),
    },
  );
}

export function createNativeRequesterCommand(deps?: NativeRequesterCommandDeps): CommandModule {
  return {
    name: 'native-vertical',
    summary: 'Native requester vertical and role-identity keygen for Base Sepolia',
    helpText: `Usage:
  jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>
  jinn native-vertical identity --store <absolute path> --roles requester|admission|solver|evaluator [--create]

Status:
  The default \`request\` invocation performs read-only target, contract, funding, and cap checks.
  Live execution requires all explicit authorization controls described below.
  \`identity\` opens (or, with --create, mints) an encrypted role identity store and prints its
  role -> did:key keyIds. It never prints or exports private key material.

Options (request):
  --network <name>    Must be base-sepolia
  --fixture <name>    Must be prediction-forecast-golden.json
  --run-id <id>       Durable native requester run identifier
  --execute           Permit the already-preflighted requester operation; also requires JINN_NATIVE_VERTICAL_EXECUTE=1

Options (identity):
  --store <path>      Absolute path to the encrypted identity store
  --roles <set>       requester | admission | solver | evaluator (the exact role-set groupings a native boot opens)
  --create            Mint the store's role identities if the store does not already exist
  JINN_PASSWORD        Required; identity refuses to run without it (no --password-fd or keystore-file fallback)

Examples:
  jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id operator-run-20260802
  JINN_PASSWORD=... jinn native-vertical identity --store /abs/path/roles.enc.json --roles requester --create
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed: Parsed;
      try {
        parsed = parseArgs({ args: ctx.argv, options: OPTIONS, allowPositionals: true }) as Parsed;
      } catch (error) {
        invalid(ctx, error instanceof Error ? error.message : String(error));
      }
      if (parsed.positionals[0] === 'identity') {
        return runIdentity(ctx, parsed);
      }
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'request') {
        invalid(ctx, 'native-vertical requires the `request` or `identity` subcommand');
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
