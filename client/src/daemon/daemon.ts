import { randomBytes } from 'node:crypto';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import { Store } from '../store/store.js';
import { CreatorLoop } from './creator.js';
import { DeliveryWatcherLoop } from './delivery-watcher.js';
import { startApiServer, type ApiServer } from '../api/server.js';
import type { StatusGatherConfig } from '../api/gather-status.js';
import { PeerSync } from '../api/peers.js';
import type { EthHttpSigner } from '../auth/erc8128.js';
import type { X402Config } from '../x402/handler.js';
import type { Corpus } from '../corpus/index.js';
import { RewardClaimLoop, type RewardClaimLoopConfig } from './reward-claim-loop.js';
import { TaskEngine, type TaskEngineOptions } from '../harnesses/engine/engine.js';
import { BalanceTopupLoop, type BalanceTopupLoopConfig } from './balance-topup-loop.js';
import { EvictionLoop, type EvictionLoopConfig } from './eviction-loop.js';
import { CheckpointLoop, type CheckpointLoopConfig } from './checkpoint-loop.js';
import { JinnClaimLoop, type JinnClaimLoopConfig } from './jinn-claim-loop.js';
import { emitEvent } from '../observability/emit-event.js';
import { emitStructured } from '../events/emitter.js';
import { StaticConfiguredTaskSource, type TaskSource } from '../tasks/sources.js';
import type { Task } from '../types/index.js';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import { gateClaimByReadiness } from './readiness-gate.js';
import { SkipLogDeduper } from './skip-log-dedup.js';

const DEFAULT_API_PORT = 7331;

export interface DaemonConfig {
  adapter: ExecutionAdapter;
  /**
   * Legacy Runner only consumed by `LegacyClaudeImpl` via `buildHarnesses`.
   * Daemon itself never reads this field; it's declared here only so that
   * production wiring in main.ts can fail loudly when LegacyClaudeImpl
   * needs a runner the caller forgot to supply. Tests and Phase-1+ harness
   * callers that don't construct LegacyClaudeImpl can omit it.
   */
  runner?: Runner;
  dbPath: string;
  shutdownTimeoutMs?: number;
  /** Engine tick interval (ms) for re-driving in-flight tasks. Defaults to 5000. */
  pollIntervalMs?: number;
  apiPort?: number;
  /**
   * Bind host for the HTTP API server. Defaults to `127.0.0.1` so the
   * daemon API is unreachable across the network unless operators opt in.
   * Cost-mutating routes additionally require a bearer token.
   */
  apiBindHost?: string;
  /**
   * Bearer token required on cost-mutating API routes (`POST /artifacts`,
   * `POST /v1/artifacts/acquire`). main.ts generates one at startup
   * (or reads from `DAEMON_API_TOKEN`) and passes it here. When omitted
   * (e.g. unit tests that don't exercise the cost-mutating routes), the
   * Daemon synthesizes a random per-process token so the server still
   * has something to compare against.
   */
  apiToken?: string;
  peers?: string[];
  signer?: EthHttpSigner;
  /** This node's public HTTP endpoint (for 8004 registration) */
  nodeEndpoint?: string;
  x402?: X402Config;

  /**
   * Periodic stOLAS distributor reward claims (master EOA pays gas).
   * Omitted or interval 0 → loop not started.
   */
  rewardClaim?: RewardClaimLoopConfig;

  /**
   * Periodic agent EOA and Safe balance top-ups from the master wallet.
   * Omitted or interval 0 → loop not started.
   */
  balanceTopup?: BalanceTopupLoopConfig;

  /**
   * Periodic eviction-check + auto-restake loop (jinn-mono-hjex.3).
   * Polls getStakingState for each service; restakes automatically when evicted.
   * Omitted or interval 0 → loop not started.
   */
  evictionCheck?: EvictionLoopConfig;

  /**
   * Periodic `checkpoint()` loop (issue #505). Advances `tsCheckpoint` on
   * each unique staking proxy so the activity-rate window stays narrow
   * (default 5 min, matching `livenessPeriod`). Without this, operators on
   * realistic cadence silently fail every liveness check.
   * Omitted or interval 0 → loop not started.
   */
  checkpoint?: CheckpointLoopConfig;

  /**
   * Cross-chain JINN claim loop (jinn-mono-7x5). Emits ClaimTicket on L2,
   * waits for finality (canonical) or plants a fixture (mock), and submits
   * the L1 distributor claim. Omitted or interval 0 → loop not started.
   */
  jinnClaim?: JinnClaimLoopConfig;

  /** Passed to HTTP API for GET /v1/status (fleet + RPC hints). */
  status?: StatusGatherConfig;

  /**
   * Daemon-side Corpus factory. Invoked after the Daemon constructs its
   * Store so the corpus shares the same SQLite handle. When set, the API
   * server exposes `POST /v1/artifacts/acquire` so the MCP subprocess can
   * acquire artifacts without ever holding the agent EOA private key. Built
   * in `main.ts` once the discovery layer is wired (see
   * spec/2026-05-11-discovery-api-and-shared-indexer.md). See
   * spec/2026-04-30-phase-a-umbrella.md §4.
   */
  corpusFactory?: (store: Store) => Corpus;

  /**
   * If provided, the Daemon uses this already-started API server instead of
   * starting its own. Used by the setup-mode flow in main.ts where the API
   * needs to come up before bootstrap completes so the operator dashboard is
   * reachable while the fleet is still bootstrapping (e.g. awaiting funding).
   *
   * The Daemon does NOT close an injected API server — ownership stays with
   * the caller (main.ts's shutdown handler closes it explicitly).
   */
  apiServer?: ApiServer;

  /**
   * If provided, the Daemon uses this Store instead of constructing a new one
   * from `dbPath`. Used by the setup-mode flow in main.ts where the API
   * server needs the Store before the Daemon is constructed; sharing one
   * Store instance avoids two parallel SQLite connections + schema setups
   * on the same file.
   *
   * When supplied, the Daemon does NOT close the Store on stop() —
   * ownership stays with the caller.
   */
  store?: Store;

  /** Restoration task sources polled by CreatorLoop. */
  taskSources?: TaskSource[];
  /** Backwards-compatible static tasks; used when taskSources is omitted. */
  tasks?: Task[];

  /**
   * Creator Safe address — used to scope CreatorLoop's SQLite idempotency
   * cache keys per-Safe. Without this, two co-located daemons on the same
   * DB would collide. Optional for backwards compatibility.
   */
  creatorSafeAddress?: string;

  /**
   * TaskEngine — sole path for marketplace request → claim → run → deliver.
   * Evaluation tasks (`role === 'evaluation'`) dispatch via `supports()` to
   * evaluation Harnesses; health-check tasks with no solverType use `legacy-claude` via
   * the registry default.
   */
  restorationEngine: Omit<TaskEngineOptions, 'store' | 'packagingDeps'> & {
    /**
     * Packaging deps minus `store` (Daemon owns the SQLite handle and threads
     * it in at construction time).
     */
    packagingDeps?: Omit<NonNullable<TaskEngineOptions['packagingDeps']>, 'store'>;
  };

  /**
   * Per-harness readiness registry for pre-claim gating.
   * When present, the engine-watcher loop checks harness readiness before
   * claiming each task and skips tasks whose harness reports not-ready.
   * Constructed and started by main.ts; omitted in unit-test contexts that
   * don't exercise the cost-mutating claim path.
   */
  harnessReadinessRegistry?: HarnessReadinessRegistry;
}

export class Daemon {
  private store: Store;
  private creatorLoop: CreatorLoop;
  private restorationEngine: TaskEngine;
  private engineStopped = false;
  private deliveryWatcherLoop: DeliveryWatcherLoop;
  private adapter: ExecutionAdapter;
  private loopPromises: Promise<void>[] = [];
  private cachedShutdownState: string | null = null;
  private apiServer?: ApiServer;
  private ownsApiServer = false;
  private ownsStore = false;
  private peerSync?: PeerSync;
  private readonly apiPort: number;
  private readonly apiToken: string;
  private rewardClaimLoop?: RewardClaimLoop;
  private balanceTopupLoop?: BalanceTopupLoop;
  private evictionLoop?: EvictionLoop;
  private checkpointLoop?: CheckpointLoop;
  private jinnClaimLoop?: JinnClaimLoop;
  private skipLogDeduper = new SkipLogDeduper();

  constructor(private readonly config: DaemonConfig) {
    if (config.store) {
      this.store = config.store;
      this.ownsStore = false;
    } else {
      this.store = new Store(config.dbPath);
      this.ownsStore = true;
    }
    this.adapter = config.adapter;
    this.apiPort = config.apiPort ?? parseInt(process.env['JINN_API_PORT'] ?? String(DEFAULT_API_PORT));
    // When the embedder didn't supply a token (e.g. a unit test that doesn't
    // exercise the cost-mutating routes), fall back to a fresh random token
    // so the API server still has something to compare bearer headers
    // against. Production callers (main.ts) always pass an explicit token.
    this.apiToken = config.apiToken ?? randomBytes(32).toString('hex');
    const taskSources = config.taskSources
      ?? (config.tasks ? [new StaticConfiguredTaskSource(config.tasks)] : []);
    this.creatorLoop = new CreatorLoop(
      this.adapter,
      taskSources,
      this.store,
      config.creatorSafeAddress,
    );
    this.deliveryWatcherLoop = new DeliveryWatcherLoop(this.adapter, this.store);

    this.restorationEngine = new TaskEngine({
      ...config.restorationEngine,
      store: this.store,
      packagingDeps: config.restorationEngine.packagingDeps
        ? { ...config.restorationEngine.packagingDeps, store: this.store }
        : undefined,
    });

    if (config.rewardClaim && config.rewardClaim.intervalMs > 0) {
      this.rewardClaimLoop = new RewardClaimLoop({
        ...config.rewardClaim,
        jinnStore: this.store,
      });
    }
    if (config.balanceTopup && config.balanceTopup.intervalMs > 0) {
      this.balanceTopupLoop = new BalanceTopupLoop({
        ...config.balanceTopup,
        jinnStore: this.store,
      });
    }
    if (config.evictionCheck && config.evictionCheck.intervalMs > 0) {
      this.evictionLoop = new EvictionLoop(config.evictionCheck);
    }
    if (config.checkpoint && config.checkpoint.intervalMs > 0) {
      this.checkpointLoop = new CheckpointLoop(config.checkpoint);
    }
    if (config.jinnClaim && config.jinnClaim.intervalMs > 0) {
      this.jinnClaimLoop = new JinnClaimLoop({
        ...config.jinnClaim,
        jinnStore: this.store,
      });
    }
  }

  async start(): Promise<void> {
    await this.adapter.initialize();
    this.store.setShutdownState('running');
    this.store.setDaemonStartedAt(new Date().toISOString());
    this.cachedShutdownState = 'running';
    emitEvent(this.store, { kind: 'startup', outcome: 'ok', detail: 'Daemon started' }, 'daemon');

    // Start HTTP API server (or adopt the one main.ts started early in
    // setup-mode). When injected, ownership stays with the caller — see
    // DaemonConfig.apiServer.
    const corpus = this.config.corpusFactory
      ? this.config.corpusFactory(this.store)
      : undefined;
    if (this.config.apiServer) {
      this.apiServer = this.config.apiServer;
      this.ownsApiServer = false;
    } else {
      this.apiServer = await startApiServer({
        port: this.apiPort,
        store: this.store,
        apiToken: this.apiToken,
        x402: this.config.x402,
        status: this.config.status,
        bindHost: this.config.apiBindHost,
        corpus,
      });
      this.ownsApiServer = true;
    }

    // Start peer sync if peers configured
    const peers = this.config.peers ?? (process.env['JINN_PEERS'] ?? '').split(',').filter(Boolean);
    if (peers.length > 0) {
      this.peerSync = new PeerSync({
        peers,
        store: this.store,
        signer: this.config.signer,
      });
      this.loopPromises.push(
        this.peerSync.run().catch(err => {
          console.error('[daemon] peer-sync crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'peer-sync loop crashed',
            errorCode: 'peer_sync_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }

    const engine = this.restorationEngine;
    await engine.recoverInFlight();
    this.loopPromises.push(
      this.creatorLoop.run().catch(err => {
        console.error('[daemon] creator crashed:', err);
        emitStructured({
          kind: 'error',
          message: 'creator loop crashed',
          errorCode: 'creator_crashed',
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }),
      this._runEngineWatcherLoop(engine).catch(err => {
        console.error('[daemon] engine-watcher crashed:', err);
        emitStructured({
          kind: 'error',
          message: 'engine-watcher loop crashed',
          errorCode: 'engine_watcher_crashed',
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }),
      engine.runTickLoop(this.config.pollIntervalMs ?? 5000).catch(err => {
        console.error('[daemon] engine-tick crashed:', err);
        emitStructured({
          kind: 'error',
          message: 'engine-tick loop crashed',
          errorCode: 'engine_tick_crashed',
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }),
      this.deliveryWatcherLoop.run().catch(err => {
        console.error('[daemon] delivery-watcher crashed:', err);
        emitStructured({
          kind: 'error',
          message: 'delivery-watcher loop crashed',
          errorCode: 'delivery_watcher_crashed',
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }),
    );

    if (this.rewardClaimLoop) {
      this.loopPromises.push(
        this.rewardClaimLoop.run().catch(err => {
          console.error('[daemon] reward-claim crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'reward-claim loop crashed',
            errorCode: 'reward_claim_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.balanceTopupLoop) {
      this.loopPromises.push(
        this.balanceTopupLoop.run().catch(err => {
          console.error('[daemon] balance-topup crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'balance-topup loop crashed',
            errorCode: 'balance_topup_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.evictionLoop) {
      this.loopPromises.push(
        this.evictionLoop.run().catch(err => {
          console.error('[daemon] eviction-check crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'eviction-check loop crashed',
            errorCode: 'eviction_check_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.checkpointLoop) {
      this.loopPromises.push(
        this.checkpointLoop.run().catch(err => {
          console.error('[daemon] checkpoint-loop crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'checkpoint loop crashed',
            errorCode: 'checkpoint_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.jinnClaimLoop) {
      this.loopPromises.push(
        this.jinnClaimLoop.run().catch(err => {
          console.error('[daemon] jinn-claim crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'jinn-claim loop crashed',
            errorCode: 'jinn_claim_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }

    emitStructured({ kind: 'system', message: 'daemon loops started' });
  }

  async stop(): Promise<void> {
    emitStructured({ kind: 'system', message: 'daemon loops stopping' });
    this.creatorLoop.stop();
    this.engineStopped = true;
    this.restorationEngine.stop();
    await this.restorationEngine.releaseClaimedNotStarted().catch(err => {
      console.error('[daemon] engine releaseClaimedNotStarted failed (non-fatal):', err);
      emitStructured({
        kind: 'error',
        message: 'engine releaseClaimedNotStarted failed',
        errorCode: 'engine_release_failed',
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    });
    this.deliveryWatcherLoop.stop();
    this.rewardClaimLoop?.stop();
    this.balanceTopupLoop?.stop();
    this.evictionLoop?.stop();
    this.checkpointLoop?.stop();
    this.jinnClaimLoop?.stop();
    this.peerSync?.stop();

    // Stop the adapter to unblock any pending async iterators
    await this.adapter.stop();
    // Only close the API server if we started it. When main.ts injected a
    // pre-started server (setup-mode flow), it owns shutdown.
    if (this.ownsApiServer) {
      await this.apiServer?.close();
    }

    const timeout = this.config.shutdownTimeoutMs ?? 30000;
    await Promise.race([
      Promise.allSettled(this.loopPromises),
      new Promise(r => setTimeout(r, timeout)),
    ]);

    this.store.setShutdownState('clean');
    this.cachedShutdownState = 'clean';
    emitEvent(this.store, { kind: 'shutdown', outcome: 'ok', detail: 'Daemon stopped cleanly' }, 'daemon');
    // Only close the Store if we own it. When main.ts injected one, the
    // caller's shutdown handler closes it after the Daemon stops.
    if (this.ownsStore) {
      this.store.close();
    }
  }

  getShutdownState(): string | null {
    return this.cachedShutdownState;
  }

  /**
   * Bridge loop: consumes adapter.watchForTasks(), claims eligible Tasks, and
   * routes each internal request to the TaskEngine via observe() + process().
   *
   * For tasks without solverType, the engine dispatches to the legacy-claude Harness.
   * For portfolio.v0 tasks, the engine dispatches to claude-mcp-hyperliquid.
   * For portfolio.v0.eval tasks, the engine dispatches to portfolio-v0-evaluator.
   *
   * On-chain provenance is populated from TaskCreated and TaskAttemptCreated.
   */
  private async _runEngineWatcherLoop(engine: TaskEngine): Promise<void> {
    const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 h
    // Yield to the macrotask queue every N announcements so even the first full
    // scan of a large backlog hands control back to the HTTP server (so /health
    // doesn't spike) instead of running as one uninterruptible contiguous block.
    const YIELD_EVERY = 10;
    let scanned = 0;

    for await (const taskAnnouncement of this.adapter.watchForTasks()) {
      if (this.engineStopped) break;
      if (!taskAnnouncement.taskId) continue;

      if (++scanned % YIELD_EVERY === 0) {
        // setImmediate schedules a macrotask: the event loop drains pending I/O
        // callbacks (HTTP requests) before resuming this loop.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.engineStopped) break;
      }

      // canAcceptTask() resolves manifests, validates schemas, and probes
      // impl.isReady() — expensive enough that re-running it for every
      // persistently-unacceptable task each pass starves the HTTP API. Fast-skip
      // tasks skipped within the bounded SKIP_RECHECK_TTL_MS; once the TTL
      // elapses we fall through so a now-acceptable task is still picked up.
      if (!this.skipLogDeduper.shouldRecheck(taskAnnouncement.taskId)) {
        continue;
      }

      const solverType = taskAnnouncement.task.solverType ?? undefined;
      const taskRole = (taskAnnouncement.task.role ?? 'restoration') as 'restoration' | 'evaluation';
      const accept = await engine.canAcceptTask({ solverType, taskRole, task: taskAnnouncement.task });
      if (!accept.ok) {
        this.skipLogDeduper.recordSkip(taskAnnouncement.taskId, accept.reason);
        // Log once per (taskId, reason) — the engine-watcher re-observes every
        // pending task each pass, so an unguarded log here floods the console.
        if (this.skipLogDeduper.shouldLog(taskAnnouncement.taskId, accept.reason)) {
          console.log(`[daemon] skipping task ${taskAnnouncement.taskId} — ${accept.reason}`);
        }
        continue;
      }
      // Task is acceptable now; reset skip state so a future skip logs once and
      // is re-checked immediately rather than fast-skipped.
      this.skipLogDeduper.forget(taskAnnouncement.taskId);

      // Readiness gate: if the task's harness is not ready (e.g. claude unauthenticated),
      // skip this task without blocking other loops. Logs once per ready↔not-ready transition.
      if (this.config.harnessReadinessRegistry) {
        const manifestCid = taskAnnouncement.task.solverNetManifestCid;
        if (manifestCid) {
          const gate = gateClaimByReadiness({
            manifestCid,
            registry: this.config.harnessReadinessRegistry,
            logger: { warn: (msg) => console.warn(msg), info: (msg) => console.log(msg) },
          });
          if (!gate.proceed) continue;
        }
      }

      let request;
      let runStartedAt: number;
      try {
        request = await this.adapter.claimTask(taskAnnouncement.taskId);
        this.store.recordOwnActivity(request.requestId, 'claimed');
        runStartedAt = Date.now();
      } catch (err) {
        console.error(
          `[daemon] claimTask failed for task ${taskAnnouncement.taskId}:`,
          err instanceof Error ? err.message : err,
        );
        emitEvent(this.store, {
          kind: 'tick_error',
          requestId: taskAnnouncement.taskId,
          solverType,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'daemon');
        continue;
      }

      const windowStartTs = request.task.window?.startTs ?? Date.now();
      const windowEndTs = request.task.window?.endTs ?? (windowStartTs + DEFAULT_WINDOW_MS);

      // Warn on missing provenance; local/test adapters may legitimately lack it.
      if (!request.taskCid) {
        console.warn(`[daemon] task ${request.requestId} missing provenance field taskCid — manifest integrity checks may fail`);
      }
      if (!request.onchainCreationTx) {
        console.warn(`[daemon] task ${request.requestId} missing provenance field onchainCreationTx — manifest integrity checks may fail`);
      }
      if (request.onchainCreationBlock == null) {
        console.warn(`[daemon] task ${request.requestId} missing provenance field onchainCreationBlock — manifest integrity checks may fail`);
      }

      try {
        await engine.observe({
          requestId: request.requestId,
          taskId: request.taskId ?? taskAnnouncement.taskId,
          attemptIndex: request.attemptIndex,
          taskCid: request.taskCid ?? '',
          onchainCreationTx: request.onchainCreationTx ?? (request.requestId as `0x${string}`),
          onchainCreationBlock: request.onchainCreationBlock ?? 0,
          solverType,
          taskRole: (request.task.role ?? 'restoration') as 'restoration' | 'evaluation',
          windowStartTs,
          windowEndTs,
          runStartedAt,
          task: request.task,
        });

        // Drive the engine state machine for this request.
        // process() advances one transition per call; the engine handles retries
        // internally on the next daemon iteration if the task is re-encountered.
        // Fire-and-forget: each task processes independently. SQLite serialises
        // writes through better-sqlite3's synchronous interface, so concurrent
        // process() calls don't corrupt state. Future readers: do NOT await — that
        // would serialise all task processing into a single queue.
        engine.process(request.requestId).catch(err => {
          console.error(`[daemon] engine.process failed for ${request.requestId}:`, err instanceof Error ? err.message : err);
          emitEvent(this.store, {
            kind: 'tick_error',
            requestId: request.requestId,
            solverType,
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          }, 'daemon');
        });
      } catch (err) {
        console.error(`[daemon] engine.observe failed for ${request.requestId}:`, err instanceof Error ? err.message : err);
        emitEvent(this.store, {
          kind: 'tick_error',
          requestId: request.requestId,
          solverType,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'daemon');
      }
    }
  }

}
