import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, getAddress, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { COMMON_FLAGS, type CommandContext, type CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { createCliExecutionContext } from '../execution-context.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';
import type { Task } from '../../types/task.js';
import type { TaskV1 } from '../../types/task-document.js';
import { SOLVER_TYPES, unknownSolverTypeMessage } from '../../solver-types/index.js';
import { signTaskV1 } from '../../tasks/signing.js';
import { TaskPostingService } from '../../tasks/posting-service.js';
import { readChainlinkLatest, scaleToDecimal } from '../../venues/chainlink/client.js';
import { walletPrivateKeyAtIndex } from '../../earning/wallet.js';
import { isOperationalServiceStep } from '../../earning/types.js';
import { getConfigPathFromArgs, loadConfig } from '../../config.js';

async function runSubmit(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        id: { type: 'string' },
        description: { type: 'string' },
        'solver-net': { type: 'string' },
        'solver-type': { type: 'string' },
        'spec-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn tasks submit --id test-1 --description "..." --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const id = parsed.values.id as string | undefined;
  const description = parsed.values.description as string | undefined;
  const requestedSolverNet = parsed.values['solver-net'] as string | undefined;
  const requestedSolverType = parsed.values['solver-type'] as string | undefined;

  if (!id) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--id is required',
        exampleCli: 'jinn tasks submit --id my-task --description "..." --dry-run',
        details: { field: '--id', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (!description) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--description is required',
        exampleCli: 'jinn tasks submit --id my-task --description "..." --dry-run',
        details: { field: '--description', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  // ── spec-file loading ───────────────────────────────────────────────────────
  const config = loadConfig(getConfigPathFromArgs(ctx.argv));
  const solverTypeFromNet =
    requestedSolverNet ? config.solverNets[requestedSolverNet]?.solverType : undefined;
  if (requestedSolverNet && !solverTypeFromNet) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown SolverNet: ${requestedSolverNet}`,
        exampleCli: 'jinn solver-nets list',
        details: { field: '--solver-net', expected: Object.keys(config.solverNets).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const specFilePath = parsed.values['spec-file'] as string | undefined;
  let specOverlay: { solverType?: string; window?: any; claimPolicy?: any; spec?: any; eligibility?: any } | undefined;
  if (specFilePath) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(resolve(specFilePath), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Could not read spec file: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli: 'jinn tasks submit --id my-1 --description "..." --spec-file fixtures/prediction-v0-task.example.json --dry-run',
          details: { field: 'spec-file' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const rawSolverType = raw['solverType'];
    const solverTypeStr =
      requestedSolverType ?? solverTypeFromNet ??
      (typeof rawSolverType === 'string'
        ? rawSolverType
        : undefined);
    const solverType = solverTypeStr !== undefined ? SOLVER_TYPES[solverTypeStr] : undefined;
    if (!solverType) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: unknownSolverTypeMessage(solverTypeStr),
          exampleCli:
            'jinn tasks submit --id my-1 --description "..." --spec-file fixtures/prediction-v0-task.example.json --dry-run',
          details: { field: 'spec-file', expected: 'solverType must be a registered SolverType' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const rawSpec = (raw['spec'] && typeof raw['spec'] === 'object' && !Array.isArray(raw['spec']))
      ? (raw['spec'] as Record<string, unknown>)
      : {};
    const parserInput: Record<string, unknown> = {
      id: id!,
      description: description!,
      ...raw,
      solverType: solverTypeStr,
      spec: rawSpec,
    };
    try {
      const parsedOverlay = await solverType.parseSpec(parserInput, {
        readCurrent: async ({ feed, venue }) => {
          const chain = venue === 'chainlink-base' ? base : baseSepolia;
          const rpcUrl = ctx.env[venue === 'chainlink-base' ? 'BASE_RPC_URL' : 'BASE_SEPOLIA_RPC_URL']
            ?? (venue === 'chainlink-base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org');
          const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
          const reading = await readChainlinkLatest(feed, publicClient);
          return scaleToDecimal(reading.answer, reading.decimals);
        },
      });
      specOverlay = {
        solverType: solverTypeStr,
        window: parsedOverlay.window,
        claimPolicy: parsedOverlay.claimPolicy,
        spec: parsedOverlay.spec,
        eligibility: parsedOverlay.eligibility,
      };
    } catch (err) {
      const exampleCli =
        solverTypeStr === 'prediction.apy.v0'
          ? 'jinn tasks submit --id my-apy-1 --description "..." --spec-file fixtures/prediction-apy-v0-task.example.json --dry-run'
          : solverTypeStr === 'portfolio.v0'
            ? 'jinn tasks submit --id pf-1 --description "..." --spec-file <portfolio-fixture.json> --dry-run'
            : 'jinn tasks submit --id my-1 --description "..." --spec-file fixtures/prediction-v0-task.example.json --dry-run';
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Invalid ${solverTypeStr} task: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli,
          details: { field: 'spec-file' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
  }

  if (dryRun) {
    const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
    const service = raw.fleet?.services.find(s => isOperationalServiceStep(s.step));
    if (!service?.safe_address) {
      emitEnvelope(
        {
          code: 'bootstrap_incomplete',
          message:
            'No bootstrapped service available to submit Tasks from. Run `jinn bootstrap` first.',
          hint: 'Run `jinn fund-requirements` to see outstanding funding, then `jinn bootstrap`.',
          exampleCli: 'jinn bootstrap --human',
          details: { field: 'fleet.services', expected: 'at least one operational service' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const creatorMultisig = getAddress(service.safe_address);
    emitDryRun(ctx, {
      verb: 'tasks submit',
      description: `Would post task '${id}' from ${creatorMultisig}`,
      plan: [
        {
          id,
          description,
          creatorMultisig,
          asset: 'native',
          txCount: 1,
          ...(specOverlay ? { solverType: specOverlay.solverType, spec: specOverlay.spec } : {}),
        },
      ],
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  const built = await createCliExecutionContext({ argv: ctx.argv, env: ctx.env });
  if (!built.ok) {
    emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  const { adapter, jinnStore, primaryService, mnemonic } = built.ctx;
  const safe = primaryService.safe_address!;
  const postingService = new TaskPostingService(adapter, jinnStore);
  try {
    // Build and sign a SignedTaskV1 so the IPFS-uploaded document is the
    // canonical task envelope rather than a loose TaskPayload.
    const agentEoaPrivateKey = walletPrivateKeyAtIndex(mnemonic, primaryService.index);
    const agentEoaAddress = privateKeyToAccount(agentEoaPrivateKey).address;
    const overlay = specOverlay ?? {};
    const taskKind = overlay.solverType ?? requestedSolverType ?? solverTypeFromNet ?? 'prediction.v1';
    const taskWindow = overlay.window ?? { startTs: Date.now(), endTs: Date.now() + 86_400_000 };
    const taskDoc: TaskV1 = {
      schemaVersion: 'task.v1',
      id,
      solverType: taskKind,
      role: 'restoration',
      description,
      window: taskWindow,
      ...(overlay.claimPolicy ? { claimPolicy: overlay.claimPolicy } : {}),
      spec: ((overlay.spec as Record<string, unknown> | undefined) ?? {}) as TaskV1['spec'],
      eligibility: overlay.eligibility ?? {},
      creator: {
        safeAddress: getAddress(safe),
        agentEoa: agentEoaAddress,
      },
      createdAt: Date.now(),
    };
    const signedTask = await signTaskV1(taskDoc, agentEoaPrivateKey);
    const task: Task = {
      id,
      description,
      ...(specOverlay ?? {}),
      solverType: taskKind,
      signedTask,
    };
    const postResult = await postingService.postCandidate(
      {
        task,
        sourceKey: `manual:${id}`,
        postingPolicy: { kind: 'once_per_safe' },
        sourceMeta: { solverType: task.solverType, note: 'manual' },
      },
      {
        creatorSafeAddress: safe,
      },
    );
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'tasks submit',
        id,
        creatorMultisig: getAddress(safe),
        requestId: postResult.requestId,
        status: postResult.idempotent ? 'already_submitted' : 'submitted',
        attemptId: postResult.attemptId,
        attemptNumber: postResult.attemptNumber,
        idempotent: postResult.idempotent,
      },
      (v) => {
        const value = v as { id: string; requestId: string; creatorMultisig: string };
        return postResult.idempotent
          ? `Task already submitted.\nID: ${value.id}\nRequest: ${value.requestId}\nSafe: ${value.creatorMultisig}`
          : `Task submitted.\nID: ${value.id}\nRequest: ${value.requestId}\nSafe: ${value.creatorMultisig}`;
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
  } catch (e) {
    if (isRecoverableTransactionError(e)) {
      emitEnvelope(
        {
          code: 'transient_error',
          message: e instanceof Error ? e.message : String(e),
          hint: 'Retry when the RPC endpoint is healthy or fees clear.',
          exampleCli: 'jinn tasks submit --id my-task --description "..." --yes',
          details: { cause: e instanceof Error ? e.message : String(e) },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    emitEnvelope(
      {
        code: 'fatal',
        message: e instanceof Error ? e.message : String(e),
        details: { cause: e instanceof Error ? e.message : String(e) },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
  }
}

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb || subverb === '--help' || subverb === '-h') {
    ctx.writer.write(command.helpText + '\n');
    return;
  }
  if (subverb === 'submit') {
    return runSubmit({ ...ctx, argv: rest });
  }
  if (subverb === 'list') {
    const config = loadConfig(getConfigPathFromArgs(rest));
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'tasks list',
        tasks: config.tasks.map((task) => ({
          id: task.id,
          description: task.description,
          solverType: task.solverType,
          role: task.role ?? 'restoration',
        })),
      },
      (v) => JSON.stringify(v, null, 2),
      {
        json: Boolean(rest.includes('--json')),
        human: Boolean(rest.includes('--human')),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
      },
    );
    return;
  }
  if (subverb === 'show') {
    const target = rest.find((arg) => !arg.startsWith('--'));
    const config = loadConfig(getConfigPathFromArgs(rest));
    const task = config.tasks.find((candidate) => candidate.id === target) ?? null;
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'tasks show',
        task,
      },
      (v) => JSON.stringify(v, null, 2),
      {
        json: Boolean(rest.includes('--json')),
        human: Boolean(rest.includes('--human')),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
      },
    );
    return;
  }
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown tasks subverb: ${subverb}`,
      exampleCli: 'jinn tasks submit --id my-task --description "..." --solver-net prediction',
      details: { field: 'subverb', expected: 'submit|list|show' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'tasks',
  summary: 'Submit and inspect Tasks',
  helpText: `Usage:
  jinn tasks submit --id <id> --description <text> (--solver-net <name> | --solver-type <type>) [--spec-file <path>] [--dry-run] [--yes] [--human]
  jinn tasks list
  jinn tasks show <id>

Idempotent: re-posting the same (--id) from the same creator Safe returns the
existing request id from the shared task-posting store without sending a new
transaction.

Options:
  --spec-file <path>  Path to a JSON file containing typed task fields (window, spec, eligibility).
                      Supports registered SolverTypes: portfolio.v0, prediction.v0, prediction.apy.v0.

                      Sentinels resolved at post time:
                        window.startTs: 0              → Date.now(); endTs + resolveTs follow
                        spec.question.threshold:       → the current Chainlink feed price
                          "current"                      (exactly)
                          "current+0.5%" / "current-2%"  (percentage offset)
                          "current+100"  / "current-50"  (absolute offset)
                      For price-aware thresholds the CLI reads the feed named in
                      spec.oracle before posting; use BASE_SEPOLIA_RPC_URL to
                      override the default public RPC.

Examples:
  jinn tasks submit --id eth-up --description "ETH direction" --solver-net prediction --spec-file fixtures/prediction-v0-task.example.json --yes
  jinn tasks submit --id usdc-apy --description "Aave APY" --solver-type prediction.apy.v0 --spec-file fixtures/prediction-apy-v0-task.example.json --yes
`,
  run,
};

export default command;
