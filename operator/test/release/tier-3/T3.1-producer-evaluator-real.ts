/**
 * T3.1 — producer/evaluator against the REAL deployed Base Sepolia stack.
 *
 * Scenario contract (release-readiness Tier 3 — the load-bearing real-network
 * gate): a producer operator posts a `swe-rebench-v2.v1` Task on real Base
 * Sepolia; its daemon (or a peer's) claims, solves, and delivers a Solution
 * on-chain; an evaluator operator's daemon claims the evaluation request, runs
 * the real evaluator, and settles a Verdict on-chain. Assert the on-chain
 * Verdict code against the known-instance expectation.
 *
 * Why this is NOT an HTTP-endpoint scenario (resolves GH issue #526)
 * -----------------------------------------------------------------
 * The first cut of T3.1 assumed an HTTP task-control plane — `POST /v1/tasks`,
 * `GET /v1/tasks/:id`, `GET /v1/verdicts`. None of those exist, and none
 * should: Jinn is an on-chain protocol. This is the *same* bug T2.2 already
 * hit (GH #350). Tasks enter via a `createTask` tx on the JinnRouter; solving,
 * delivery, evaluation and verdicts are all driven by daemon loops reacting to
 * on-chain events; verdicts settle on-chain. The real interface for posting a
 * task is `jinn tasks submit`, which posts from a bootstrapped service Safe.
 *
 * How this drives the real loop
 * -----------------------------
 *   1. `setupTier3Scenario` spawns the two production substrate daemons —
 *      op-a and op-b — from their gold homes (`~/jinn-dev/operators/op-a`,
 *      `op-b`) against the real deployed Base Sepolia contracts. Unlike T2.2
 *      (which needs a *fresh fork* V3 router and therefore cannot use the
 *      substrate daemons), T3.1 WANTS the real deployed testnet contracts —
 *      so the substrate daemons are exactly right here.
 *   2. The Task is posted the real way: `node dist/bin/jinn.js tasks submit`
 *      invoked with `HOME` pointed at op-a's substrate, so it posts from
 *      op-a's bootstrapped service Safe. `--solver-type swe-rebench-v2.v1`,
 *      `--manifest-cid <SWE-rebench v2 manifest cid>`, `--spec-file` carrying
 *      the known-solvable instance from `../tier-2/fixtures/known-instance.ts`.
 *      The submit prints the on-chain numeric `taskId` (decoded from the
 *      `TaskCreated` event by the posting path).
 *   3. Delivery + verdict are observed ON-CHAIN: the JinnRouter emits
 *      `SolutionDeliveryClaimed` and `VerdictDeliveryClaimed` events, both
 *      indexed by `taskId`. `VerdictDeliveryClaimed` carries the authoritative
 *      `verdictCode` (uint8). Polling these via `getLogs` is the reliable
 *      signal that op-a delivered a Solution and an evaluator settled a
 *      Verdict — independent of any daemon-local mirror.
 *   4. Assert the on-chain `verdictCode` against `KNOWN_EXPECTED_VERDICT`.
 *   5. The cost-cap audit is preserved: it reads each daemon's `/v1/status`
 *      and is fail-safe — if no daemon reports a spend we cannot verify the
 *      cap held, so we FAIL rather than treat an unverifiable run as a pass.
 *
 * Resolves: https://github.com/Jinn-Network/mono/issues/526
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  type Hex,
  type Log,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  isDailyDriverRunning,
  setupTier3Scenario,
  resolveGoldDaemonHome,
  tierOpNames,
  type Tier3Handle,
} from './tier-3-helpers.js';
import {
  classifyFailure,
  type ScenarioVerdict,
  type ScenarioOptions,
} from '../../../scripts/release/scenario-types.js';
import { getChainConfig } from '../../../src/earning/contracts.js';
import { JINN_ROUTER_ABI } from '../../../src/adapters/mech/types.js';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
  KNOWN_COMMIT,
  KNOWN_EXPECTED_VERDICT,
  KNOWN_T31_ISOLATED_MANIFEST_CID,
} from '../tier-2/fixtures/known-instance.js';

// ── Constants ────────────────────────────────────────────────────────────────

const COST_CAP_USD = 0.25;
// 25 min. A real SWE-rebench v2 loop on Base Sepolia spends ~4.5-6 min on the
// solve leg alone, then a multi-minute Docker verdict eval before the verdict
// settles on-chain. The original 10 min could not fit the verdict leg on any
// observed run (3/3 timed out mid-evaluation). T2.2's fork wrapper already
// budgets 18 min; Tier 3 adds real-network latency + the Docker eval.
const WALL_CLOCK_BUDGET_MS = 25 * 60 * 1000;

/** Base Sepolia chain id — the network the substrate daemons are pinned to. */
const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * On-chain attempt slots the Task is posted with. A single-slot task is
 * brittle on a shared testnet — see the `--max-claims` note at the submit
 * call site. Five matches the SWE-rebench v2 auto-generator's policy.
 */
const MAX_CLAIMS = 5;

/**
 * On-chain verdict claim slots per attempt. The default of 1 is brittle on
 * the shared Base Sepolia testnet: an external operator squats every verdict
 * slot within ~2 blocks of a solution being submitted and never delivers,
 * permanently locking the verdict leg (observed on tasks 183-189). With
 * `requiredVerdicts: 3` and the protocol's per-evaluator cap of 1, a
 * controlled substrate operator can always claim and deliver one of the
 * remaining slots even when the squatter takes one — so a real verdict
 * settles on-chain regardless of the race.
 */
const REQUIRED_VERDICTS = 3;

/**
 * `getLogs` block-range chunk. The public Base Sepolia RPCs cap `eth_getLogs`
 * at a 2000-block range; 1999 keeps a single chunk inside that cap.
 */
const GETLOGS_CHUNK_BLOCKS = 1_999n;

/**
 * The orchestrator polls a SINGLE configured RPC (no fallback chain like the
 * daemon), and the public Base Sepolia gateways intermittently return a
 * spurious `eth_getLogs` "invalid params" / 429 / 5xx even for a well-formed
 * request (reproduced: the exact failing call succeeds 6/6 on retry). A single
 * such hiccup on the first observe poll otherwise aborts the entire 25-min
 * gate. Retry transient getLogs failures a few times before surfacing.
 */
const GETLOGS_RETRY_ATTEMPTS = 4;
const GETLOGS_RETRY_BASE_MS = 800;

/** Default ports the two Tier-3 daemons bind (portBase, portBase+1). */
const PORT_BASE = 7360;

interface ScenarioOptionsT3 extends ScenarioOptions {
  mode?: 'human-invoked' | 'autonomous';
  hermesModel?: string;
}

export function buildT31DaemonEnv(args: {
  hermesModel: string;
  onchainTaskId: string;
}): NodeJS.ProcessEnv {
  return {
    JINN_HERMES_MODEL: args.hermesModel,
    JINN_TIER3_COST_CAP_USD: COST_CAP_USD.toString(),
    JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS: args.onchainTaskId,
  };
}

// ── Generic poll helper ──────────────────────────────────────────────────────

async function waitFor<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 5000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitFor${opts.label ? ` (${opts.label})` : ''} timed out after ${opts.timeoutMs}ms`,
  );
}

// ── jinn tasks submit (the real on-chain post path) ──────────────────────────

interface SubmitResult {
  /** On-chain numeric taskId, decoded from the TaskCreated event by the CLI. */
  taskId: string;
  /** True when the post was idempotent (task already on-chain from a prior run). */
  idempotent: boolean;
  raw: Record<string, unknown>;
}

/**
 * Post a `swe-rebench-v2.v1` Task on real Base Sepolia by invoking the real
 * `jinn tasks submit` CLI verb with `HOME` rooted at op-a's substrate, so the
 * post is signed and paid by op-a's bootstrapped service Safe.
 *
 * `JINN_PASSWORD` is deliberately stripped from the child env: each substrate
 * carries its own `~/.jinn-client/keystore-password` file, and an inherited
 * `JINN_PASSWORD` (e.g. from a sourced `operator/.env`) would override that file
 * and fail keystore decryption. This mirrors the same fix made to the daemon
 * spawn helper (`multi-op-daemon.ts`, commit fed6c340).
 */
async function submitSweRebenchTask(args: {
  jinnBin: string;
  opAHome: string;
  specFilePath: string;
  taskId: string;
  log: (msg: string) => void;
}): Promise<SubmitResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: args.opAHome };
  delete childEnv['JINN_PASSWORD'];

  const cliArgs = [
    args.jinnBin,
    'tasks',
    'submit',
    '--id',
    args.taskId,
    '--description',
    `T3.1 release-readiness: SWE-rebench v2 instance ${KNOWN_INSTANCE_ID}`,
    '--solver-type',
    'swe-rebench-v2.v1',
    // Mainline SWE-rebench v2 SolverNet (2026-05-23). Previously this used a
    // separate "isolated" SolverNet that the on-chain griefer wasn't joined
    // to, because `requiredVerdicts: 1` made a single squatted verdict slot
    // a permanent task lock. With `--required-verdicts 3` and the protocol's
    // per-evaluator cap of 1, the griefer can take at most one slot — a
    // controlled evaluator (op-a) always lands one of the remaining slots.
    //
    // T3.1 posts to the ISOLATED SolverNet (KNOWN_T31_ISOLATED_MANIFEST_CID),
    // restoring `ca11be24` after `77e79635` moved it to the shared mainline.
    // The mainline switch assumed maxClaims:5/requiredVerdicts:3 alone tamed
    // the griefer; in practice the shared net is now both griefed (0x26e96ba6…)
    // AND backlogged (~1300 tasks ahead of each fresh post), and discovery is
    // lowest-taskId-first, so a freshly-posted task is buried behind the
    // backlog and never reached inside the wall-clock budget (observed: task
    // 1537 never solved in 25 min). The isolated net — op-a evaluator / op-b
    // solver, griefer not joined, generatorEnabled:false so no noise tasks —
    // closes the loop deterministically (proven green: task 209, 5m51s).
    '--manifest-cid',
    KNOWN_T31_ISOLATED_MANIFEST_CID,
    '--spec-file',
    args.specFilePath,
    // Post a 5-slot parallel task, not the default single-attempt task. A
    // `maxClaims: 1` task on the shared Base Sepolia testnet is structurally
    // fragile: whoever wins the one solution claim also holds the one verdict
    // slot (`requiredVerdicts: 1`), and a claimer that never delivers a verdict
    // permanently dead-locks the task — no other operator can ever get an
    // attempt. This is exactly what happened to T3.1 on-chain tasks 183-186
    // (an external operator squatted every verdict slot). Five slots — matching
    // the SWE-rebench v2 auto-generator's policy — let a controlled substrate
    // operator (op-a, which is also the creator; testnet permits
    // self-evaluation) take its own attempt, solve it, and grade it, closing
    // the verdict leg deterministically regardless of other claimers.
    '--max-claims',
    String(MAX_CLAIMS),
    // Open multiple verdict slots per attempt so a squatted slot cannot lock
    // the verdict leg — see the REQUIRED_VERDICTS constant note.
    '--required-verdicts',
    String(REQUIRED_VERDICTS),
    '--yes',
    '--json',
  ];

  return new Promise<SubmitResult>((resolve, reject) => {
    const proc = spawn('node', cliArgs, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.once('error', reject);
    proc.once('exit', (code) => {
      const tail = (s: string): string => s.trim().split('\n').slice(-8).join('\n');
      if (code !== 0) {
        reject(
          new Error(
            `jinn tasks submit exited ${code}. stderr:\n${tail(stderr)}\nstdout:\n${tail(stdout)}`,
          ),
        );
        return;
      }
      // The CLI prints exactly one JSON object on stdout in --json mode.
      let parsed: Record<string, unknown> | undefined;
      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // not the JSON line — keep scanning
        }
      }
      if (!parsed) {
        reject(
          new Error(
            `jinn tasks submit produced no parseable JSON. stdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
          ),
        );
        return;
      }
      // An error envelope is also JSON — surface it as a failure.
      if (typeof parsed['code'] === 'string' && parsed['taskId'] === undefined) {
        reject(
          new Error(
            `jinn tasks submit returned an error envelope: ${parsed['code']} — ${String(parsed['message'] ?? '')}`,
          ),
        );
        return;
      }
      const onchainTaskId = parsed['taskId'];
      if (typeof onchainTaskId !== 'string' || onchainTaskId.length === 0) {
        reject(
          new Error(
            `jinn tasks submit JSON has no taskId: ${JSON.stringify(parsed)}`,
          ),
        );
        return;
      }
      args.log(
        `   submit ok: on-chain taskId=${onchainTaskId} status=${String(parsed['status'])}`,
      );
      resolve({
        taskId: onchainTaskId,
        idempotent: parsed['idempotent'] === true,
        raw: parsed,
      });
    });
  });
}

// ── On-chain observation (JinnRouter event reads) ────────────────────────────

interface SolutionDelivery {
  taskId: string;
  operator: string;
  requestId: string;
  txHash: string;
  blockNumber: number;
}

interface VerdictDelivery {
  taskId: string;
  evaluator: string;
  requestId: string;
  verdictCode: number;
  txHash: string;
  blockNumber: number;
}

type RouterPublicClient = ReturnType<typeof createPublicClient>;

/**
 * Scan JinnRouter logs in `eth_getLogs`-safe chunks for events matching
 * `eventName`, decoding each via `JINN_ROUTER_ABI`. Returns the decoded events
 * paired with their source log so callers can read `taskId`, tx hash, etc.
 */
async function scanRouterEvents<T>(args: {
  client: RouterPublicClient;
  routerAddress: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  pick: (eventName: string, evArgs: Record<string, unknown>, log: Log) => T | null;
}): Promise<T[]> {
  const out: T[] = [];
  for (
    let start = args.fromBlock;
    start <= args.toBlock;
    start += GETLOGS_CHUNK_BLOCKS + 1n
  ) {
    const end =
      start + GETLOGS_CHUNK_BLOCKS > args.toBlock
        ? args.toBlock
        : start + GETLOGS_CHUNK_BLOCKS;
    let logs: Log[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        logs = await args.client.getLogs({
          address: args.routerAddress,
          fromBlock: start,
          toBlock: end,
        });
        break;
      } catch (err) {
        if (attempt >= GETLOGS_RETRY_ATTEMPTS) throw err;
        // Transient RPC hiccup (invalid params / 429 / 5xx on a healthy query).
        await new Promise((r) => setTimeout(r, GETLOGS_RETRY_BASE_MS * attempt));
      }
    }
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: JINN_ROUTER_ABI,
          data: log.data,
          topics: log.topics,
        });
        const picked = args.pick(
          decoded.eventName,
          decoded.args as Record<string, unknown>,
          log,
        );
        if (picked !== null) out.push(picked);
      } catch {
        // Not a JinnRouter event we recognise — skip.
      }
    }
  }
  return out;
}

interface TaskCreatedOrigin {
  blockNumber: bigint;
  txHash: Hex;
}

/**
 * Find the `TaskCreated` event for `taskId` — its origin block and the tx hash
 * that posted it — or null if it has not been observed in `[fromBlock, head]`.
 *
 * The origin block anchors the Solution / Verdict scans at the task's true
 * start (robust whether the task is brand-new or already on-chain). The tx
 * hash lets the cost-cap audit read the post tx receipt's real ETH gas spend.
 */
async function findTaskCreated(args: {
  client: RouterPublicClient;
  routerAddress: Hex;
  fromBlock: bigint;
  taskId: string;
}): Promise<TaskCreatedOrigin | null> {
  const toBlock = await args.client.getBlockNumber();
  const matches = await scanRouterEvents<TaskCreatedOrigin>({
    client: args.client,
    routerAddress: args.routerAddress,
    fromBlock: args.fromBlock,
    toBlock,
    pick: (eventName, evArgs, log) => {
      if (eventName !== 'TaskCreated') return null;
      if (String(evArgs['taskId']) !== args.taskId) return null;
      return {
        blockNumber: log.blockNumber ?? 0n,
        txHash: (log.transactionHash ?? '0x') as Hex,
      };
    },
  });
  return matches.length > 0 ? matches[0]! : null;
}

/** Find the first `SolutionDeliveryClaimed` event for `taskId`, or null. */
async function findSolutionDelivery(args: {
  client: RouterPublicClient;
  routerAddress: Hex;
  fromBlock: bigint;
  taskId: string;
}): Promise<SolutionDelivery | null> {
  const toBlock = await args.client.getBlockNumber();
  const matches = await scanRouterEvents<SolutionDelivery>({
    client: args.client,
    routerAddress: args.routerAddress,
    fromBlock: args.fromBlock,
    toBlock,
    pick: (eventName, evArgs, log) => {
      if (eventName !== 'SolutionDeliveryClaimed') return null;
      if (String(evArgs['taskId']) !== args.taskId) return null;
      return {
        taskId: args.taskId,
        operator: String(evArgs['operator']).toLowerCase(),
        requestId: String(evArgs['requestId']),
        txHash: log.transactionHash ?? '',
        blockNumber: Number(log.blockNumber ?? 0n),
      };
    },
  });
  return matches[0] ?? null;
}

/**
 * Find all `VerdictDeliveryClaimed` events for `taskId`, oldest-first.
 *
 * The Task is posted with `maxClaims > 1` (see the submit call site): several
 * operators can each take their own attempt, so a single task can produce
 * multiple settled verdicts. The scenario needs the full set so it can pick
 * the verdict that proves the loop closed correctly — a passing verdict for a
 * known-solvable instance — rather than blindly asserting whichever verdict a
 * `getLogs` pass happened to surface first (which might be a failing attempt
 * by a different operator).
 */
async function findVerdictDeliveries(args: {
  client: RouterPublicClient;
  routerAddress: Hex;
  fromBlock: bigint;
  taskId: string;
}): Promise<VerdictDelivery[]> {
  const toBlock = await args.client.getBlockNumber();
  const matches = await scanRouterEvents<VerdictDelivery>({
    client: args.client,
    routerAddress: args.routerAddress,
    fromBlock: args.fromBlock,
    toBlock,
    pick: (eventName, evArgs, log) => {
      if (eventName !== 'VerdictDeliveryClaimed') return null;
      if (String(evArgs['taskId']) !== args.taskId) return null;
      return {
        taskId: args.taskId,
        evaluator: String(evArgs['evaluator']).toLowerCase(),
        requestId: String(evArgs['requestId']),
        verdictCode: Number(evArgs['verdictCode']),
        txHash: log.transactionHash ?? '',
        blockNumber: Number(log.blockNumber ?? 0n),
      };
    },
  });
  // Oldest-first by block — `scanRouterEvents` walks blocks ascending.
  return matches;
}

// ── Cost-cap audit (post-hoc, fail-safe) ─────────────────────────────────────

/**
 * Conservative ETH/USD rate for converting the on-chain gas spend into the
 * dollar figure the cost cap is denominated in. Deliberately a high estimate
 * — overstating the spend can only make the audit *stricter*, never looser, so
 * a stale rate cannot let an over-budget run slip through.
 */
const ETH_USD_RATE = 5_000;

/**
 * The cost-cap audit's verifiable signal: the real ETH gas spent posting the
 * Task on-chain, read from the `createTask` tx receipt (`gasUsed ×
 * effectiveGasPrice`) and converted to USD at a conservative rate.
 *
 * This is the one cost dimension that is *always* observable on a real-network
 * run — the post tx receipt is on-chain. The LLM/OpenRouter spend that makes
 * up the bulk of the ~$0.10–0.25 budget is NOT surfaced by the daemon on any
 * queryable channel today (`evaluator_cost_usd` in the verdict envelope is
 * stubbed to 0; `JINN_TIER3_COST_CAP_USD` has no in-daemon consumer). The
 * audit therefore reports what it CAN verify and stays fail-safe on it: if the
 * post tx receipt cannot be read, the cost is unverifiable and the caller
 * FAILs rather than treating an unverifiable run as a pass.
 */
async function readPostTxCostUsd(args: {
  client: RouterPublicClient;
  txHash: Hex;
}): Promise<number | undefined> {
  try {
    const receipt = await args.client.getTransactionReceipt({
      hash: args.txHash,
    });
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.effectiveGasPrice;
    if (gasUsed === undefined || gasPrice === undefined) return undefined;
    const weiSpent = gasUsed * gasPrice;
    // wei → ETH → USD. Done in floating point: the magnitudes here (sub-cent)
    // are far inside Number's safe range.
    const ethSpent = Number(weiSpent) / 1e18;
    return ethSpent * ETH_USD_RATE;
  } catch {
    return undefined;
  }
}

// ── Scenario entry point ─────────────────────────────────────────────────────

export async function runT31ProducerEvaluatorReal(
  opts: ScenarioOptionsT3,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string): void => {
    evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  let handle: Tier3Handle | null = null;
  let specFilePath: string | null = null;
  let specDir: string | null = null;
  const hermesModel = opts.hermesModel ?? 'deepseek/deepseek-v4-flash';
  const budgetMs = opts.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS;
  // Reserve a slice of the budget for setup + teardown so the on-chain polls
  // do not consume the entire window and leave nothing for cleanup.
  const setupReserveMs = 90 * 1000;

  try {
    const mode = opts.mode ?? 'human-invoked';
    const { producer: producerOp, solver: solverOp } = tierOpNames();
    log(
      `1. prepare Tier 3 task (mode=${mode}, hermesModel=${hermesModel}, budgetMs=${budgetMs})`,
    );
    if (await isDailyDriverRunning()) {
      throw new Error(
        mode === 'autonomous'
          ? 'daily driver appears to be running on one of the substrate-shared ports. Autonomous mode refuses to post a task it cannot safely process.'
          : 'daily driver is running on a substrate-shared port. Stop it before invoking Tier 3 so the fresh task is not orphaned.',
      );
    }

    // ── Resolve the deployed JinnRouter for the on-chain observation reads ────
    const chainCfg = getChainConfig('base-sepolia');
    const routerAddress = chainCfg.jinnRouter;
    if (!routerAddress) {
      throw new Error(
        'getChainConfig("base-sepolia") returned no jinnRouter address — cannot observe the on-chain loop',
      );
    }
    // Multi-RPC fallback chain. The orchestrator polls a single RPC for up to
    // ~23 minutes; a transient DNS/network blip on one provider (observed:
    // `getaddrinfo ENOTFOUND base-sepolia.gateway.tenderly.co`, which aborted
    // the gate with flake-infra mid-observe) must fall through to a healthy
    // provider rather than kill the whole run. The daemon already runs a
    // fallback chain (config.ts §RPC fallback chain); the gate observer was the
    // last single-RPC consumer. `rank: false` preserves operator slot order so
    // a configured paid key stays primary. The public no-auth endpoints are
    // always appended as last-resort backups.
    const PUBLIC_BACKUP_RPCS = [
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ];
    const rpcUrls = [
      ...(opts.rpcUrl ? [opts.rpcUrl] : []),
      ...(process.env['BASE_SEPOLIA_RPC_URL']?.split(',') ?? []),
      ...(process.env['JINN_RPC_URL']?.split(',') ?? []),
      ...PUBLIC_BACKUP_RPCS,
    ]
      .map((u) => u.trim())
      .filter(Boolean);
    const uniqueRpcUrls = [...new Set(rpcUrls)];
    const client = createPublicClient({
      chain: baseSepolia,
      transport: fallback(
        uniqueRpcUrls.map((u) => http(u)),
        { rank: false },
      ),
    });
    const chainId = await client.getChainId();
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      throw new Error(
        `RPC chain mismatch: expected Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}), got ${chainId}`,
      );
    }
    // Record the head just before posting. The Solution / Verdict scans are
    // anchored at the task's *own* `TaskCreated` block (resolved below via
    // `findTaskCreatedBlock`), but `prePostBlock` bounds that lookup so it
    // never walks the whole chain.
    const prePostBlock = await client.getBlockNumber();
    log(`   JinnRouter=${routerAddress} chainId=${chainId} prePostBlock=${prePostBlock}`);

    // ── Step 2: post the swe-rebench-v2 Task on real Base Sepolia ─────────────
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T3.1-spec-'));
    specFilePath = path.join(specDir, 'swe-rebench-v2-task.json');
    // `jinn tasks submit` validates the spec-file against SweRebenchV2TaskSchema
    // by spreading the file's top-level fields into the parser input — so the
    // schema fields live at the top level of the file, not under `spec`.
    const nowSec = Math.floor(Date.now() / 1000);
    const specDoc = {
      schemaVersion: 'swe-rebench-v2.v1',
      solverType: 'swe-rebench-v2.v1',
      instance_id: KNOWN_INSTANCE_ID,
      repo: KNOWN_REPO,
      base_commit: KNOWN_COMMIT,
      language: 'python',
      problem_statement: `SWE-rebench v2 instance: ${KNOWN_INSTANCE_ID}`,
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2025_01',
      // Generous deadline so the claim/solve/deliver/evaluate loop has the full
      // wall-clock budget without the on-chain submission deadline expiring.
      deadline_unix: nowSec + 60 * 60,
      round_month: '2025-01',
    };
    await fs.writeFile(specFilePath, JSON.stringify(specDoc, null, 2));

    const jinnBin = fileURLToPath(
      new URL('../../../dist/bin/jinn.js', import.meta.url),
    );
    const opAHome = resolveGoldDaemonHome(producerOp);
    // A UNIQUE task id per run drives a genuinely fresh producer→evaluator loop
    // each time the release-readiness gate runs. A stable id would make
    // `jinn tasks submit` idempotent — returning a *stale* on-chain task whose
    // solve/evaluation may have already progressed (or stalled) outside this
    // run's window — which is exactly the bug that masked the loop on the
    // resume path. The cost of a fresh post (one `createTask` tx) is the
    // correct trade for a real-network gate that must exercise the full loop.
    const localTaskId = `t3-1-${KNOWN_INSTANCE_ID}-${Date.now()}`;
    log(`2. post swe-rebench-v2 task via jinn tasks submit (instance=${KNOWN_INSTANCE_ID})`);
    const submit = await submitSweRebenchTask({
      jinnBin,
      opAHome,
      specFilePath,
      taskId: localTaskId,
      log,
    });
    const onchainTaskId = submit.taskId;
    log(
      `   on-chain taskId=${onchainTaskId}${submit.idempotent ? ' (idempotent — task already posted)' : ''}`,
    );

    // Resolve the task's own `TaskCreated` event — its origin block (anchors
    // the Solution / Verdict scans) and the post tx hash (the cost-cap audit's
    // verifiable signal). Poll briefly: `getLogs` can lag a block or two
    // behind the post tx's inclusion on a public RPC.
    const taskCreated = await waitFor(
      () =>
        findTaskCreated({
          client,
          routerAddress: routerAddress as Hex,
          fromBlock: prePostBlock > 1n ? prePostBlock - 1n : 0n,
          taskId: onchainTaskId,
        }),
      { timeoutMs: 90_000, intervalMs: 5000, label: 'task-created-event' },
    );
    const scanFromBlock = taskCreated.blockNumber;
    log(
      `   scan anchor: TaskCreated block=${taskCreated.blockNumber} postTx=${taskCreated.txHash}`,
    );

    log(`3. setup Tier 3 daemons scoped to on-chain taskId=${onchainTaskId}`);
    handle = await setupTier3Scenario({
      scenarioId: 'T3.1',
      mode,
      portBase: PORT_BASE,
      extraEnv: buildT31DaemonEnv({
        hermesModel,
        onchainTaskId,
      }),
      // The Tier-3 helper appends `${scenarioId}-daemons/` so each spawned
      // daemon's stdout/stderr lands in a sibling subdir of the evidence file.
      // T3.1's failures land 5-23 minutes into the run; without these logs the
      // post-mortem has to spelunk chain + db + harness-specific logs.
      evidenceDir: path.dirname(opts.evidencePath),
    });
    const opAPort = handle.daemons.daemons[producerOp]!.apiPort;
    const opBPort = handle.daemons.daemons[solverOp]!.apiPort;
    log(`   daemons up against real Base Sepolia (${producerOp} :${opAPort}, ${solverOp} :${opBPort})`);
    // Surface the daemon log paths up front so a timeout failure has an
    // immediate breadcrumb to the per-daemon stdio capture instead of forcing
    // an investigator to spelunk chain + db + harness-specific logs.
    const opALogPath = handle.daemons.daemons[producerOp]!.logPath;
    const opBLogPath = handle.daemons.daemons[solverOp]!.logPath;
    if (opALogPath || opBLogPath) {
      log(`   daemon logs: ${producerOp} → ${opALogPath ?? '(disabled)'}, ${solverOp} → ${opBLogPath ?? '(disabled)'}`);
    }

    // ── Steps 3+4: observe the Solution + Verdict settle on-chain ────────────
    //
    // Both events are polled under ONE shared deadline (the whole remaining
    // wall-clock budget minus a teardown reserve). The solve leg of a real
    // SWE-rebench v2 instance dominates the budget — codex/hermes producing a
    // patch then the Docker eval — so a rigid pre-split that hands a fixed
    // window to each leg starves whichever leg runs long. A single deadline
    // lets the solve consume as much of the budget as it needs and the verdict
    // take whatever remains. Each poll iteration checks for BOTH events: the
    // verdict cannot land before the solution, but observing the solution is
    // not a hard precondition for observing the verdict — if a slow `getLogs`
    // pass straddles both, the loop still returns the verdict.
    const observeDeadlineMs = started + budgetMs - setupReserveMs;
    const observeTimeoutMs = Math.max(60_000, observeDeadlineMs - Date.now());
    log(
      `4. observe Solution + Verdict on-chain under a shared deadline ` +
        `(timeout=${Math.round(observeTimeoutMs / 1000)}s)`,
    );
    let solution: SolutionDelivery | null = null;
    // The verdicts seen so far that did NOT match the known-instance
    // expectation — kept so the evidence log can report a partial result
    // ("a verdict settled, but for a different code") rather than a bare
    // timeout if the budget runs out before a passing verdict lands.
    const offCodeVerdicts: VerdictDelivery[] = [];
    const verdict = await waitFor<VerdictDelivery>(
      async () => {
        // Cheap incremental progress signal: log the Solution the first time
        // it is observed, so the evidence log distinguishes "solve never
        // delivered" from "solve delivered, verdict never settled".
        if (solution === null) {
          solution = await findSolutionDelivery({
            client,
            routerAddress: routerAddress as Hex,
            fromBlock: scanFromBlock,
            taskId: onchainTaskId,
          });
          if (solution !== null) {
            log(
              `   Solution delivered: operator=${solution.operator} ` +
                `tx=${solution.txHash} block=${solution.blockNumber}`,
            );
          }
        }
        // The Task is posted with `maxClaims > 1`, so several operators can
        // each take their own attempt and settle their own verdict. Scan ALL
        // verdicts and return the first one whose code matches the
        // known-solvable instance's expectation. A failing verdict from a
        // different operator's attempt must NOT end the wait — the loop has
        // not yet been shown to close *correctly*. This is the structural fix
        // for the dead-locked single-slot task (on-chain tasks 183-186): with
        // multiple slots a controlled operator can always land a real verdict.
        const verdicts = await findVerdictDeliveries({
          client,
          routerAddress: routerAddress as Hex,
          fromBlock: scanFromBlock,
          taskId: onchainTaskId,
        });
        for (const v of verdicts) {
          if (v.verdictCode === KNOWN_EXPECTED_VERDICT) return v;
          if (!offCodeVerdicts.some((p) => p.txHash === v.txHash)) {
            offCodeVerdicts.push(v);
            log(
              `   verdict settled with non-expected code ${v.verdictCode} ` +
                `(evaluator=${v.evaluator} tx=${v.txHash}) — still waiting for a ` +
                `verdictCode=${KNOWN_EXPECTED_VERDICT} verdict on another attempt`,
            );
          }
        }
        return null;
      },
      { timeoutMs: observeTimeoutMs, intervalMs: 8000, label: 'solution+verdict' },
    );
    if (solution === null) {
      // The verdict settled but the Solution event was never observed in a
      // poll — record it so the evidence log is honest about the gap.
      log('   (Solution event not separately observed before the Verdict settled)');
    }
    log(
      `   Verdict settled: evaluator=${verdict.evaluator} verdictCode=${verdict.verdictCode} tx=${verdict.txHash} block=${verdict.blockNumber}`,
    );

    // ── Step 5: cost-cap audit (post-hoc, fail-safe) ─────────────────────────
    // A *post-hoc* check: it confirms the run stayed within budget after the
    // fact. The audit is fail-safe — if the cost cannot be verified at all, we
    // FAIL rather than treating an unverifiable run as a pass.
    //
    // The verifiable signal is the on-chain ETH gas of the `createTask` post
    // tx (always observable). The LLM/OpenRouter spend that makes up the bulk
    // of the budget is not surfaced by the daemon on any queryable channel
    // today — `evaluator_cost_usd` in the verdict envelope is stubbed to 0 —
    // so it is reported as a known-gap warning, not silently asserted as $0.
    log('5. cost-cap audit (post-hoc)');
    const postTxCostUsd = await readPostTxCostUsd({
      client,
      txHash: taskCreated.txHash,
    });
    if (postTxCostUsd === undefined) {
      throw new Error(
        `cost cap cannot be verified — the createTask post tx receipt ` +
          `(${taskCreated.txHash}) could not be read; refusing to treat an ` +
          `unverifiable run as a pass`,
      );
    }
    log(
      `   verifiable on-chain spend: $${postTxCostUsd.toFixed(4)} ` +
        `(createTask gas @ $${ETH_USD_RATE}/ETH)`,
    );
    log(
      `   KNOWN GAP: LLM/OpenRouter spend is not reported by the daemon on any ` +
        `queryable channel — it is NOT included in this figure (see issue #526 notes)`,
    );
    if (postTxCostUsd > COST_CAP_USD) {
      throw new Error(
        `cost cap exceeded: verifiable on-chain spend $${postTxCostUsd.toFixed(4)} ` +
          `already over cap $${COST_CAP_USD}`,
      );
    }

    // ── Step 6: assert the verdict matches the known-instance expectation ────
    // The observe loop only resolves on a verdict whose code already equals
    // KNOWN_EXPECTED_VERDICT, so this is a defensive re-assertion — it would
    // only fire if that loop's contract were broken.
    log('6. assert verdict matches expected');
    if (verdict.verdictCode !== KNOWN_EXPECTED_VERDICT) {
      throw new Error(
        `expected on-chain verdictCode=${KNOWN_EXPECTED_VERDICT} ` +
          `for instance ${KNOWN_INSTANCE_ID}, got ${verdict.verdictCode}`,
      );
    }
    log(
      `   PASS — on-chain verdictCode === ${KNOWN_EXPECTED_VERDICT}` +
        (offCodeVerdicts.length > 0
          ? ` (after ${offCodeVerdicts.length} non-expected verdict(s) on other attempts)`
          : ''),
    );

    log('');
    log(
      'Verdict: pass — full producer → solve → deliver → evaluate → verdict loop closed on real Base Sepolia',
    );
    return {
      scenarioId: 'T3.1',
      verdict: 'pass',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: null,
    };
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    // Re-cite the daemon log paths on failure so the evidence log carries a
    // direct breadcrumb to the per-daemon stdio capture, even if the failure
    // landed long after the start-of-run breadcrumb.
    if (handle) {
      // Re-resolve op names here: the try-scoped bindings are out of scope in catch.
      const { producer: pOp, solver: sOp } = tierOpNames();
      const opALog = handle.daemons.daemons[pOp]?.logPath;
      const opBLog = handle.daemons.daemons[sOp]?.logPath;
      if (opALog || opBLog) {
        log(`   see daemon logs for the in-flight window: ${pOp} → ${opALog ?? '(disabled)'}, ${sOp} → ${opBLog ?? '(disabled)'}`);
      }
    }
    return {
      scenarioId: 'T3.1',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always flush the evidence log, on both the pass and fail paths.
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n') + '\n');
    if (specDir) {
      try {
        await fs.rm(specDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    if (handle) {
      try {
        await handle.teardown();
      } catch {
        /* best-effort */
      }
    }
  }
}
