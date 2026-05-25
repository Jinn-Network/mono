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
        'manifest-cid': { type: 'string' },
        'max-claims': { type: 'string' },
        'required-verdicts': { type: 'string' },
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

  // ── claim-policy override: --max-claims ─────────────────────────────────────
  // The on-chain `claimPolicy` defaults to a single attempt slot
  // (`maxClaims: 1`). That is correct for one-shot SolverTypes, but it makes a
  // task brittle on a shared testnet: whoever wins the single solution claim
  // also holds the single verdict slot (`requiredVerdicts: 1`), and a claimer
  // that never delivers a verdict permanently dead-locks the task — no other
  // operator can ever get an attempt. SWE-rebench v2's auto-generator already
  // posts `maxClaims: 5` for exactly this reason. `--max-claims` lets a caller
  // (e.g. the T3.1 release-readiness gate) post a multi-slot task so a
  // controlled operator can always get its own attempt to solve and grade.
  let maxClaimsOverride: number | undefined;
  const rawMaxClaims = parsed.values['max-claims'] as string | undefined;
  if (rawMaxClaims !== undefined) {
    const n = Number(rawMaxClaims);
    if (!Number.isInteger(n) || n < 1) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `--max-claims must be a positive integer, got '${rawMaxClaims}'`,
          exampleCli: 'jinn tasks submit --id my-task --description "..." --max-claims 5 --dry-run',
          details: { field: '--max-claims', expected: 'positive integer' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    maxClaimsOverride = n;
  }

  // ── claim-policy override: --required-verdicts ──────────────────────────────
  // The on-chain `evaluationPolicy.requiredVerdicts` defaults to 1 — a single
  // verdict slot per attempt. On a shared/adversarial network a claimer that
  // never delivers can squat that one slot and permanently lock the attempt's
  // verdict leg. `--required-verdicts N` opens N slots; with the protocol's
  // per-evaluator cap of 1, an honest evaluator can always claim and deliver
  // one even when others squat the rest.
  let requiredVerdictsOverride: number | undefined;
  const rawRequiredVerdicts = parsed.values['required-verdicts'] as string | undefined;
  if (rawRequiredVerdicts !== undefined) {
    const n = Number(rawRequiredVerdicts);
    if (!Number.isInteger(n) || n < 1) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `--required-verdicts must be a positive integer, got '${rawRequiredVerdicts}'`,
          exampleCli: 'jinn tasks submit --id my-task --description "..." --required-verdicts 3 --dry-run',
          details: { field: '--required-verdicts', expected: 'positive integer' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    requiredVerdictsOverride = n;
  }

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
  let specOverlay: { solverType?: string; window?: any; spec?: any; eligibility?: any } | undefined;
  if (specFilePath) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(resolve(specFilePath), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Could not read spec file: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli: 'jinn tasks submit --id my-1 --description "..." --spec-file fixtures/prediction-v1-task.example.json --dry-run',
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
            'jinn tasks submit --id my-1 --description "..." --spec-file fixtures/prediction-v1-task.example.json --dry-run',
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
        spec: parsedOverlay.spec,
        eligibility: parsedOverlay.eligibility,
      };
    } catch (err) {
      const exampleCli =
        solverTypeStr === 'prediction.apy.v0'
          ? 'jinn tasks submit --id my-apy-1 --description "..." --spec-file fixtures/prediction-apy-v0-intent.example.json --dry-run'
          : solverTypeStr === 'portfolio.v0'
            ? 'jinn tasks submit --id pf-1 --description "..." --spec-file <portfolio-fixture.json> --dry-run'
            : 'jinn tasks submit --id my-1 --description "..." --spec-file fixtures/prediction-v1-task.example.json --dry-run';
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
    // Task 24 (spec/2026-05-05-solvernet-creation-and-launch.md §14): the
    // signed task must carry `solverNetManifestCid` so the on-chain digest
    // is `keccak256(manifestCid)`. Resolution order: explicit
    // --manifest-cid flag → joinedSolverNets[--solver-net].manifestCid.
    // Without one we refuse to submit; admin paths posting orphan tasks
    // need to supply a cid.
    const explicitManifestCid = parsed.values['manifest-cid'] as string | undefined;
    const joinedManifestCid = requestedSolverNet
      ? config.joinedSolverNets?.[requestedSolverNet]?.manifestCid
      : undefined;
    const solverNetManifestCid = explicitManifestCid ?? joinedManifestCid;
    if (!solverNetManifestCid) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message:
            '--manifest-cid is required (or --solver-net pointing at an entry in joinedSolverNets with a manifestCid). ' +
            'Spec/2026-05-05-solvernet-creation-and-launch.md §14: the on-chain manifestDigest derives from keccak256(manifestCid).',
          exampleCli:
            'jinn tasks submit --id my-task --description "..." --solver-type prediction.v1 --manifest-cid <bafy…> --dry-run',
          details: { field: '--manifest-cid', expected: 'IPFS CID of the launched SolverNet manifest' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const dotIdx = taskKind.lastIndexOf('.');
    const contractId = dotIdx > 0 ? taskKind.slice(0, dotIdx) : taskKind;
    const contractVersion = dotIdx > 0 ? taskKind.slice(dotIdx + 1) : 'v0';
    // `--max-claims > 1` posts a multi-attempt task: `mode: 'parallel'` so
    // attempts are not serialized, with `maxClaimsPerOperator` widened to match
    // so a single controlled operator can take its own attempt even if other
    // operators are also claiming. This mirrors the SWE-rebench v2
    // auto-generator's policy (parallel, maxClaims = maxClaimsPerOperator). The
    // default (no flag) stays single-attempt exclusive — unchanged production
    // behaviour for one-shot SolverTypes.
    const claimPolicy: TaskV1['claimPolicy'] = {
      mode: maxClaimsOverride && maxClaimsOverride > 1 ? 'parallel' : 'exclusive',
      maxClaims: maxClaimsOverride ?? 1,
      maxClaimsPerOperator: maxClaimsOverride ?? 1,
      claimWindowStartTs: taskWindow.startTs,
      claimWindowEndTs: taskWindow.endTs,
      submissionDeadlineTs: taskWindow.endTs,
      claimLeaseTtlSeconds: Math.max(60, Math.floor((taskWindow.endTs - taskWindow.startTs) / 1000)),
      ...(requiredVerdictsOverride !== undefined
        ? { requiredVerdicts: requiredVerdictsOverride }
        : {}),
    };
    const taskDoc: TaskV1 = {
      schemaVersion: 'task.v1',
      id,
      solverType: taskKind,
      contractId,
      contractVersion,
      solverNetManifestCid,
      role: 'restoration',
      description,
      window: taskWindow,
      spec: ((overlay.spec as Record<string, unknown> | undefined) ?? {}) as TaskV1['spec'],
      eligibility: overlay.eligibility ?? {},
      claimPolicy,
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
      contractId,
      contractVersion,
      solverNetManifestCid,
      // The MechAdapter's `postTask` reads the on-chain claim policy from the
      // top-level `Task.claimPolicy`, falling back to a `maxClaims: 1` default
      // when absent — it does NOT derive it from `signedTask.claimPolicy`. The
      // object literal here bypasses `parseTask` (which would copy it across),
      // so set it explicitly or the `--max-claims` override is silently lost.
      claimPolicy,
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
        taskId: postResult.taskId,
        status: postResult.idempotent ? 'already_submitted' : 'submitted',
        attemptId: postResult.attemptId,
        attemptNumber: postResult.attemptNumber,
        idempotent: postResult.idempotent,
      },
      (v) => {
        const value = v as { id: string; taskId: string; creatorMultisig: string };
        return postResult.idempotent
          ? `Task already submitted.\nID: ${value.id}\nTask: ${value.taskId}\nSafe: ${value.creatorMultisig}`
          : `Task submitted.\nID: ${value.id}\nTask: ${value.taskId}\nSafe: ${value.creatorMultisig}`;
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
  --max-claims <n>    Number of on-chain attempt slots for the task (default 1).
                      The default single-slot policy is brittle on a shared
                      network: one non-delivering claimer permanently locks the
                      task. Pass a value > 1 (e.g. 5) to post a parallel
                      multi-attempt task so other operators can still claim.
  --required-verdicts <n>
                      Number of verdict claim slots per attempt (default 1).
                      A value > 1 lets an honest evaluator still claim and
                      deliver a verdict slot when others have been squatted —
                      the per-evaluator cap is 1, so no claimer can take them
                      all. Use on shared/adversarial networks.
  --spec-file <path>  Path to a JSON file containing typed task fields (window, spec, eligibility).
                      Supports registered SolverTypes: portfolio.v0, prediction.v1, prediction.apy.v0.

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
  jinn tasks submit --id eth-up --description "ETH direction" --solver-net prediction --spec-file fixtures/prediction-v1-task.example.json --yes
  jinn tasks submit --id usdc-apy --description "Aave APY" --solver-type prediction.apy.v0 --spec-file fixtures/prediction-apy-v0-intent.example.json --yes
`,
  run,
};

export default command;
