/**
 * claude-mcp-hyperliquid — Reference Harness for portfolio.v0 — §8.
 *
 * Spawns Claude Code session(s) with HL-specific MCP tools (§8.2).
 * Safety rails enforced at the tool boundary (§8.3).
 * Sequential session cadence per §8.4.
 * API wallet managed in implStateDir (§8.1).
 *
 * OPERATOR PREREQUISITE (v0):
 *   Before this impl can place trades, the operator must:
 *   1. Let the daemon boot once (or call canAttempt()) to generate the API wallet.
 *   2. Approve the generated API wallet address on their HL master account
 *      (Settings → API Wallets → Add in the HL UI).
 *   3. Set approved:true in <implStateDir>/api-wallet.json
 *
 *   The impl will surface the wallet address and instructions in canAttempt()
 *   if the wallet is not yet approved.
 *
 *   Programmatic approval is a §8.5 future item.
 */

import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type {
  Harness,
  HarnessContext,
  Solution,
  ReadyStatus,
  EnableResult,
  HarnessEnableMetadata,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { Task } from '../../../types/task.js';
import type { RationaleEntry } from '../../../types/portfolio.js';
import { HyperliquidClient, HL_MAINNET_BASE_URL, HL_TESTNET_BASE_URL } from '../../../venues/hyperliquid/client.js';
import { getUnifiedAccountValue } from '../../../venues/hyperliquid/account-value.js';
import type { UnifiedAccountValue } from '../../../venues/hyperliquid/account-value.js';
import {
  PortfolioV0TaskSchema,
  PortfolioV0EligibilitySchema,
} from '../../../types/portfolio.js';

import {
  equityCurve,
  equityReturnPct,
  maxDrawdownPct,
  closedTradesCount,
  tradedNotionalMultiple,
} from '../portfolio-v0-evaluator/canonical-metrics.js';

import {
  provisionApiWallet,
  loadApiWalletState,
  markApiWalletApproved,
  saveApiWalletState,
  walletStatePath,
} from './api-wallet.js';
import { buildHlTools } from './mcp-tools.js';
import { createRateLimitState, DEFAULT_SAFETY_CONFIG as DEFAULT_SAFETY_CONFIG_IMPORTED } from './safety-rails.js';
import type { SafetyConfig } from './safety-rails.js';
import { runSessionLoop } from './session-orchestrator.js';
import type { WriteOpRecord } from './mcp-tools.js';
import type { SessionResult } from './session-orchestrator.js';
import type { HlFill } from '../../../venues/hyperliquid/types.js';

// ── Config ────────────────────────────────────────────────────────────────────

export interface ClaudeMcpHyperliquidConfig {
  claudePath?: string;
  claudeModel?: string;
  /** Per-task safety override (from task context) */
  safetyConfig?: Partial<SafetyConfig>;
  /** Cadence between sessions in ms. Default: 30 min */
  cadenceMs?: number;
  /** Max session wall time in ms. Default: 8 min */
  sessionMaxMs?: number;
  /**
   * Impl state directory — used by `isReady` and `onEnable` to locate
   * the api-wallet file outside of a running task context. Defaults under
   * `~/.jinn-client/engine/impl-state/claude-mcp-hyperliquid` (see `config.engine`).
   */
  implStateDir?: string;
  /** Injected deps for testing */
  _testDeps?: TestDeps;
  /** CLI `jinn solver-nets` registry without a live fleet */
  stub?: boolean;
}

const DEFAULT_IMPL_STATE_DIR = join(
  homedir(),
  '.jinn-client',
  'engine',
  'impl-state',
  'claude-mcp-hyperliquid',
);

export interface TestDeps {
  /** Mock runner — called instead of spawning Claude */
  runSession?: (sessionId: string, prompt: string) => Promise<{ stdout: string }>;
  hlClient?: HyperliquidClient;
}

// ── Impl ───────────────────────────────────────────────────────────────────────

export class ClaudeMcpHyperliquidImpl implements Harness {
  readonly name = 'claude-mcp-hyperliquid';
  readonly version = '1.0.0';

  private config: ClaudeMcpHyperliquidConfig;

  constructor(config: ClaudeMcpHyperliquidConfig = {}) {
    this.config = config;
  }

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'portfolio.v0' && ctx.role !== 'evaluation';
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (task.solverType !== 'portfolio.v0') {
      return { ok: false, reason: 'solverType is not portfolio.v0' };
    }

    // Validate the task shape
    const parseResult = PortfolioV0TaskSchema.safeParse(task);
    if (!parseResult.success) {
      return {
        ok: false,
        reason: `Invalid portfolio.v0 task: ${parseResult.error.message}`,
      };
    }

    // implStateDir is not available in canAttempt — we can only check
    // if the task is structurally valid. API wallet check is done at run() time.
    return { ok: true };
  }

  /** Resolve the impl state directory used by enable / readiness flows. */
  private resolveImplStateDir(): string {
    return this.config.implStateDir ?? DEFAULT_IMPL_STATE_DIR;
  }

  /** Exposed for tests and operator diagnostics; same as internal resolve path. */
  resolvedImplStateDir(): string {
    return this.resolveImplStateDir();
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    const implStateDir = this.resolveImplStateDir();
    const wallet = loadApiWalletState(implStateDir);
    if (!wallet) {
      return {
        ready: false,
        reason: 'HL api-wallet not provisioned',
        nextStep: {
          description: 'Run `jinn solver-nets enable portfolio --hl-master <your-HL-master-address>` to generate the api-wallet and complete HL approval.',
          cli: 'jinn solver-nets enable portfolio --hl-master 0x...',
        },
      };
    }
    if (!wallet.approved) {
      return {
        ready: false,
        reason: 'HL api-wallet generated but not approved on HL',
        nextStep: {
          description: `Approve address ${wallet.address} on Hyperliquid (Settings → API Wallets → Add), then re-run \`jinn solver-nets enable portfolio --confirm-approved\`.`,
          cli: 'jinn solver-nets enable portfolio --confirm-approved',
          url: 'https://app.hyperliquid-testnet.xyz/API',
        },
      };
    }
    if (!wallet.masterAddress) {
      return {
        ready: false,
        reason: 'HL master address not recorded in api-wallet state',
        nextStep: {
          description: 'Re-run enable with the master address to record it: `jinn solver-nets enable portfolio --hl-master 0x...`.',
          cli: 'jinn solver-nets enable portfolio --hl-master 0x...',
        },
      };
    }
    return { ready: true };
  }

  enableMetadata(): HarnessEnableMetadata {
    return {
      description:
        'portfolio.v0 — 24h managed-trading task executed against a Hyperliquid master account. Requires you to (1) bring an HL master with USDC, and (2) approve a generated api-wallet as an HL agent.',
      requiredArgs: [
        { name: 'hl-master', description: 'Your Hyperliquid master address (holds USDC; approves the api-wallet).', required: true },
      ],
      externalResources: [
        { name: 'HL Testnet Settings → API Wallets', url: 'https://app.hyperliquid-testnet.xyz/API' },
        { name: 'HL Mainnet Settings → API Wallets', url: 'https://app.hyperliquid.xyz/API' },
      ],
    };
  }

  async onEnable(ctx: { args: Record<string, string | undefined> }): Promise<EnableResult> {
    const args = ctx.args;
    const implStateDir = this.resolveImplStateDir();
    const hlMaster = args['hl-master'];
    const confirmApproved = args['confirm-approved'] !== undefined;

    // Ensure the impl state directory exists so we can write the wallet file.
    if (!existsSync(implStateDir)) {
      mkdirSync(implStateDir, { recursive: true, mode: 0o700 });
    }

    const existing = loadApiWalletState(implStateDir);

    // Already enabled: idempotent no-op.
    if (existing && existing.approved && existing.masterAddress) {
      return {
        status: 'ready',
        details: {
          apiWalletAddress: existing.address,
          masterAddress: existing.masterAddress,
        },
      };
    }

    // First invocation: need --hl-master to know which account this wallet belongs to.
    if (!existing && !hlMaster) {
      return {
        status: 'missing_args',
        required: [
          { name: 'hl-master', description: 'Your Hyperliquid master address (holds USDC).', required: true },
        ],
        example: { cli: 'jinn solver-nets enable portfolio --hl-master 0x...' },
      };
    }

    // State transition 1: no wallet yet — generate it and tell the agent to have the operator approve on HL.
    if (!existing) {
      const wallet = provisionApiWallet(implStateDir);
      // Record the master so we don't re-ask on the next invocation.
      saveApiWalletState(implStateDir, { ...wallet, masterAddress: hlMaster });
      return {
        status: 'waiting_for_external_action',
        action: {
          description: `API wallet ${wallet.address} generated. Open the Hyperliquid UI, go to Settings → API Wallets → Add, and approve this address under your master ${hlMaster}. Once done, re-run this command with --confirm-approved.`,
          url: 'https://app.hyperliquid-testnet.xyz/API',
        },
        details: {
          apiWalletAddress: wallet.address,
          masterAddress: hlMaster,
          walletStatePath: walletStatePath(implStateDir),
        },
        nextInvocation: {
          cli: 'jinn solver-nets enable portfolio --confirm-approved',
          purpose: 'Record the operator-confirmed HL approval and enable portfolio.v0 claims.',
        },
      };
    }

    // State transition 2: wallet exists, not yet confirmed — if --confirm-approved is passed, flip the flag.
    if (!existing.approved && !confirmApproved) {
      return {
        status: 'waiting_for_external_action',
        action: {
          description: `Approve api-wallet address ${existing.address} on Hyperliquid under master ${existing.masterAddress ?? hlMaster ?? '<set via --hl-master>'}, then re-run with --confirm-approved.`,
          url: 'https://app.hyperliquid-testnet.xyz/API',
        },
        details: {
          apiWalletAddress: existing.address,
          masterAddress: existing.masterAddress ?? hlMaster,
        },
        nextInvocation: {
          cli: 'jinn solver-nets enable portfolio --confirm-approved',
          purpose: 'Record the operator-confirmed HL approval.',
        },
      };
    }

    // State transition 3: --confirm-approved passed — persist approval and optionally update the master.
    const updated = markApiWalletApproved(implStateDir);
    const resolvedMaster = hlMaster ?? updated.masterAddress;
    if (!resolvedMaster) {
      return {
        status: 'missing_args',
        required: [
          { name: 'hl-master', description: 'Master address was never recorded; pass --hl-master now.', required: true },
        ],
        example: { cli: 'jinn solver-nets enable portfolio --hl-master 0x... --confirm-approved' },
      };
    }
    if (updated.masterAddress !== resolvedMaster) {
      saveApiWalletState(implStateDir, { ...updated, masterAddress: resolvedMaster });
    }

    return {
      status: 'ready',
      details: {
        apiWalletAddress: updated.address,
        masterAddress: resolvedMaster,
      },
    };
  }

  async onDisable(): Promise<void> {
    // Intentionally no-op on key material: operators may re-enable later
    // and re-generating the wallet would force a fresh HL approval round-trip.
    // The config-level disable (removing the impl from `harnesses.disabled`)
    // is handled by the `jinn solver-nets disable` verb, not the impl itself.
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('claude-mcp-hyperliquid: stub registry cannot run (requires live daemon)');
    }
    const { task: task, implStateDir, workingDir, log, abort, msUntilEndTs } = ctx;
    const testDeps = this.config._testDeps;

    log({ level: 'info', msg: 'claude-mcp-hyperliquid: starting', data: { implStateDir, workingDir } });

    // ── Parse task ──────────────────────────────────────────────────────────

    const portfolioTask = PortfolioV0TaskSchema.parse(task);
    const { masterAddress, venue } = portfolioTask.spec.account;
    const eligibility = PortfolioV0EligibilitySchema.parse(portfolioTask.eligibility ?? {});
    const window = portfolioTask.window;

    // ── Select HL client ──────────────────────────────────────────────────────

    const hlBaseUrl = venue === 'hyperliquid-mainnet' ? HL_MAINNET_BASE_URL : HL_TESTNET_BASE_URL;
    const hlClient = testDeps?.hlClient ?? new HyperliquidClient(hlBaseUrl);

    // ── Provision API wallet ──────────────────────────────────────────────────

    const walletState = provisionApiWallet(implStateDir);

    if (!walletState.approved && !testDeps) {
      log({
        level: 'warn',
        msg: 'claude-mcp-hyperliquid: API wallet not approved — write tools will fail. Operator action required.',
        data: {
          apiWalletAddress: walletState.address,
          instructions: [
            '1. Go to Hyperliquid Settings → API Wallets → Add',
            `2. Approve address: ${walletState.address}`,
            '3. Set approved:true in <implStateDir>/api-wallet.json',
          ],
        },
      });
      // Continue anyway — read-only sessions still work; write tools will fail at the HL exchange layer
    }

    // Sanity check: the agent key stored in api-wallet.json was approved by a
    // specific master. HL routes trades to THAT master, regardless of what the
    // task's spec says. If the operator switched masters (new wallet, new
    // approval) without updating the task, every trade would silently land
    // on the wrong account and pre/post snapshots would read the wrong equity.
    // Fail fast with a clear remedy.
    if (
      !testDeps
      && walletState.masterAddress !== undefined
      && walletState.masterAddress.toLowerCase() !== masterAddress.toLowerCase()
    ) {
      throw new Error(
        `E_MASTER_MISMATCH: api-wallet.json says the agent ${walletState.address} is approved by ` +
        `${walletState.masterAddress}, but the task's spec.account.masterAddress is ${masterAddress}. ` +
        `HL would route trades to the agent's approver (${walletState.masterAddress}) while pre/post ` +
        `snapshots would read from the task's master (${masterAddress}) — silent fund-on-the-wrong-account bug. ` +
        `Remedy: either (a) update ~/.jinn-client/portfolio-v0-task.json to use masterAddress=${walletState.masterAddress}, ` +
        `or (b) approve the agent on the task's master (${masterAddress}) via the HL UI and update ${implStateDir}/api-wallet.json.`,
      );
    }

    // ── Take pre-snapshot ─────────────────────────────────────────────────────
    //
    // Pre/post snapshots source equity from HL's unified view: perps
    // `marginSummary.accountValue` + spot USDC balance. This matches the
    // `portfolio` endpoint's `accountValueHistory` (which reports the unified
    // figure too), so harness-claimed equity and evaluator-rederived grid
    // points compare cleanly — and accounts parked on spot are not ignored.

    log({ level: 'info', msg: 'claude-mcp-hyperliquid: taking pre-snapshot' });
    const preUnified = await getUnifiedAccountValue(hlClient, masterAddress);
    const preSnapshot = {
      capturedAt: Date.now(),
      hlTime: preUnified.clearinghouseState.time,
      payload: buildSnapshotPayload(preUnified),
    };

    log({
      level: 'info',
      msg: 'claude-mcp-hyperliquid: pre-snapshot captured',
      data: {
        accountValue: preUnified.accountValue,
        perpsAccountValue: preUnified.perpsAccountValue,
        spotUsdc: preUnified.spotUsdc,
      },
    });

    // ── Set up session infrastructure ─────────────────────────────────────────

    const writeOps: WriteOpRecord[] = [];
    const rateLimitState = createRateLimitState();

    // Build HL tools (shared across sessions via closure)
    const hlTools = buildHlTools({
      hlClient,
      hlBaseUrl,
      apiWalletPrivateKey: walletState.privateKey,
      apiWalletAddress: walletState.address,
      masterAddress,
      safetyConfig: this.config.safetyConfig
        ? { ...DEFAULT_SAFETY_CONFIG_IMPORTED, ...this.config.safetyConfig }
        : undefined,
      rateLimitState,
      onWriteOp: (op) => writeOps.push(op),
    });

    // ── MCP config for Claude sessions ────────────────────────────────────────

    // The HL tools are served via an in-process MCP server written to a temp script.
    // We create a per-run MCP config that includes both:
    //   1. The existing jinn-client MCP server (tool: submit_restoration_result etc)
    //   2. A new HL-specific MCP server (tool: hl_*)
    //
    // The HL server is an inline node script that creates a McpServer with the tools.
    // We write it to workingDir/mcp/hl-server.ts and reference it in the config.

    const hlMcpServerPath = join(workingDir, 'mcp', 'hl-server.mjs');
    // Config file path — written by _writeHlMcpServerScript alongside the script
    const hlMcpConfigPath = join(workingDir, 'mcp', 'hl-server-config.json');
    mkdirSync(join(workingDir, 'mcp'), { recursive: true });
    _writeHlMcpServerScript(hlMcpServerPath, {
      hlBaseUrl,
      apiWalletPrivateKey: walletState.privateKey,
      apiWalletAddress: walletState.address,
      masterAddress,
      safetyConfig: this.config.safetyConfig,
    });

    const { command: jinnMcpCommand, args: jinnMcpArgs } = _resolveJinnMcpLauncher();

    const mcpConfigPath = join(workingDir, 'mcp', 'mcp-config.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        'jinn-client': {
          command: jinnMcpCommand,
          args: jinnMcpArgs,
          env: {
            DESIRED_STATE_ID: task.id,
            DESIRED_STATE_DESCRIPTION: task.description,
            DESIRED_STATE_CONTEXT: task.context ? JSON.stringify(task.context) : '',
            DESIRED_STATE_TYPE: task.role ?? '',
            RESTORATION_REQUEST_ID: task.restorationRequestId ?? '',
            REQUEST_ID: task.restorationRequestId ?? '',
          },
        },
        'jinn-hl': {
          command: process.execPath,
          // Pass config file path as argv[2] — private key is in config file, not script body
          args: [hlMcpServerPath, hlMcpConfigPath],
        },
      },
    }));

    // ── Session loop ──────────────────────────────────────────────────────────

    const rationale: RationaleEntry[] = [];
    let allSessions: SessionResult[] = [];
    const claudeModel = ctx.solverNet?.model ?? this.config.claudeModel;

    if (testDeps?.runSession) {
      // Test mode: use injected runner instead of spawning Claude
      allSessions = await _runTestSessions(
        testDeps.runSession,
        task,
        portfolioTask,
        workingDir,
        abort,
        msUntilEndTs,
        log,
        { ...this.config, claudeModel },
      );
    } else {
      // Production mode: spawn Claude with MCP config
      const preAccountValue = parseFloat(preUnified.accountValue);
      const loopResult = await runSessionLoop(
        (sessionNum, sessionId) => buildSessionPrompt({
          sessionNum,
          sessionId,
          task: portfolioTask,
          preAccountValue,
          msUntilEndTs: msUntilEndTs(),
        }),
        {
          claudePath: this.config.claudePath ?? 'claude',
          claudeModel,
          mcpConfigPath,
          workingDir,
          abort,
          msUntilEndTs,
          log,
          getMids: () => hlClient.allMids(),
          // Write a per-session outcome.json as soon as each Claude subprocess
          // exits. Consumed by gather-status.ts / portfolio-v0-build.ts to
          // surface `recentClaudeOutcomes` in /v1/status — operators can see
          // trading activity before the 24h window closes.
          //
          // NOTE: the daemon-side `writeOps` closure was initially used for
          // tool-call counts, but the actual MCP tool invocations happen in
          // Claude's hl-server.mjs SUBPROCESS — the daemon's callback is never
          // wired to that server. So the authoritative counter for real trading
          // is HL's own userFillsByTime: ask HL what filled between the
          // session's start/end (±5s padding for clock skew) and report that.
          onSessionEnd: async (sr) => {
            try {
              const outcomePath = join(workingDir, 'sessions', sr.sessionId, 'outcome.json');
              let fillsInWindow: Array<{ coin: string; dir: string; oid: number }> = [];
              let fillsQueryError: string | null = null;
              try {
                // Give HL a moment to propagate fills before we query.
                await new Promise(r => setTimeout(r, 2000));
                const { fills } = await hlClient.userFillsByTime(
                  masterAddress,
                  sr.startedAt - 5_000,
                  sr.endedAt + 5_000,
                );
                fillsInWindow = fills.map(f => ({ coin: f.coin, dir: f.dir, oid: f.oid }));
              } catch (err) {
                fillsQueryError = err instanceof Error ? err.message : String(err);
              }
              const coinCounts: Record<string, number> = {};
              for (const f of fillsInWindow) {
                coinCounts[f.coin] = (coinCounts[f.coin] ?? 0) + 1;
              }
              const outcome = {
                schemaVersion: 2 as const,
                requestId: ctx.task.restorationRequestId ?? ctx.task.id,
                sessionId: sr.sessionId,
                startedAt: sr.startedAt,
                endedAt: sr.endedAt,
                durationMs: sr.endedAt - sr.startedAt,
                aborted: sr.aborted,
                fillsInSessionWindow: fillsInWindow.length,
                coinCounts,
                ...(fillsQueryError !== null ? { fillsQueryError } : {}),
              };
              writeFileSync(outcomePath, JSON.stringify(outcome, null, 2), { encoding: 'utf-8' });
            } catch (err) {
              log({
                level: 'warn',
                msg: 'claude-mcp-hyperliquid: failed to write session outcome.json',
                data: { sessionId: sr.sessionId, err: err instanceof Error ? err.message : String(err) },
              });
            }
          },
          config: {
            cadenceMs: this.config.cadenceMs,
            sessionMaxMs: this.config.sessionMaxMs,
            trackedCoins: [], // could be populated from task context
          },
        },
      );
      allSessions = loopResult.sessions;
    }

    // ── Post-session: match fills to sessions ─────────────────────────────────

    log({ level: 'info', msg: 'claude-mcp-hyperliquid: matching fills to sessions' });

    let windowFills: HlFill[] = [];
    try {
      const fillsResult = await hlClient.userFillsByTime(masterAddress, window.startTs, window.endTs);
      windowFills = fillsResult.fills;
    } catch (e) {
      log({ level: 'warn', msg: 'claude-mcp-hyperliquid: failed to fetch window fills', data: { err: e instanceof Error ? e.message : String(e) } });
    }

    // Match fills to sessions by timestamp
    for (const session of allSessions) {
      const sessionFillTids = windowFills
        .filter((f) => f.time >= session.startedAt - 5000 && f.time <= session.endedAt + 5000)
        .map((f) => f.tid);
      session.initiatedFillTids = sessionFillTids;

      if (sessionFillTids.length > 0) {
        rationale.push({
          ts: session.startedAt,
          sessionId: session.sessionId,
          note: `Session completed with ${sessionFillTids.length} fills`,
          relatedFillTids: sessionFillTids,
        });
      }
    }

    // ── Take post-snapshot ────────────────────────────────────────────────────

    log({ level: 'info', msg: 'claude-mcp-hyperliquid: taking post-snapshot' });
    let postUnified: UnifiedAccountValue;
    try {
      postUnified = await getUnifiedAccountValue(hlClient, masterAddress);
    } catch (e) {
      log({ level: 'error', msg: 'claude-mcp-hyperliquid: failed to take post-snapshot', data: { err: e instanceof Error ? e.message : String(e) } });
      // Use pre-snapshot as fallback
      postUnified = preUnified;
    }

    const postSnapshot = {
      capturedAt: Date.now(),
      hlTime: postUnified.clearinghouseState.time,
      payload: buildSnapshotPayload(postUnified),
    };

    // ── Compute canonical metrics (import from evaluator — §8 task discipline) ─

    const preValue = parseFloat(preUnified.accountValue);
    const postValue = parseFloat(postUnified.accountValue);
    const fillTimes = windowFills.map((f) => f.time);

    const curve = equityCurve(
      preSnapshot.capturedAt,
      preValue,
      postSnapshot.capturedAt,
      postValue,
      fillTimes,
    );

    const equityReturn = equityReturnPct(preValue, postValue);
    const drawdown = maxDrawdownPct(curve);
    const closedTrades = closedTradesCount(windowFills);
    const notional = tradedNotionalMultiple(windowFills, preValue);

    log({
      level: 'info',
      msg: 'claude-mcp-hyperliquid: metrics computed',
      data: { equityReturn, drawdown, closedTrades, notional },
    });

    // ── Build artifacts list (transcripts) ────────────────────────────────────

    const artifacts = allSessions.map((session) => ({
      path: `sessions/${session.sessionId}/transcript.txt`,
      artifactType: 'session_transcript',
      metadata: {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        modelId: claudeModel ?? 'unknown',
        initiatedFillTids: session.initiatedFillTids,
      },
      tags: ['transcript', 'session'],
      access: { priceUsdc: '0' },
    }));

    // ── Return Solution ──────────────────────────────────────────────

    return {
      venueRef: { name: venue === 'hyperliquid-mainnet' ? 'hyperliquid-mainnet' : 'hyperliquid-testnet' },

      preSnapshot,
      postSnapshot,
      fills: windowFills,

      gating: {
        equityReturnPct: String(equityReturn),
        maxDrawdownPct: String(drawdown),
        closedTradesCount: closedTrades,
        tradedNotionalMultiple: String(notional),
      },

      informational: {
        sessionCount: allSessions.length,
        totalWriteOps: writeOps.length,
        preAccountValue: String(preValue),
        postAccountValue: String(postValue),
        windowFillCount: windowFills.length,
        minReturnPct: portfolioTask.spec.target.minReturnPct,
        maxDrawdownConstraint: portfolioTask.spec.constraint.maxDrawdownPct,
        minClosedTrades: eligibility.minClosedTrades,
        minTradedNotionalMultiple: eligibility.minTradedNotionalMultiple,
      },

      artifacts,
      rationale,
    };
  }
}

// ── Snapshot payload ──────────────────────────────────────────────────────────

/**
 * Build the on-manifest snapshot payload from a unified account-value result.
 *
 * The top-level `accountValue` is the canonical figure used for metrics and
 * consistency checks (matches HL's `portfolio` endpoint unified equity).
 * The raw perps and spot payloads are included verbatim for auditability.
 */
function buildSnapshotPayload(unified: UnifiedAccountValue): Record<string, unknown> {
  return {
    accountValue: unified.accountValue,
    perpsAccountValue: unified.perpsAccountValue,
    spotUsdc: unified.spotUsdc,
    clearinghouseState: unified.clearinghouseState,
    spotClearinghouseState: unified.spotClearinghouseState,
  };
}

// ── Session prompt ────────────────────────────────────────────────────────────

interface SessionPromptParams {
  sessionNum: number;
  sessionId: string;
  task: ReturnType<typeof PortfolioV0TaskSchema.parse>;
  preAccountValue: number;
  msUntilEndTs: number;
}

function buildSessionPrompt(params: SessionPromptParams): string {
  const { sessionNum, sessionId, task, preAccountValue, msUntilEndTs } = params;
  const minsRemaining = Math.round(msUntilEndTs / 60_000);
  const { minReturnPct } = task.spec.target;
  const { maxDrawdownPct } = task.spec.constraint;
  const { masterAddress } = task.spec.account;

  return `EXECUTE IMMEDIATELY. DO NOT WRITE TEXT BEFORE YOUR FIRST TOOL CALL. DO NOT ASK QUESTIONS.

Your first action this turn MUST be a tool call to \`hl_account_unified\`. Begin now.

You are an autonomous trader managing a Hyperliquid perpetuals portfolio. Every turn, you call tools, observe results, and decide the next action. You never defer to a human — there is no human in the loop. The only way to satisfy the task is to open positions, close them, and repeat enough times to hit the targets below.

## Verdict criteria (ALL four must pass for a PASS verdict)
- Equity return ≥ ${minReturnPct}% over the 24h window
- Max drawdown ≤ ${maxDrawdownPct}% peak-to-trough
- At least 20 closed trades
- Traded notional ≥ 5× starting equity (~$${(preAccountValue * 5).toFixed(2)})

Missing any one → REJECTED → zero rewards. Inaction = REJECTED.

## Context
- Task: ${task.description}
- Master account: ${masterAddress}
- Starting equity: $${preAccountValue.toFixed(2)}
- Session ${sessionNum} (${sessionId})
- Time remaining in window: ${minsRemaining} min
- You run again in ~30 minutes, or sooner on ≥2% mid-move. Use this session fully.

## Tools you will call (all are MCP tools — call them by name)
Read (prefer these):
- \`hl_account_unified\` — PREFERRED single-call read: unified equity (perps+spot), positions, open orders
- \`hl_all_mids\` — current mid prices for all assets
- \`hl_user_fills\` — recent fills (check turnover + trade count)
- \`hl_meta\` — asset metadata (max leverage, size decimals)
Read (niche):
- \`hl_clearinghouse_state\` — perps-only snapshot; DO NOT use for decisions (hides spot USDC)
- \`hl_portfolio\` — historical equity curve
Write: \`hl_open_position\`, \`hl_close_position\`, \`hl_modify_position\`, \`hl_cancel_orders\`

## Risk rails (tool-enforced — not suggestions)
- Max 25% of account value per position
- Max 10× leverage
- Max 50 bps slippage
- **Every \`hl_open_position\` MUST include both \`tp\` (take-profit) and \`sl\` (stop-loss)**. The tool rejects bare opens with \`TPSL_REQUIRED\` unless you pass \`bypassRiskRails=true\`. Only bypass for a scalp you will close THIS turn. Between turns you're unprotected — ~30 min of tail risk is enough to break the ${maxDrawdownPct}% drawdown on a 5–10× move.
- Sensible starting ranges: sl at 1–2% adverse from mid; tp at 1–3% favorable. Example long at mid $2300: \`sl=2265\` (−1.5%), \`tp=2345\` (+2%).
- The tool validates tp/sl are on the correct sides of mid. A long with sl≥mid or tp≤mid returns \`SL_INVALID\`/\`TP_INVALID\`.

## Your turn (do this sequence in tool calls, not prose)
1. \`hl_account_unified\` — one call, gives you unified equity + positions + open orders
2. \`hl_all_mids\` — current prices for majors (BTC, ETH, SOL, at minimum)
3. \`hl_user_fills\` — recent fills so you know your turnover + trade count so far
4. Based on the read tool outputs, open/adjust/close positions with the write tools. Aim for at least 2–3 position actions in this session. You have 20+ trades to hit across the window — aggressive, disciplined turnover is required, not careful inaction.
5. Emit a ONE-PARAGRAPH rationale as your final text message after the tool calls. Not before.

Begin with \`hl_account_unified\` now. No preamble.`;
}

// ── Test session runner ────────────────────────────────────────────────────────

async function _runTestSessions(
  runSession: NonNullable<TestDeps['runSession']>,
  task: Task,
  portfolioTask: ReturnType<typeof PortfolioV0TaskSchema.parse>,
  workingDir: string,
  abort: AbortSignal,
  msUntilEndTs: () => number,
  log: HarnessContext['log'],
  config: ClaudeMcpHyperliquidConfig,
): Promise<SessionResult[]> {
  const sessions: SessionResult[] = [];
  let sessionNum = 0;

  // Run a single test session (tests don't need full cadence)
  if (!abort.aborted && msUntilEndTs() > 0) {
    sessionNum++;
    const sessionId = `test-session-${sessionNum}`;
    const startedAt = Date.now();

    const sessionDir = join(workingDir, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, 'transcript.txt');

    let stdout = '';
    try {
      const result = await runSession(sessionId, `Session ${sessionNum} for ${task.id}`);
      stdout = result.stdout;
    } catch (e) {
      log({ level: 'warn', msg: 'claude-mcp-hyperliquid: test session threw', data: { err: e instanceof Error ? e.message : String(e) } });
    }

    writeFileSync(transcriptPath, stdout || '(test session — no output)');

    sessions.push({
      sessionId,
      startedAt,
      endedAt: Date.now(),
      transcriptPath,
      aborted: abort.aborted,
      stdout,
      initiatedFillTids: [],
    });
  }

  return sessions;
}

// ── HL MCP server script writer ───────────────────────────────────────────────

interface HlServerConfig {
  hlBaseUrl: string;
  apiWalletPrivateKey: string;
  apiWalletAddress: string;
  masterAddress: string;
  safetyConfig?: Partial<SafetyConfig>;
}

/**
 * Write a thin ESM wrapper script to disk that delegates to the compiled
 * startMcpServer() from this package. This is spawned as a subprocess by
 * Claude's --mcp-config.
 *
 * Security: the config (including apiWalletPrivateKey) is written to a
 * SEPARATE file (hl-server-config.json) with mode 0o600. The script body
 * receives only the config file path via process.argv[2] — no private key
 * or secret data appears in the script source.
 *
 * The import path is resolved at write-time from __dirname (this module's
 * location) so it always points to the compiled mcp-tools.js alongside this
 * file. The daemon MUST run from a compiled build (dist/) — `yarn build`
 * produces `dist/harnesses/impls/claude-mcp-hyperliquid/mcp-tools.js`, which
 * this wrapper imports by absolute path from plain Node. Running from tsx
 * against src/ would leave mcp-tools.js non-existent and cause Claude to
 * silently spawn with no HL tools loaded — hence the explicit existence
 * check and `E_DAEMON_MUST_RUN_FROM_DIST` error below.
 */
export function _writeHlMcpServerScript(outPath: string, hlConfig: HlServerConfig): void {
  // Absolute path to the compiled mcp-tools module, alongside this file.
  const mcpToolsPath = join(__dirname, 'mcp-tools.js');

  // Production guardrail: the generated wrapper is loaded by plain Node (the
  // Claude subprocess's --mcp-config launches `node hl-server.mjs`), which
  // can only import `.js`. Running the daemon via tsx against src/ leaves
  // mcp-tools.js non-existent and Claude spawns with zero HL tools — a
  // silent failure that looks like "Claude refused to trade." Skipped under
  // NODE_ENV=test so vitest runs don't need a preceding `yarn build`.
  if (process.env['NODE_ENV'] !== 'test' && !existsSync(mcpToolsPath)) {
    throw new Error(
      `E_DAEMON_MUST_RUN_FROM_DIST: ${mcpToolsPath} does not exist. ` +
      `The Jinn daemon must run from a compiled build (e.g. \`node dist/bin/jinn.js run\`), ` +
      `not directly via tsx/ts-node against src/. ` +
      `If you're developing, run \`yarn dev\` (build + run alias) instead of \`yarn jinn run\`. ` +
      `If you installed via npm, the compiled artifact ships in the package — reinstall with ` +
      `\`npm install -g @jinn-network/client@latest\` and use the \`jinn\` binary directly.`,
    );
  }

  // Write config (including private key) to a separate file alongside the script,
  // with restricted permissions — private key must not be world-readable.
  const scriptDir = join(outPath, '..');
  const configPath = join(scriptDir, 'hl-server-config.json');

  // Write config with restricted permissions — private key must not be world-readable
  writeFileSync(configPath, JSON.stringify(hlConfig), { encoding: 'utf-8', mode: 0o600 });
  // Explicitly chmod in case the umask relaxed the mode
  chmodSync(configPath, 0o600);

  const script = `#!/usr/bin/env node
// Auto-generated HL MCP server wrapper — do not edit.
// Delegates to the compiled mcp-tools module so the real EIP-712 signing path
// is always active. See: ${mcpToolsPath}
//
// The private key is NOT embedded here — it is read from the config file
// passed as process.argv[2]. The config file is created at mode 0o600.
//
// We deliberately do NOT unlink the config file on exit. Each Claude session
// spawns a fresh hl-server.mjs child (via --mcp-config); deleting the config
// when session N exits means session N+1 starts with no HL tools and hangs
// until sessionMaxMs. The working directory is ephemeral — it gets cleared
// on next attempt — so leaving the mode-0o600 config in place is safe.
import { readFileSync } from 'node:fs';
import { startMcpServer } from ${JSON.stringify(mcpToolsPath)};

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('Usage: hl-server.mjs <config-file-path>\\n');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
await startMcpServer(config);
`.trim();

  writeFileSync(outPath, script, { encoding: 'utf-8', mode: 0o600 });
}

// ── Jinn MCP launcher resolution ──────────────────────────────────────────────

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function _resolveJinnMcpLauncher(): { command: string; args: string[] } {
  const mcpDir = join(__dirname, '..', '..', '..', 'mcp');
  const js = join(mcpDir, 'server.js');
  const ts = join(mcpDir, 'server.ts');
  if (existsSync(js)) {
    return { command: process.execPath, args: [js] };
  }
  if (existsSync(ts)) {
    return { command: process.execPath, args: ['--import', 'tsx', ts] };
  }
  return { command: process.execPath, args: [js] };
}

export default ClaudeMcpHyperliquidImpl;
