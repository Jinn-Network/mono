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
import {
  createCliExecutionContext,
  createCliReadOnlySignerContext,
  pickPrimaryMechService,
  type CliSignerContext,
} from '../execution-context.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';
import type { Task } from '../../types/task.js';
import { parseTaskV1, type TaskV1 } from '../../types/task-document.js';
import { SOLVER_TYPES, unknownSolverTypeMessage } from '../../solver-types/index.js';
import { signTaskV1 } from '../../tasks/signing.js';
import { TaskPostingService } from '../../tasks/posting-service.js';
import { readChainlinkLatest, scaleToDecimal } from '../../venues/chainlink/client.js';
import { walletPrivateKeyAtIndex } from '../../earning/wallet.js';
import { isOperationalServiceStep } from '../../earning/types.js';
import { getConfigPathFromArgs, loadConfig } from '../../config.js';
import {
  findJoinedByName,
  joinedDisplayName,
  solverTypeFromJoinedContract,
} from '../../solver-nets/registry.js';
import {
  TaskSubmitRequestV1Schema,
  TaskSubmitResultV1Schema,
  type TaskSubmitRequestV1,
} from '@jinn-network/sdk/autopilot';
import {
  assertMarketplaceTaskFunding,
  assertMarketplaceTaskRequestFreshness,
  resolveMarketplaceTaskSolverNet,
  runMarketplaceTaskSubmitPreflight,
} from '../../tasks/submit-preflight.js';
import {
  readMarketplaceTaskSelection,
  writeMarketplaceTaskSelection,
} from '../../tasks/submit-selection.js';
import { createHttpDiscoveryAPI } from '../../discovery/http.js';
import type { DiscoveryAPI } from '../../discovery/types.js';
import { fetchFromIpfs } from '../../adapters/mech/ipfs.js';
import { getJinnRouterAddress } from '../../contracts/addresses.js';
import {
  getMechDeliveryRate,
  getTimeoutBounds,
} from '../../adapters/mech/contracts.js';
import { runObserveAutopilotDelivery } from './tasks-observe-autopilot.js';
import { runTasksLifecycle } from './tasks-lifecycle.js';

function findNamedErrorCause(
  error: unknown,
  name: string,
): Record<string, unknown> | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (value['name'] === name) return value;
    current = value['cause'];
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null
      && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error);
}

function machinePreflightChecks(args: {
  ctx: CommandContext;
  config: ReturnType<typeof loadConfig>;
  manifestCid: string;
  signerContext: CliSignerContext;
}) {
  const signer = async () => args.signerContext;
  let launchedPromise: ReturnType<ReturnType<typeof createHttpDiscoveryAPI>['listLaunchedSolverNets']> | undefined;
  const launched = async () => {
    const discovery = args.config.discovery;
    if (discovery?.mode !== 'http' || !discovery.url) {
      throw new Error('HTTP discovery indexer must be configured for machine Task submission');
    }
    launchedPromise ??= createHttpDiscoveryAPI({
      url: discovery.url,
    }).listLaunchedSolverNets({ status: ['launched'] });
    return launchedPromise;
  };
  const primary = async () => {
    const built = await signer();
    const service = pickPrimaryMechService(built.fleetState.services);
    if (!service?.safe_address || !service.mech_address) {
      throw new Error('no operational creator Safe and Mech service is configured');
    }
    return service;
  };
  return {
    creator: async () => {
      await primary();
    },
    funds: async () => {
      const [built, service] = await Promise.all([signer(), primary()]);
      const agentAddress = privateKeyToAccount(
        walletPrivateKeyAtIndex(built.mnemonic, service.index),
      ).address;
      const [balance, agentBalance, deliveryRate] = await Promise.all([
        built.publicClient.getBalance({
          address: getAddress(service.safe_address!),
        }),
        built.publicClient.getBalance({ address: agentAddress }),
        getMechDeliveryRate(
          built.publicClient,
          getAddress(service.mech_address!),
        ),
      ]);
      assertMarketplaceTaskFunding({
        safeBalanceWei: balance,
        agentBalanceWei: agentBalance,
        solutionMaxDeliveryRateWei: deliveryRate,
        verdictMaxDeliveryRateWei: deliveryRate,
        maxClaims: 1,
        agentGasReserveWei: built.chainConfig.minEoaGasEth,
      });
    },
    rpc: async () => {
      const built = await signer();
      const [chainId] = await Promise.all([
        built.publicClient.getChainId(),
        built.publicClient.getBlockNumber(),
      ]);
      if (chainId !== built.chainConfig.chainId) {
        throw new Error(`RPC chain ${chainId} does not match configured chain ${built.chainConfig.chainId}`);
      }
    },
    contracts: async () => {
      const [built, service] = await Promise.all([signer(), primary()]);
      const router = (built.chainConfig.jinnRouter
        ?? getJinnRouterAddress(built.chainConfig.chainId)) as `0x${string}`;
      const [routerCode, mechCode] = await Promise.all([
        built.publicClient.getBytecode({ address: router }),
        built.publicClient.getBytecode({ address: getAddress(service.mech_address!) }),
        getTimeoutBounds(
          built.publicClient,
          built.chainConfig.mechMarketplace as `0x${string}`,
        ),
      ]);
      if (!routerCode || routerCode === '0x') throw new Error(`Router contract missing at ${router}`);
      if (!mechCode || mechCode === '0x') {
        throw new Error(`Mech contract missing at ${service.mech_address}`);
      }
    },
    indexer: async () => {
      await launched();
    },
    gateway: async () => {
      await fetchFromIpfs(args.config.ipfsGatewayUrl, args.manifestCid);
    },
    solverNet: async () => {
      const summaries = await launched();
      const target = summaries.find((entry) => entry.manifestCid === args.manifestCid);
      if (!target || target.status !== 'launched') {
        throw new Error(`SolverNet ${args.manifestCid} is not live`);
      }
      if (target.contractId !== 'jinn-repo' || target.contractVersion !== 'v1') {
        throw new Error(
          `SolverNet ${args.manifestCid} is not compatible with jinn-repo.v1`,
        );
      }
    },
  };
}

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
        'request-file': { type: 'string' },
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

  const requestFilePath = parsed.values['request-file'] as string | undefined;
  if (
    requestFilePath
    && (
      parsed.values.json !== true
      || parsed.values.human === true
    )
  ) {
    const field = parsed.values.human === true ? '--human' : '--json';
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: parsed.values.human === true
          ? '--human is not supported for request-file submission'
          : '--json is required for request-file submission',
        exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
        details: {
          field,
          expected: parsed.values.human === true
            ? 'omit --human'
            : '--json',
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const legacyLooseFlags = [
    'id', 'description', 'solver-net', 'solver-type', 'spec-file',
    'manifest-cid', 'max-claims', 'required-verdicts',
  ] as const;
  if (requestFilePath && legacyLooseFlags.some((flag) => parsed.values[flag] !== undefined)) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--request-file is mutually exclusive with legacy loose task flags',
        exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
        details: { field: '--request-file', expected: 'no legacy task flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;
  let machineRequest: TaskSubmitRequestV1 | undefined;
  let machineRequestFreshnessError: unknown;
  if (requestFilePath) {
    try {
      machineRequest = TaskSubmitRequestV1Schema.parse(
        JSON.parse(readFileSync(resolve(requestFilePath), 'utf8')),
      );
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Invalid request file: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
          details: { field: '--request-file' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    try {
      assertMarketplaceTaskRequestFreshness(machineRequest);
    } catch (err) {
      machineRequestFreshnessError = err;
    }
  }

  const id = machineRequest?.id ?? parsed.values.id as string | undefined;
  const description = machineRequest?.description ?? parsed.values.description as string | undefined;
  const requestedSolverNet = machineRequest?.solverNet ?? parsed.values['solver-net'] as string | undefined;
  const requestedSolverType = machineRequest?.solverType ?? parsed.values['solver-type'] as string | undefined;

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

  if (machineRequestFreshnessError && dryRun) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: errorMessage(machineRequestFreshnessError),
        exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
        details: { field: 'freshness' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  let frozenMachineSelection: ReturnType<typeof readMarketplaceTaskSelection> = null;
  if (machineRequest) {
    try {
      frozenMachineSelection = readMarketplaceTaskSelection({
        requestPath: requestFilePath!,
        request: machineRequest,
      });
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn tasks submit --request-file request.json --dry-run --json',
          details: { field: 'solverNetManifestCid' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    if (machineRequestFreshnessError && !frozenMachineSelection) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: errorMessage(machineRequestFreshnessError),
          hint: 'Create a fresh marketplace Task request before retrying.',
          exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
          details: {
            field: 'freshness',
            reason: 'policy_expired',
            cause: errorMessage(machineRequestFreshnessError),
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
  }

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
  // Issue #421: --solver-net resolves via joinedSolverNets (manifest-CID-keyed).
  // `findJoinedByName` matches against the joined display name or the
  // manifest CID — synthetic `legacy:<short-name>` keys (from on-disk
  // migrations) are reached by either branch.
  const matchedJoined = requestedSolverNet
    ? findJoinedByName(config.joinedSolverNets, requestedSolverNet)
    : undefined;
  const solverTypeFromNet = matchedJoined
    ? solverTypeFromJoinedContract(matchedJoined)
    : undefined;
  if (!machineRequest && requestedSolverNet && !solverTypeFromNet) {
    const available = Object.entries(config.joinedSolverNets ?? {})
      .map(([cid, entry]) => joinedDisplayName(cid, entry))
      .join('|');
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown SolverNet: ${requestedSolverNet}`,
        exampleCli: 'jinn solver-nets list',
        details: { field: '--solver-net', expected: available },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  let selectedMachineManifestCid: string | undefined;
  if (machineRequest) {
    try {
      selectedMachineManifestCid = frozenMachineSelection?.solverNetManifestCid
        ?? await resolveMarketplaceTaskSolverNet({
          config,
          explicitManifestCid: machineRequest.solverNetManifestCid,
          requestedName: machineRequest.solverNet,
        });
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn tasks submit --request-file request.json --dry-run --json',
          details: { field: 'solverNetManifestCid' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
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
    let service: { safe_address?: string | null } | undefined;
    let machineSignerContext: CliSignerContext | undefined;
    if (machineRequest) {
      const built = await createCliReadOnlySignerContext({ argv: ctx.argv, env: ctx.env });
      if (!built.ok) {
        emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
        return;
      }
      machineSignerContext = built.ctx;
      service = pickPrimaryMechService(built.ctx.fleetState.services);
    } else {
      const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
      service = raw.fleet?.services.find(s => isOperationalServiceStep(s.step));
    }
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
    if (machineRequest) {
      try {
        await runMarketplaceTaskSubmitPreflight(machinePreflightChecks({
          ctx,
          config,
          manifestCid: selectedMachineManifestCid!,
          signerContext: machineSignerContext!,
        }));
      } catch (err) {
        emitEnvelope(
          {
            code: 'transient_error',
            message: err instanceof Error ? err.message : String(err),
            hint: 'Resolve every failed machine Task submission dependency and retry the dry-run.',
            exampleCli: 'jinn tasks submit --request-file request.json --dry-run --json',
            details: { field: 'preflight' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
    }
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
          ...(selectedMachineManifestCid
            ? { solverNetManifestCid: selectedMachineManifestCid }
            : {}),
          ...(specOverlay ? { solverType: specOverlay.solverType, spec: specOverlay.spec } : {}),
        },
      ],
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;
  if (machineRequest) {
    try {
      writeMarketplaceTaskSelection({
        requestPath: requestFilePath!,
        request: machineRequest,
        solverNetManifestCid: selectedMachineManifestCid!,
        ...(machineRequest.solverNet ? { solverNetName: machineRequest.solverNet } : {}),
      });
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
          details: { field: '--request-file' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
  }

  const built = await createCliExecutionContext({ argv: ctx.argv, env: ctx.env });
  if (!built.ok) {
    if (machineRequestFreshnessError) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: errorMessage(machineRequestFreshnessError),
          hint: 'Create a fresh marketplace Task request before retrying.',
          exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
          details: {
            field: 'freshness',
            reason: 'policy_expired',
            cause: errorMessage(machineRequestFreshnessError),
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
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
    const overlay = machineRequest
      ? { solverType: machineRequest.solverType, window: machineRequest.window, spec: machineRequest.spec }
      : (specOverlay ?? {});
    const taskKind = overlay.solverType ?? requestedSolverType ?? solverTypeFromNet ?? 'prediction.v1';
    const taskWindow = overlay.window ?? { startTs: Date.now(), endTs: Date.now() + 86_400_000 };
    // Task 24 (spec/2026-05-05-solvernet-creation-and-launch.md §14): the
    // signed task must carry `solverNetManifestCid` so the on-chain digest
    // is `keccak256(manifestCid)`. Resolution order: explicit
    // --manifest-cid flag → joinedSolverNets[--solver-net].manifestCid.
    // Without one we refuse to submit; admin paths posting orphan tasks
    // need to supply a cid.
    const explicitManifestCid = selectedMachineManifestCid
      ?? parsed.values['manifest-cid'] as string | undefined;
    const joinedManifestCid = matchedJoined?.manifestCid;
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
    const claimPolicy: TaskV1['claimPolicy'] = machineRequest?.claimPolicy ?? {
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
    const taskDoc = parseTaskV1({
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
      createdAt: machineRequest?.createdAt ?? Date.now(),
    });
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
        sourceKey: machineRequest ? machineRequest.id : `manual:${id}`,
        postingPolicy: { kind: 'once_per_safe' },
        sourceMeta: {
          solverType: task.solverType,
          note: machineRequest ? 'machine' : 'manual',
          ...(machineRequest ? { request: machineRequest } : {}),
        },
      },
      {
        creatorSafeAddress: safe,
        ...(machineRequest && machineRequestFreshnessError
          ? { recoveryOnly: true }
          : {}),
        ...(machineRequest
          ? {
              beforeBroadcast: () =>
                assertMarketplaceTaskRequestFreshness(machineRequest),
            }
          : {}),
      },
    );
    const rawResult = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'tasks submit',
      id,
      creatorMultisig: getAddress(safe),
      taskId: postResult.taskId,
      taskCid: postResult.taskCid,
      creationTx: postResult.txHash,
      creationBlock: postResult.blockNumber,
      solverNetManifestCid,
      status: postResult.idempotent ? 'already_submitted' : 'submitted',
      attemptId: postResult.attemptId,
      attemptNumber: postResult.attemptNumber,
      idempotent: postResult.idempotent,
    };
    const result = machineRequest
      ? TaskSubmitResultV1Schema.parse(rawResult)
      : rawResult;
    emitResult(
      result,
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
    const policyExpiration = findNamedErrorCause(
      e,
      'MarketplaceTaskRequestExpiredError',
    );
    const recoveryOnly = findNamedErrorCause(e, 'TaskPostRecoveryOnlyError');
    const immutableMismatch = findNamedErrorCause(
      e,
      'TaskPostImmutableCandidateMismatchError',
    );
    if (
      policyExpiration
      || recoveryOnly
      || (machineRequestFreshnessError && immutableMismatch)
    ) {
      const freshnessError =
        policyExpiration
        ?? immutableMismatch
        ?? machineRequestFreshnessError
        ?? recoveryOnly;
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: errorMessage(freshnessError),
          hint: 'Create a fresh marketplace Task request before retrying.',
          exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
          details: {
            field: 'freshness',
            reason: 'policy_expired',
            cause: errorMessage(freshnessError),
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const broadcastUncertain = findNamedErrorCause(
      e,
      'TaskPostBroadcastUncertainError',
    );
    if (broadcastUncertain) {
      emitEnvelope(
        {
          code: 'transient_error',
          message: errorMessage(broadcastUncertain),
          hint:
            'Retry later to recover the exact TaskCreated event; this request will not broadcast again while its outcome is uncertain.',
          exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
          details: {
            reason: 'broadcast_uncertain',
            cause: errorMessage(broadcastUncertain),
            ...(typeof broadcastUncertain['broadcastIntentAt'] === 'string'
              ? { broadcastIntentAt: broadcastUncertain['broadcastIntentAt'] }
              : {}),
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const ownershipLost = findNamedErrorCause(e, 'TaskPostOwnershipLostError');
    const pendingTxHash =
      e && typeof e === 'object'
      && (
        (e as { name?: unknown }).name === 'PendingTaskSubmissionError'
        || (e as { name?: unknown }).name === 'SafePostBroadcastHookError'
      )
      && typeof (e as { txHash?: unknown }).txHash === 'string'
        ? (e as { txHash: string }).txHash
        : undefined;
    if (ownershipLost || pendingTxHash || isRecoverableTransactionError(e)) {
      emitEnvelope(
        {
          code: 'transient_error',
          message: e instanceof Error ? e.message : String(e),
          hint: ownershipLost
            ? 'Retry after the competing Task submission owner finishes or its lease expires.'
            : pendingTxHash
              ? 'Retry to reconcile this exact submitted transaction; a new Safe transaction will not be broadcast while it remains pending.'
              : 'Retry when the RPC endpoint is healthy or fees clear.',
          exampleCli: machineRequest
            ? 'jinn tasks submit --request-file request.json --yes --json'
            : 'jinn tasks submit --id my-task --description "..." --yes',
          details: {
            cause: e instanceof Error ? e.message : String(e),
            ...(ownershipLost ? { reason: 'ownership_lost' } : {}),
            ...(pendingTxHash ? { txHash: pendingTxHash } : {}),
          },
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

// ── tasks watch ───────────────────────────────────────────────────────────────

/**
 * NDJSON progress envelope emitted while `jinn tasks watch` waits. Mirrors the
 * stable shape `jinn quickstart` emits (`QuickstartProgressEnvelope` in
 * quickstart.ts) so an agent parses waiting the same way everywhere — the only
 * difference is the phase, which is always `watch` here.
 */
export interface TasksWatchProgressEnvelope {
  type: 'progress';
  phase: 'watch';
  step: string;
  attempt?: number;
  estimatedWaitMs?: number;
}

export interface TasksWatchDeps {
  createDiscovery: (url: string) => Pick<DiscoveryAPI, 'getAutopilotDeliveryCandidates'>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_WATCH_DEPS: TasksWatchDeps = {
  createDiscovery: (url: string) => createHttpDiscoveryAPI({ url }),
  sleep: (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
};

const DEFAULT_WATCH_TIMEOUT_SECONDS = 900;
const WATCH_EXAMPLE = 'jinn tasks watch 42 --timeout 600';

/**
 * Poll discovery until the task's solution delivery is indexed.
 *
 * Terminal states: `delivered` (carries the envelope CID) and `timeout`. Both
 * exit 0 — the `status` field carries the outcome. An indexer contradiction
 * stops the poll and emits a transient_error envelope: re-polling cannot
 * resolve inconsistent rows.
 *
 * Read-only: config-only, no keystore, no signer, no daemon.
 */
export async function runTasksWatch(
  ctx: CommandContext,
  deps: TasksWatchDeps = DEFAULT_WATCH_DEPS,
): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        timeout: { type: 'string' as const },
      },
      allowPositionals: true,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: WATCH_EXAMPLE,
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const taskId = parsed.positionals[0];
  if (!taskId) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'A task id is required',
        exampleCli: WATCH_EXAMPLE,
        details: { field: '<id>', expected: 'on-chain task id (decimal string)' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const rawTimeout = parsed.values.timeout as string | undefined;
  let timeoutSeconds = DEFAULT_WATCH_TIMEOUT_SECONDS;
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `--timeout must be a positive number of seconds, got '${rawTimeout}'`,
          exampleCli: WATCH_EXAMPLE,
          details: { field: '--timeout', expected: 'positive number (seconds)' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    timeoutSeconds = n;
  }

  const config = loadConfig(getConfigPathFromArgs(ctx.argv));
  if (config.discovery?.mode !== 'http' || !config.discovery.url) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message:
          'An HTTP discovery indexer is required to watch a task, but '
          + `discovery.mode is '${config.discovery?.mode ?? 'unset'}'`
          + (config.discovery?.mode === 'http' ? ' with no discovery.url' : '')
          + '.',
        hint:
          'Set `discovery.mode: "http"` and `discovery.url: "<indexer url>"` in '
          + '~/.jinn-client/config.json (or export JINN_DISCOVERY_MODE=http and '
          + 'JINN_DISCOVERY_URL=<indexer url>). The on-chain floor cannot resolve '
          + 'a task id to a delivery, so this verb does not fall back to it.',
        exampleCli: WATCH_EXAMPLE,
        details: {
          field: 'discovery.mode',
          expected: 'http',
          actual: config.discovery?.mode ?? null,
          configKeys: ['discovery.mode', 'discovery.url'],
          envVars: ['JINN_DISCOVERY_MODE', 'JINN_DISCOVERY_URL'],
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const human = Boolean(parsed.values.human);
  const emitProgress = (envelope: TasksWatchProgressEnvelope): void => {
    ctx.writer.write(
      human
        ? `[watch] ${envelope.step}${envelope.attempt ? ` (attempt ${envelope.attempt})` : ''}\n`
        : JSON.stringify(envelope) + '\n',
    );
  };

  const chainId = config.network === 'testnet' ? 84532 : 8453;
  const pollIntervalMs = Math.max(250, config.pollIntervalMs);
  const discovery = deps.createDiscovery(config.discovery.url);
  const startedAt = deps.now();
  const deadline = startedAt + timeoutSeconds * 1000;

  let attempt = 0;
  let lastReason: string | undefined;
  for (;;) {
    attempt += 1;
    emitProgress({
      type: 'progress',
      phase: 'watch',
      step: 'polling_discovery',
      attempt,
      estimatedWaitMs: Math.max(0, deadline - deps.now()),
    });

    let lookup;
    try {
      lookup = await discovery.getAutopilotDeliveryCandidates({
        chainId,
        taskId,
        role: 'solution',
      });
    } catch (err) {
      emitEnvelope(
        {
          code: 'transient_error',
          message: `Discovery lookup failed for task ${taskId}: ${errorMessage(err)}`,
          hint: 'Retry when the discovery indexer is reachable.',
          exampleCli: WATCH_EXAMPLE,
          details: { taskId, chainId, attempt },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    if (lookup.status === 'ready') {
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'tasks watch',
          taskId,
          role: 'solution',
          status: 'delivered',
          envelopeCid: lookup.envelope.manifestCid,
          publisherAgentId: lookup.envelope.publisherAgentId,
          requestId: lookup.attempt.requestId,
          operator: lookup.attempt.operator,
          attempts: attempt,
          waitedMs: deps.now() - startedAt,
        },
        (v) => {
          const value = v as { taskId: string; envelopeCid: string };
          return `Task ${value.taskId} delivered.\nEnvelope: ${value.envelopeCid}`;
        },
        {
          json: Boolean(parsed.values.json),
          human,
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
      return;
    }

    if (lookup.status === 'contradiction') {
      emitEnvelope(
        {
          code: 'transient_error',
          message: `The indexer holds inconsistent rows for task ${taskId}: ${lookup.reason}`,
          hint: 'Re-polling cannot resolve a contradiction; inspect the indexer rows for this task.',
          exampleCli: WATCH_EXAMPLE,
          details: { taskId, reason: lookup.reason, attempt },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    lastReason = lookup.reason;
    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) {
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'tasks watch',
          taskId,
          role: 'solution',
          status: 'timeout',
          attempts: attempt,
          waitedMs: deps.now() - startedAt,
          lastReason,
        },
        (v) => {
          const value = v as { taskId: string; lastReason?: string };
          return `Task ${value.taskId} not delivered before the timeout (last state: ${value.lastReason}).`;
        },
        {
          json: Boolean(parsed.values.json),
          human,
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
      return;
    }

    const waitMs = Math.min(pollIntervalMs, remainingMs);
    emitProgress({
      type: 'progress',
      phase: 'watch',
      step: `awaiting_delivery:${lastReason}`,
      attempt,
      estimatedWaitMs: waitMs,
    });
    await deps.sleep(waitMs);
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
  if (subverb === 'observe-autopilot-delivery') {
    return runObserveAutopilotDelivery({ ...ctx, argv: rest });
  }
  if (subverb === 'watch') {
    return runTasksWatch({ ...ctx, argv: rest });
  }
  if (subverb === 'close' || subverb === 'cancel' || subverb === 'release') {
    return runTasksLifecycle({ ...ctx, argv: rest }, subverb);
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
      details: {
        field: 'subverb',
        expected: 'submit|watch|observe-autopilot-delivery|list|show|close|cancel|release',
      },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'tasks',
  summary: 'Submit and inspect Tasks',
  helpText: `Usage:
  jinn tasks submit --id <id> --description <text> (--solver-net <name> | --solver-type <type>) [--spec-file <path>] [--dry-run] [--yes] [--human]
  jinn tasks submit --request-file <path> [--dry-run] --yes --json
  jinn tasks watch <id> [--timeout <seconds>] [--json|--human]
  jinn tasks observe-autopilot-delivery --expectation-file <path> --json
  jinn tasks list
  jinn tasks show <id>
  jinn tasks close --task-id <id>
  jinn tasks cancel --attempt <urn:uuid> --reason <text>
  jinn tasks release --task-id <id> --attempt-index <n>

\`close\`, \`cancel\`, and \`release\` are the requester lifecycle exits (native mode).
\`close\` reclaims a posted task's unused budget; \`cancel\` persists a durable
cancel signal for one in-flight attempt; \`release\` returns a claimed-but-unworked
attempt to the pool (reported \`unsupported\` on chain generations with no on-chain
release). Each requires JINN_PASSWORD to open the venue custody.

\`watch\` polls the discovery indexer until the task's solution delivery is
indexed, emitting NDJSON progress envelopes (type/phase/step/attempt/
estimatedWaitMs) so waiting is legible rather than silent. Terminal states are
\`delivered\` (carrying envelopeCid) and \`timeout\`; both exit 0 and carry the
outcome in \`status\`. Feed the envelopeCid to \`jinn evidence show\`.

\`watch\` is read-only (config-only; no keystore, signer, or daemon) and needs
\`discovery.mode: "http"\` with a \`discovery.url\` — env: JINN_DISCOVERY_MODE=http,
JINN_DISCOVERY_URL=<indexer url>. It never falls back to the on-chain floor.

Idempotent: re-posting the same (--id) from the same creator Safe returns the
existing request id from the shared task-posting store without sending a new
transaction.

Options:
  --timeout <seconds> (watch) How long to poll before returning status
                      'timeout'. Default 900. Poll interval follows
                      pollIntervalMs from config.
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
  jinn tasks watch 42 --timeout 600 --json
`,
  run,
};

export default command;
