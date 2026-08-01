import { randomBytes } from 'node:crypto';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import { Store } from '../store/store.js';
import { CreatorLoop } from './creator.js';
import { startApiServer, type ApiServer } from '../api/server.js';
import type { StatusGatherConfig } from '../api/gather-status.js';
import { PeerSync } from './peer-sync.js';
import type { EthHttpSigner } from '../auth/erc8128.js';
import type { Corpus as CoreCorpus } from '@jinn-network/core/corpus-read';
import { RewardClaimLoop, type RewardClaimLoopConfig } from './reward-claim-loop.js';
import { TaskEngine, type TaskEngineOptions } from '../harnesses/engine/engine.js';
import { BalanceTopupLoop, type BalanceTopupLoopConfig } from './balance-topup-loop.js';
import { EvictionLoop, type EvictionLoopConfig } from './eviction-loop.js';
import { HarvestLoop, type HarvestLoopConfig } from './harvest-loop.js';
import { CheckpointLoop, type CheckpointLoopConfig } from './checkpoint-loop.js';
import { WatchdogLoop, type WatchdogLoopRegistration } from './watchdog-loop.js';
import { recordLoopTick, LOOP_REGISTRY, type LoopName } from './loop-heartbeat.js';
import { emitEvent } from '../observability/emit-event.js';
import { emitStructured } from '../events/emitter.js';
import {
  SafeInnerRevertError,
  isNonRecoverableInnerRevert,
  formatDecodedRevert,
} from '../adapters/mech/safe-revert.js';
import { StaticConfiguredTaskSource, type TaskSource } from '../tasks/sources.js';
import type { Task } from '../types/index.js';
import type { SignedEnvelope } from '../types/envelope.js';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import { gateClaimByReadiness } from './readiness-gate.js';
import { gateClaimBySpendCap } from './spend-cap-gate.js';
import type { SpendCapDaemonConfig } from '../spend/daemon-config.js';
import { gateClaimByAiUnits } from './ai-units-gate.js';
import type { AiUnitsDaemonConfig } from '../spend/ai-units-config.js';
import { blockIdUtc } from '../spend/ai-units.js';
import { SkipLogDeduper } from './skip-log-dedup.js';
import type { OperatorComposition } from './composition-root.js';
import { WorkLoop, type WorkLoopConfig } from './work-loop.js';
import { EvidenceDriverLoop } from './evidence-driver.js';
import type { ProjectorLoop } from './projector-loop.js';

type Corpus = CoreCorpus<SignedEnvelope>;

const DEFAULT_API_PORT = 7331;

/**
 * Engine-watcher catch sites previously logged every error at
 * level=error / kind=tick_error, including expected race-loss reverts
 * (TCMaxVerdictsReached, TCAttemptAlreadyFinalized, TCEvaluationDeadlinePassed)
 * that mean "another operator won this slot, this one is a no-op." Those
 * reverts are normal on a multi-operator network — the contract correctly
 * rejecting the race-loser — but at level=error they drowned out genuine
 * failures on dashboards.
 *
 * Gate severity on the existing `isNonRecoverableInnerRevert` classifier:
 * when a SafeInnerRevertError's decodedName is in the non-recoverable set,
 * emit `kind=race_lost / outcome=ok` (which resolves to level=info via the
 * outcome→level mapping in emitEvent). Anything else continues to emit
 * `kind=tick_error / outcome=failed / level=error`. See #574.
 */
function emitTickErrorOrRaceLost(
  store: Store,
  err: unknown,
  ctx: { requestId: string; solverType: string | undefined },
  component: string,
): 'race_lost' | 'tick_error' {
  if (err instanceof SafeInnerRevertError && isNonRecoverableInnerRevert(err.decodedName)) {
    emitEvent(store, {
      kind: 'race_lost',
      requestId: ctx.requestId,
      solverType: ctx.solverType,
      outcome: 'ok',
      // decodedName is non-null by virtue of isNonRecoverableInnerRevert returning true.
      detail: formatDecodedRevert(err.decodedName!, err.decodedArgs),
    }, component);
    return 'race_lost';
  }
  emitEvent(store, {
    kind: 'tick_error',
    requestId: ctx.requestId,
    solverType: ctx.solverType,
    outcome: 'failed',
    detail: err instanceof Error ? err.message : String(err),
  }, component);
  return 'tick_error';
}

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
   * Commit-echo harvest loop. `harvest.sources: ['sessions']` is retained as
   * configuration compatibility but reports an explicit Stage 2 parked marker
   * and performs no session mining. Omitted or interval 0 → loop not started.
   */
  harvest?: HarvestLoopConfig;

  /**
   * Periodic `checkpoint()` loop (issue #505). Advances `tsCheckpoint` on
   * each unique staking proxy so the activity-rate window stays narrow
   * (default 5 min, matching `livenessPeriod`). Without this, operators on
   * realistic cadence silently fail every liveness check.
   * Omitted or interval 0 → loop not started.
   */
  checkpoint?: CheckpointLoopConfig;

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

  /** Resolved swe-rebench-v2 state dir from loadConfig; threaded to creator/delivery hooks. */
  sweRebenchV2StateDir?: string;

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

  /** Per-credential daily spend caps. Omitted -> no spend gating. */
  spendCap?: SpendCapDaemonConfig;

  /**
   * AI-units ceiling — issue #815. When present, the engine-watcher loop
   * gates each claim on a 6h-block + 7d-window AI-units cap per credential.
   * Omitted only when no joined SolverNet resolves to a billed credential.
   */
  aiUnits?: AiUnitsDaemonConfig;

  /**
   * Loop watchdog (#1043). When supplied, the daemon seeds a heartbeat for
   * every started loop and runs a supervisor that detects any loop whose last
   * tick has gone stale. `autoRestart` is the flag-gated recovery (default OFF
   * per the locked Option A decision): off → detect + loud-log + structured
   * event only; on → non-zero process.exit so Railway's ON_FAILURE policy
   * restarts the daemon through its existing idempotent boot path. Omitted in
   * unit tests, so the watchdog is inert there.
   */
  watchdog?: {
    autoRestart: boolean;
    stalenessFactor?: number;
    checkIntervalMs?: number;
  };

  /**
   * The stage-1 cutover composition root (Task 12, `client/src/daemon/composition-root.ts`):
   * the assembled `LocalTaskExecutionBackend` + marketplace pipeline config/ports + venue +
   * (C8) real projector loop + claim gate + engagement ledger. Optional so the many existing
   * `new Daemon(...)` call sites (unit tests, non-cutover daemons) keep compiling. When present,
   * `start()` also starts `composition.projector` and an `EvidenceDriverLoop` over
   * `composition.evidence` (close-out C8) — see `work` below for the third loop.
   */
  composition?: OperatorComposition;

  /**
   * The work loop (Task 13, `client/src/daemon/work-loop.ts`): closes the claim-to-settle loop
   * against `composition`. Everything except `composition`/`store`, both of which the daemon
   * supplies itself. Omitted, or `composition` absent -> the loop is not started.
   */
  work?: Omit<WorkLoopConfig, 'composition' | 'store'>;

  /**
   * Evidence-driver loop poll interval (ms), close-out C8. Only meaningful when `composition` is
   * present — the loop drives `composition.evidence`'s local runtime `sync()` and publication
   * policy (contract 6). Defaults to `LOOP_REGISTRY`'s own `evidence-driver` entry (30000).
   */
  evidenceDriverIntervalMs?: number;
}

export class Daemon {
  private store: Store;
  private creatorLoop: CreatorLoop;
  private restorationEngine: TaskEngine;
  private engineStopped = false;
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
  private harvestLoop?: HarvestLoop;
  private checkpointLoop?: CheckpointLoop;
  private workLoop?: WorkLoop;
  private projectorLoop?: ProjectorLoop;
  private evidenceDriverLoop?: EvidenceDriverLoop;
  private watchdogLoop?: WatchdogLoop;
  private skipLogDeduper = new SkipLogDeduper();
  private corpus?: Corpus;

  constructor(private readonly config: DaemonConfig) {
    if (config.store) {
      this.store = config.store;
      this.ownsStore = false;
    } else {
      this.store = new Store(config.dbPath);
      this.ownsStore = true;
    }
    // #1393: build the corpus once, at construction time, so the TaskEngine
    // (knowledge autoload) and the API server share one instance. Safe w.r.t.
    // the #649 start() ordering constraint: createCorpus is pure closure
    // construction — no store writes, no network I/O.
    this.corpus = config.corpusFactory?.(this.store);
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
      config.sweRebenchV2StateDir,
    );
    this.restorationEngine = new TaskEngine({
      ...config.restorationEngine,
      store: this.store,
      knowledge: {
        ...config.restorationEngine.knowledge,
        ...(this.corpus ? { corpus: this.corpus } : {}),
      },
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
      this.evictionLoop = new EvictionLoop({ ...config.evictionCheck, jinnStore: this.store });
    }
    if (
      config.harvest &&
      config.harvest.intervalMs > 0 &&
      (config.harvest.repos.length > 0 || config.harvest.sources?.includes('sessions'))
    ) {
      this.harvestLoop = new HarvestLoop({ ...config.harvest, store: this.store });
    }
    if (config.checkpoint && config.checkpoint.intervalMs > 0) {
      this.checkpointLoop = new CheckpointLoop({ ...config.checkpoint, jinnStore: this.store });
    }
    if (config.composition && config.work) {
      this.workLoop = new WorkLoop({ ...config.work, composition: config.composition, store: this.store });
    }
    if (config.composition) {
      // C8: the projector and evidence-driver loops are independent of `work` — both are started
      // whenever a composition exists, regardless of whether the work loop is configured.
      this.projectorLoop = config.composition.projector;
      this.evidenceDriverLoop = new EvidenceDriverLoop({
        evidence: config.composition.evidence,
        intervalMs: config.evidenceDriverIntervalMs ?? 30_000,
        store: this.store,
      });
    }
  }

  async start(): Promise<void> {
    // adapter.initialize() is read-only (verified for MechAdapter and LocalAdapter
    // as part of #649): getBlockNumber, in-memory cursors, store reads only.
    await this.adapter.initialize();

    // Bind the API port BEFORE mutating shared store state or emitting the
    // `startup` activity event. The port bind is the cross-process mutex —
    // a racing `jinn run` invocation that survived the pidfile preflight
    // (rare, e.g. ms-scale TOCTOU) will throw EADDRINUSE here, and we'd
    // rather throw than corrupt shutdown_state / daemon_started_at / the
    // activity-events log. See issue #649.
    //
    // DO NOT add store mutations above this line — see #649.
    // Corpus is constructed in the constructor (#1393) so the engine's
    // knowledge autoload and the API server share one instance.
    const corpus = this.corpus;
    if (this.config.apiServer) {
      this.apiServer = this.config.apiServer;
      this.ownsApiServer = false;
      // The setup-mode server was built before the running-mode status block
      // (spendCaps, aiUnits) existed. Swap it in now so GET /v1/status carries
      // the running-mode view. Without this, the AI-units gate's per-credential
      // pause data and the spend-cap row never reach the dashboard.
      this.apiServer.setStatusConfig(this.config.status);
    } else {
      this.apiServer = await startApiServer({
        port: this.apiPort,
        store: this.store,
        apiToken: this.apiToken,
        status: this.config.status,
        bindHost: this.config.apiBindHost,
        corpus,
      });
      this.ownsApiServer = true;
    }

    // Only after the port is bound do we declare ourselves "running" in the
    // store and emit the startup lifecycle event. Order matters: see #649.
    this.store.setShutdownState('running');
    this.store.setDaemonStartedAt(new Date().toISOString());
    this.cachedShutdownState = 'running';
    emitEvent(this.store, { kind: 'startup', outcome: 'ok', detail: 'Daemon started' }, 'daemon');

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
    // #1422: recovery must NOT gate loop startup. RUNNING-state recovery
    // re-executes the task's impl and awaits it — for a swe-rebench-v2
    // evaluation that is a full Docker test-suite run, potentially hours —
    // and awaiting it here silenced every loop AND the #1043 watchdog for
    // the duration (zero heartbeats, zero log output). Recovery runs
    // concurrently instead; the engine's processingRequestIds guard keeps
    // the tick/watcher loops from double-driving a task recovery is still
    // executing. Deliberately not in loopPromises either, so stop()'s
    // loop-drain never waits on an in-flight impl re-execution.
    void engine.recoverInFlight().catch(err => {
      console.error('[daemon] in-flight recovery failed:', err);
      emitStructured({
        kind: 'error',
        message: 'in-flight recovery failed',
        errorCode: 'recovery_failed',
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    });
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
    if (this.harvestLoop) {
      this.loopPromises.push(
        this.harvestLoop.run().catch(err => {
          console.error('[daemon] harvest crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'harvest loop crashed',
            errorCode: 'harvest_crashed',
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
    if (this.workLoop) {
      this.loopPromises.push(
        this.workLoop.run().catch(err => {
          console.error('[daemon] work loop crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'work loop crashed',
            errorCode: 'work_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.projectorLoop) {
      this.loopPromises.push(
        this.projectorLoop.run().catch(err => {
          console.error('[daemon] projector loop crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'projector loop crashed',
            errorCode: 'projector_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.evidenceDriverLoop) {
      this.loopPromises.push(
        this.evidenceDriverLoop.run().catch(err => {
          console.error('[daemon] evidence-driver loop crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'evidence-driver loop crashed',
            errorCode: 'evidence_driver_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    // #1043 loop watchdog. Inert unless config.watchdog is supplied.
    //
    // IDEMPOTENCY (AC#3): the only recovery action is the watchdog's non-zero
    // process.exit (see watchdog-loop.ts WATCHDOG_EXIT_CODE). It does NOT add a
    // mid-flight re-execution path to any loop. A wedged daemon recovers by
    // exiting → Railway ON_FAILURE restart (deploy/railway-*-operator/
    // railway.toml, maxRetries=10) → the existing idempotent boot path:
    // engine.recoverInFlight() above (daemon.ts) re-drives in-flight tasks and
    // src/preflight/pidfile-liveness.ts clears a stale lock. Both are already
    // idempotent, so a restart cannot double-claim / double-deliver / double-pay.
    if (this.config.watchdog) {
      const interval = this.config.pollIntervalMs ?? 5000;
      // Derive the watchdog registrations from LOOP_REGISTRY (the single source
      // of loop names + defaults) — filter to the loops actually started, then
      // override the intervals that are operator/config-driven.
      const started = new Set<LoopName>(['creator']);
      if (this.rewardClaimLoop) started.add('reward-claim');
      if (this.balanceTopupLoop) started.add('balance-topup');
      if (this.evictionLoop) started.add('eviction-check');
      if (this.checkpointLoop) started.add('checkpoint');
      if (this.harvestLoop) started.add('harvest');
      if (this.workLoop) started.add('work');
      if (this.projectorLoop) started.add('projector');
      if (this.evidenceDriverLoop) started.add('evidence-driver');
      if (peers.length > 0) started.add('peer-sync');
      const overrides: Partial<Record<LoopName, number>> = {
        'reward-claim': this.config.rewardClaim?.intervalMs,
        'balance-topup': this.config.balanceTopup?.intervalMs,
        'eviction-check': this.config.evictionCheck?.intervalMs,
        checkpoint: this.config.checkpoint?.intervalMs,
        harvest: this.config.harvest?.intervalMs,
        work: this.config.work?.pollIntervalMs,
        'evidence-driver': this.config.evidenceDriverIntervalMs,
      };
      const registrations: WatchdogLoopRegistration[] = LOOP_REGISTRY
        .filter(r => started.has(r.name))
        .map(r => ({ name: r.name, intervalMs: overrides[r.name] ?? r.intervalMs, ...('floorMs' in r ? { floorMs: r.floorMs } : {}) }));

      // Seed every started loop so the watchdog never trips on first boot
      // before any loop has had a chance to tick.
      for (const reg of registrations) {
        recordLoopTick(this.store, reg.name);
      }

      this.watchdogLoop = new WatchdogLoop({
        store: this.store,
        loops: registrations,
        stalenessFactor: this.config.watchdog.stalenessFactor,
        checkIntervalMs: this.config.watchdog.checkIntervalMs,
        autoRestart: this.config.watchdog.autoRestart,
        isActive: () => this.cachedShutdownState === 'running',
      });
      this.loopPromises.push(
        this.watchdogLoop.run().catch(err => {
          console.error('[daemon] watchdog crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'watchdog loop crashed',
            errorCode: 'watchdog_crashed',
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
    this.rewardClaimLoop?.stop();
    this.balanceTopupLoop?.stop();
    this.evictionLoop?.stop();
    this.harvestLoop?.stop();
    this.checkpointLoop?.stop();
    this.workLoop?.stop();
    this.projectorLoop?.stop();
    this.evidenceDriverLoop?.stop();
    this.peerSync?.stop();
    this.watchdogLoop?.stop();

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
   * Canonical task provenance is populated from TaskCreated. The adapter keeps
   * the later TaskAttemptCreated/evaluation claim provenance in separate
   * `onchainClaim*` fields so it cannot overwrite the task creation anchor.
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

      // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
      // Task 16): the solution path retired — watchForTasks() is only supposed to yield
      // evaluation announcements now. Loud-log and skip rather than silently drop, so a
      // regression here (e.g. an adapter change that starts yielding restoration again) is
      // visible instead of quietly starving the solution path further.
      if (taskAnnouncement.task.role !== 'evaluation') {
        console.warn(
          `[engine-watcher] ignoring non-evaluation announcement ${taskAnnouncement.taskId} — the solution path retired at stage 1`,
        );
        continue;
      }

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
      const taskForEligibility = this.config.creatorSafeAddress
        ? {
            ...taskAnnouncement.task,
            eligibility: {
              ...(taskAnnouncement.task.eligibility ?? {}),
              claimantSafe: this.config.creatorSafeAddress,
            },
          }
        : taskAnnouncement.task;
      const accept = await engine.canAcceptTask({
        solverType,
        taskRole,
        task: taskForEligibility,
      });
      if (!accept.ok) {
        // Log once per (taskId, reason) — the engine-watcher re-observes every
        // pending task each pass, so an unguarded log here floods the console.
        if (this.skipLogDeduper.recordSkip(taskAnnouncement.taskId, accept.reason)) {
          console.log(`[daemon] skipping task ${taskAnnouncement.taskId} — ${accept.reason}`);
        }
        continue;
      }
      // Task is acceptable now; reset skip state so a future skip logs once and
      // is re-checked immediately rather than fast-skipped.
      this.skipLogDeduper.forget(taskAnnouncement.taskId);

      const manifestCid = taskAnnouncement.task.solverNetManifestCid;
      const gateLogger = { warn: (msg: string) => console.warn(msg), info: (msg: string) => console.log(msg) };

      // Readiness gate: if the task's harness is not ready (e.g. claude unauthenticated),
      // skip this task without blocking other loops. Logs once per ready↔not-ready transition.
      if (this.config.harnessReadinessRegistry) {
        if (manifestCid) {
          const gate = gateClaimByReadiness({
            manifestCid,
            registry: this.config.harnessReadinessRegistry,
            logger: gateLogger,
          });
          if (!gate.proceed) continue;
        }
      }

      // Spend gate (issues #815, #1004): skip claims for a credential whose
      // 6h-block or 7d-window ACTUAL USD spend + this claim's projected debit
      // would exceed the matching USD cap. The accumulator reads
      // actual_cost_usd_micros (delivered rows) / estimated_cost_usd_micros
      // (in-flight), so the gate bounds real token spend, not a flat
      // projection. For subscription credentials the USD ceiling is a *proxy*
      // budget, not an exact bound on the provider's plan quota. Layered on
      // top of the spend-cap gate below — the first guard to fire skips.
      let aiUnitsForRow: number | null = null;
      let estimatedCostUsdMicrosForRow: number | null = null;
      let modelForRow: string | null = null;
      const aiUnitsCfg = this.config.aiUnits;
      if (aiUnitsCfg && manifestCid) {
        const credentialId = aiUnitsCfg.manifestCredentials[manifestCid];
        if (credentialId) {
          // #1006: ai_units stays on the row for the legacy unit-denominated
          // /v1/status surface the SPA still reads. Remove when #1006 migrates.
          aiUnitsForRow = aiUnitsCfg.manifestProjectedAiUnits[manifestCid] ?? null;
          modelForRow = aiUnitsCfg.manifestModels[manifestCid] ?? null;
          const projectedUsdMicros = aiUnitsCfg.manifestProjectedUsdMicros[manifestCid] ?? null;
          // Capture the claim-time USD estimate on the row so the accumulator
          // has a value to read while the claim is in flight (before the
          // delivered actual replaces it via finalizeClaimDelivered).
          estimatedCostUsdMicrosForRow = projectedUsdMicros;
          const now = new Date();
          const block = this.store.usdMicrosThisBlock(credentialId, now);
          const week = this.store.usdMicrosThisWeek(credentialId, now);
          const aiGate = gateClaimByAiUnits({
            credentialId,
            projectedUsdMicros,
            usdMicrosThisBlock: block.usdMicros,
            usdMicrosThisWeek: week.usdMicros,
            capPerBlockUsdMicros: aiUnitsCfg.capPerBlockUsdMicros,
            capPerWeekUsdMicros: aiUnitsCfg.capPerWeekUsdMicros,
            blockId: blockIdUtc(now),
            logger: gateLogger,
            hasPersistedCapReached: (w, bid) =>
              this.store.hasAiUnitsCapReachedFor(credentialId, w, bid),
          });
          if (!aiGate.proceed) {
            if (aiGate.newlyPaused) {
              // Embed `[block=...][window=...]` markers in `detail` so the
              // gate can hydrate its memo from this row after a daemon
              // restart inside the same 6h block (issue #815 finding 1).
              const marker = `[block=${blockIdUtc(now)}][window=${aiGate.window}] `;
              emitEvent(this.store, {
                kind: 'ai_units_cap_reached',
                requestId: taskAnnouncement.taskId,
                outcome: 'paused',
                detail: `${marker}${aiGate.reason}`,
                credentialId,
              }, 'daemon');
            }
            continue;
          }
        }
      }

      // Spend-cap gate: skip claims for a credential that has hit its daily budget.
      if (this.config.spendCap) {
        // No manifest CID -> no credential to attribute -> task is not spend-gated.
        const credentialId = manifestCid
          ? this.config.spendCap.manifestCredentials[manifestCid]
          : undefined;
        const capUsd = credentialId ? this.config.spendCap.caps[credentialId] : undefined;
        if (credentialId && capUsd != null) {
          const spentTodayUsd = this.store.spentTodayMicros(credentialId) / 1_000_000;
          const spendGate = gateClaimBySpendCap({
            credentialId,
            capUsd,
            spentTodayUsd,
            logger: gateLogger,
          });
          if (!spendGate.proceed) {
            if (spendGate.newlyPaused) {
              emitEvent(this.store, {
                kind: 'spend_cap_reached',
                requestId: taskAnnouncement.taskId,
                outcome: 'paused',
                detail: spendGate.reason,
              }, 'daemon');
            }
            continue;
          }
        }
      }

      // Resolve credentialId once more for the enriched claim row (issue #815).
      // Prefer the AI-units mapping (which considers the harness's billed
      // credential), fall back to the spend-cap mapping for symmetry.
      const enrichedCredentialId =
        (manifestCid && aiUnitsCfg?.manifestCredentials[manifestCid]) ||
        (manifestCid && this.config.spendCap?.manifestCredentials[manifestCid]) ||
        null;

      let request;
      let runStartedAt: number;
      try {
        request = await this.adapter.claimTask(taskAnnouncement.taskId);
        // Enriched claim row per issue #815: exactly one row per request,
        // claim_status='claimed', carrying ai_units + estimated_cost_usd_micros.
        // markOwnActivity writes the membership row only; this call writes the
        // single activity_events row with the spend metadata.
        this.store.markOwnActivity(request.requestId, 'claimed');
        this.store.recordActivityEvent({
          ts: new Date().toISOString(),
          kind: 'claimed',
          requestId: request.requestId,
          solverType: solverType ?? null,
          credentialId: enrichedCredentialId,
          aiUnits: aiUnitsForRow,
          claimStatus: 'claimed',
          estimatedCostUsdMicros: estimatedCostUsdMicrosForRow,
          model: modelForRow,
        });
        runStartedAt = Date.now();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] claimTask failed for task ${taskAnnouncement.taskId}:`,
          err instanceof Error ? err.message : err,
        );
        // Issue #815: exactly one activity_events row per failed-claim
        // request, claim_status='claim_failed', ai_units=0. emitTickErrorOrRaceLost
        // below writes a separate row with the error classification (kept for
        // the existing race-loss + tick-error notification taxonomy); this
        // dedicated row is what the cap-bookkeeping read path filters on.
        this.store.recordActivityEvent({
          ts: new Date().toISOString(),
          kind: 'claim_failed',
          requestId: taskAnnouncement.taskId,
          solverType: solverType ?? null,
          credentialId: enrichedCredentialId,
          aiUnits: 0,
          claimStatus: 'claim_failed',
          detail: errorMessage,
        });
        const claimOutcome = emitTickErrorOrRaceLost(
          this.store,
          err,
          { requestId: taskAnnouncement.taskId, solverType },
          'daemon',
        );
        // Paired SSE signal for the operator-app `claim_failed` notification
        // (OPERATOR-APP-SPEC §2.10). Terminal evaluation race losses are normal
        // multi-operator no-ops — do not surface as claim_failed (#512).
        if (claimOutcome !== 'race_lost') {
          emitStructured({
            kind: 'intent',
            message: 'Task claim failed',
            requestId: taskAnnouncement.taskId,
            errorCode: 'claim_failed',
            details: {
              taskId: taskAnnouncement.taskId,
              solverType,
              source: 'daemon.claimTask',
              error: errorMessage,
            },
          });
        }
        continue;
      }

      const windowStartTs = request.task.window?.startTs ?? Date.now();
      const windowEndTs = request.task.window?.endTs ?? (windowStartTs + DEFAULT_WINDOW_MS);

      // Warn on missing provenance; local/test adapters may legitimately lack it.
      if (!request.taskCid) {
        console.warn(`[daemon] task ${request.requestId} missing provenance field taskCid — manifest integrity checks may fail`);
      }
      if (!request.onchainCreationTx || request.onchainCreationBlock == null) {
        const missing = [
          !request.onchainCreationTx ? 'onchainCreationTx' : null,
          request.onchainCreationBlock == null ? 'onchainCreationBlock' : null,
        ].filter((field): field is string => field !== null);
        const error = new Error(
          `task ${request.requestId} missing canonical TaskCreated provenance: ${missing.join(', ')}`,
        );
        console.error(`[daemon] ${error.message}; refusing to create an engine row`);
        emitTickErrorOrRaceLost(
          this.store,
          error,
          { requestId: request.requestId, solverType },
          'daemon',
        );
        continue;
      }

      try {
        await engine.observe({
          requestId: request.requestId,
          taskId: request.taskId ?? taskAnnouncement.taskId,
          attemptIndex: request.attemptIndex,
          taskCid: request.taskCid ?? '',
          onchainCreationTx: request.onchainCreationTx,
          onchainCreationBlock: request.onchainCreationBlock,
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
          emitTickErrorOrRaceLost(
            this.store,
            err,
            { requestId: request.requestId, solverType },
            'daemon',
          );
        });
      } catch (err) {
        console.error(`[daemon] engine.observe failed for ${request.requestId}:`, err instanceof Error ? err.message : err);
        emitTickErrorOrRaceLost(
          this.store,
          err,
          { requestId: request.requestId, solverType },
          'daemon',
        );
      }
    }
  }

}
