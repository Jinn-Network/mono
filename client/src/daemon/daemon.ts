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
import { BalanceTopupLoop, type BalanceTopupLoopConfig } from './balance-topup-loop.js';
import { EvictionLoop, type EvictionLoopConfig } from './eviction-loop.js';
import { HarvestLoop, type HarvestLoopConfig } from './harvest-loop.js';
import { CheckpointLoop, type CheckpointLoopConfig } from './checkpoint-loop.js';
import { WatchdogLoop, type WatchdogLoopRegistration } from './watchdog-loop.js';
import { recordLoopTick, LOOP_REGISTRY, type LoopName } from './loop-heartbeat.js';
import { emitEvent } from '../observability/emit-event.js';
import { emitStructured } from '../events/emitter.js';
import { StaticConfiguredTaskSource, type TaskSource } from '../tasks/sources.js';
import type { Task } from '../types/index.js';
import type { SignedEnvelope } from '../types/envelope.js';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import type { SpendCapDaemonConfig } from '../spend/daemon-config.js';
import type { AiUnitsDaemonConfig } from '../spend/ai-units-config.js';
import type { OperatorComposition } from './composition-root.js';
import { WorkLoop, type WorkLoopConfig } from './work-loop.js';
import { EvidenceDriverLoop } from './evidence-driver.js';
import type { ProjectorLoop } from './projector-loop.js';

type Corpus = CoreCorpus<SignedEnvelope>;

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

  /** Resolved swe-rebench-v2 state dir from loadConfig; threaded to creator hooks. */
  sweRebenchV2StateDir?: string;

  /**
   * Per-harness readiness registry for pre-claim gating on work/evaluator loops.
   * Constructed and started by main.ts; omitted in unit-test contexts that
   * don't exercise the cost-mutating claim path.
   */
  harnessReadinessRegistry?: HarnessReadinessRegistry;

  /** Per-credential daily spend caps. Omitted -> no spend gating. */
  spendCap?: SpendCapDaemonConfig;

  /**
   * AI-units ceiling — issue #815. Omitted only when no joined SolverNet resolves to a billed credential.
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
  private corpus?: Corpus;

  constructor(private readonly config: DaemonConfig) {
    if (config.store) {
      this.store = config.store;
      this.ownsStore = false;
    } else {
      this.store = new Store(config.dbPath);
      this.ownsStore = true;
    }
    // #1393: build the corpus once, at construction time, so the API server
    // shares one instance. Safe w.r.t. the #649 start() ordering constraint:
    // createCorpus is pure closure construction — no store writes, no network I/O.
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
    // Corpus is constructed in the constructor (#1393) for the API server.
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
    // railway.toml, maxRetries=10) → the existing idempotent boot path and
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

}
