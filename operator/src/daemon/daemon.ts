import { randomBytes } from 'node:crypto';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import { Store } from '../store/store.js';
import { startApiServer, type ApiServer } from '../api/server.js';
import type { StatusGatherConfig } from '../api/gather-status.js';
import type { EthHttpSigner } from '../auth/erc8128.js';
import type { Corpus as CoreCorpus } from '@jinn-network/core/corpus-read';
import { RewardClaimLoop, type RewardClaimLoopConfig } from './reward-claim-loop.js';
import { BalanceTopupLoop, type BalanceTopupLoopConfig } from './balance-topup-loop.js';
import { EvictionLoop, type EvictionLoopConfig } from './eviction-loop.js';
import { HarvestLoop, type HarvestLoopConfig } from './harvest-loop.js';
import { CheckpointLoop, type CheckpointLoopConfig } from './checkpoint-loop.js';
import { WatchdogLoop, type WatchdogLoopRegistration } from './watchdog-loop.js';
import {
  recordLoopTick,
  LOOP_REGISTRY,
  type LoopName,
  getDaemonReadiness,
  buildLoopMetricsSnapshot,
} from './loop-heartbeat.js';
import { emitEvent } from '../observability/emit-event.js';
import { emitStructured } from '../events/emitter.js';
import { sanitizeErrorText } from '../rpc/transport.js';
import {
  SafeInnerRevertError,
  isNonRecoverableInnerRevert,
  formatDecodedRevert,
} from '../adapters/mech/safe-revert.js';
import type { SignedEnvelope } from '../types/envelope.js';
import type { OperatorComposition } from './composition-root.js';
import { WorkLoop, type WorkLoopConfig } from './work-loop.js';
import { EvaluatorLoop } from './evaluator-loop.js';
import type { NativeEvaluatorComposition } from './native-evaluator-composition.js';
import { PostingLoop, buildPostingLoop, type PostingLoopPorts } from './posting-loop.js';
import { EvidenceDriverLoop } from './evidence-driver.js';
import type { ProjectorLoop } from './projector-loop.js';
import {
  configurePhaseDTransitionUsage,
} from '../compatibility/phase-d-transition-usage.js';

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
    detail: sanitizeErrorText(err),
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
  /**
   * Parseable-but-ignored after Wave-4 D4 (peer-sync retired). Left on the
   * config shape so existing `new Daemon({ peers })` call sites and the
   * `peers` / `JINN_PEERS` config key do not become a schema break.
   */
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

  /**
   * Resolved swe-rebench-v2 state dir from loadConfig. The creator and
   * delivery-watcher hooks that consumed it retired with Wave-4 D2/D3; the
   * field stays on the config surface because `main.ts` and the harness e2e
   * rigs still pass it and the solver-type generator state store reads the
   * same directory.
   */
  sweRebenchV2StateDir?: string;

  /**
   * Loop watchdog (#1043; defaulted ON 2026-08-10, decision 3 of the
   * operator standup, #2461/#2540). When armed, the daemon seeds a heartbeat
   * for every started loop and runs a supervisor that detects any loop whose
   * last tick has gone stale. `autoRestart` is the separately flag-gated
   * recovery (default OFF per the locked Option A decision): off → detect +
   * loud-log + structured `loop_watchdog_stale` event only; on → non-zero
   * process.exit so Railway's ON_FAILURE policy restarts the daemon through
   * its existing idempotent boot path.
   *
   * DEFAULT: omitting this field now ARMS the watchdog with
   * `{ autoRestart: false }` — detection defaults on independent of whether a
   * call site remembers to opt in (round-8's live gate run found zero
   * `loop_watchdog_stale` events had ever fired because nothing wired
   * `config.watchdog`). Pass the literal `false` to fully disable — the
   * escape hatch for unit tests that don't exercise watchdog behavior and
   * don't want the extra background timer.
   *
   * Legitimate long waits (e.g. a `ready-only` loop sitting out a `degraded`
   * readiness window — funding shortfall, incomplete fleet, spec §5/#2407)
   * are already excluded from staleness upstream of this flag: `runLoop` and
   * the inline `engine-tick` loop both stamp their heartbeat every interval
   * regardless of admission, so an intentionally-paused loop never looks
   * stale to the watchdog. See `loop-heartbeat.ts` and
   * `test/daemon/loop-admission.test.ts`.
   */
  watchdog?: { autoRestart: boolean; stalenessFactor?: number; checkIntervalMs?: number } | false;

  /**
   * The stage-1 cutover composition root (Task 12, `operator/src/daemon/composition-root.ts`):
   * the assembled `LocalTaskExecutionBackend` + marketplace pipeline config/ports + venue +
   * (C8) real projector loop + claim gate + engagement ledger. Optional so the many existing
   * `new Daemon(...)` call sites (unit tests, non-cutover daemons) keep compiling. When present,
   * `start()` also starts `composition.projector` and an `EvidenceDriverLoop` over
   * `composition.evidence` (close-out C8) — see `work` below for the third loop.
   */
  composition?: OperatorComposition;

  /**
   * The work loop (Task 13, `operator/src/daemon/work-loop.ts`): closes the claim-to-settle loop
   * against `composition`. Everything except `composition`/`store`, both of which the daemon
   * supplies itself. Omitted, or `composition` absent -> the loop is not started.
   */
  work?: Omit<WorkLoopConfig, 'composition' | 'store'>;

  /**
   * The native evaluator loop (one-swap M4a, #2461, `operator/src/daemon/evaluator-loop.ts`): drives
   * the fleet evaluator composition's tick. `composition` is built by `main.ts`
   * (`buildFleetNativeEvaluator`) and passed in; the daemon supplies `store` itself. Omitted -> the
   * loop is not started. The composition's own resources (backend, evidence, discovery store) are
   * closed by `main.ts`'s shutdown handler, not the daemon — the daemon owns only the loop cadence.
   */
  evaluator?: {
    readonly composition: NativeEvaluatorComposition;
    readonly pollIntervalMs?: number;
    readonly logger?: { info(message: string): void; warn(message: string): void };
  };

  /**
   * The native posting loop (one-swap M5d, #2461, `operator/src/daemon/posting-loop.ts`): drives the
   * requester's `posting[]` config into posted Submissions. `main.ts` builds the ports
   * (`native-fleet-posting.ts`) and passes them plus the composition mode and posting-entry count;
   * the daemon supplies `store` itself and constructs the loop through `buildPostingLoop`, which is
   * the single boot-inertness gate — a legacy composition or an empty `posting[]` yields no loop,
   * so this daemon never registers the `posting` heartbeat or watchdog entry on a default boot.
   */
  posting?: {
    readonly compositionMode: 'legacy' | 'native';
    readonly postingEntryCount: number;
    readonly ports: PostingLoopPorts;
    readonly intervalMs?: number;
    readonly logger?: { info(message: string): void; warn(message: string): void };
  };

  /**
   * Evidence-driver loop poll interval (ms), close-out C8. Only meaningful when `composition` is
   * present — the loop drives `composition.evidence`'s local runtime `sync()` and publication
   * policy (contract 6). Defaults to `LOOP_REGISTRY`'s own `evidence-driver` entry (30000).
   */
  evidenceDriverIntervalMs?: number;
}

export class Daemon {
  private store: Store;
  private adapter: ExecutionAdapter;
  private loopPromises: Promise<void>[] = [];
  private cachedShutdownState: string | null = null;
  private apiServer?: ApiServer;
  private ownsApiServer = false;
  private ownsStore = false;
  private readonly apiPort: number;
  private readonly apiToken: string;
  private rewardClaimLoop?: RewardClaimLoop;
  private balanceTopupLoop?: BalanceTopupLoop;
  private evictionLoop?: EvictionLoop;
  private harvestLoop?: HarvestLoop;
  private checkpointLoop?: CheckpointLoop;
  private workLoop?: WorkLoop;
  private evaluatorLoop?: EvaluatorLoop;
  private postingLoop?: PostingLoop;
  private projectorLoop?: ProjectorLoop;
  private evidenceDriverLoop?: EvidenceDriverLoop;
  private watchdogLoop?: WatchdogLoop;
  private corpus?: Corpus;

  constructor(private readonly config: DaemonConfig) {
    configurePhaseDTransitionUsage(
      config.dbPath === ':memory:' ? undefined : `${config.dbPath}.phase-d-transition-usage.v1.json`,
    );
    if (config.store) {
      this.store = config.store;
      this.ownsStore = false;
    } else {
      this.store = new Store(config.dbPath);
      this.ownsStore = true;
    }
    // #1393: build the corpus once, at construction time, so the work loop
    // and the API server share one instance. Safe w.r.t.
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
    if (config.evaluator) {
      this.evaluatorLoop = new EvaluatorLoop({
        composition: config.evaluator.composition,
        store: this.store,
        pollIntervalMs: config.evaluator.pollIntervalMs ?? config.pollIntervalMs ?? 5000,
        ...(config.evaluator.logger ? { logger: config.evaluator.logger } : {}),
      });
    }
    if (config.posting) {
      // `buildPostingLoop` is the boot-inertness gate: legacy composition or empty `posting[]`
      // returns undefined, so no loop is constructed, heartbeated, or watchdog-registered.
      this.postingLoop = buildPostingLoop({
        compositionMode: config.posting.compositionMode,
        postingEntryCount: config.posting.postingEntryCount,
        options: {
          store: this.store,
          ports: config.posting.ports,
          ...(config.posting.intervalMs !== undefined ? { intervalMs: config.posting.intervalMs } : {}),
          ...(config.posting.logger ? { logger: config.posting.logger } : {}),
        },
      });
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
      // One-swap M6 (#2461): thread the driver into the status config so `/v1/status` carries
      // the `evidenceIndexing` block and `GET /v1/notifications` derives `evidence_indexing_failed`.
      // The producer was previously unconnected — the consumer paths existed, but nothing set
      // `evidenceDriver`, so the block was always absent. `EvidenceDriverLoop` structurally
      // satisfies `EvidenceIndexingSource` (failures()/pending()).
      if (config.status) {
        config.status.evidenceDriver = () => this.evidenceDriverLoop ?? null;
      }
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
      // Self-start path (embedded adapters / tests that construct `Daemon`
      // directly without a pre-built `config.apiServer`). No `ui` is passed
      // here, but `this.apiToken` (generated above at construction time,
      // exactly like main.ts's DAEMON_API_TOKEN resolution) is always
      // present — the server constructor's operator-class gate (§14.3) is
      // unconditional and accepts that bearer token, so this path is not
      // left unauthenticated. See `test/api/daemon-api-auth.test.ts` for the
      // gate coverage against this exact `startApiServer` argument shape.
      this.apiServer = await startApiServer({
        port: this.apiPort,
        store: this.store,
        apiToken: this.apiToken,
        status: this.config.status,
        bindHost: this.config.apiBindHost,
        corpus,
        // GET /ready + GET /metrics (spec §5/§6.1–§6.2, issue #2404) — same
        // injection reasoning as main.ts's self-built server (api→daemon
        // architecture boundary; see the field docstrings on
        // ApiServerConfig in server.ts).
        getDaemonReadiness,
        getLoopSnapshot: () => buildLoopMetricsSnapshot(this.store),
      });
      this.ownsApiServer = true;
    }

    // Work-loop lifecycle ownership is established only after the API bind mutex. Recovery must
    // finish and the signed source head must verify before any work loop can process a card.
    await this.workLoop?.initialize();

    // Only after API bind AND native fail-closed initialization do we report running. A lease,
    // recovery, or source-trust refusal must never leave a false startup-ok marker behind.
    this.store.setShutdownState('running');
    this.store.setDaemonStartedAt(new Date().toISOString());
    this.cachedShutdownState = 'running';
    emitEvent(this.store, { kind: 'startup', outcome: 'ok', detail: 'Daemon started' }, 'daemon');

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
    if (this.evaluatorLoop) {
      this.loopPromises.push(
        this.evaluatorLoop.run().catch(err => {
          console.error('[daemon] evaluator loop crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'evaluator loop crashed',
            errorCode: 'evaluator_crashed',
            details: { error: err instanceof Error ? err.message : String(err) },
          });
        }),
      );
    }
    if (this.postingLoop) {
      this.loopPromises.push(
        this.postingLoop.run().catch(err => {
          console.error('[daemon] posting loop crashed:', err);
          emitStructured({
            kind: 'error',
            message: 'posting loop crashed',
            errorCode: 'posting_crashed',
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
    // #1043 loop watchdog. Armed by default (2026-08-10 decision 3, #2461/
    // #2540) — omitting `config.watchdog` no longer means "no watchdog", it
    // means "watchdog with autoRestart: false". Pass the literal `false` to
    // opt all the way out (see the DaemonConfig.watchdog docstring above).
    //
    // IDEMPOTENCY (AC#3): the only recovery action is the watchdog's non-zero
    // process.exit (see watchdog-loop.ts WATCHDOG_EXIT_CODE). It does NOT add a
    // mid-flight re-execution path to any loop. A wedged daemon recovers by
    // exiting → Railway ON_FAILURE restart (deploy/railway-*-operator/
    // railway.toml, maxRetries=10) → the existing idempotent boot path:
    // the derivation-first boot path re-drives in-flight work and
    // src/preflight/pidfile-liveness.ts clears a stale lock. Both are already
    // idempotent, so a restart cannot double-claim / double-deliver / double-pay.
    if (this.config.watchdog !== false) {
      const watchdogConfig = this.config.watchdog ?? { autoRestart: false };
      const interval = this.config.pollIntervalMs ?? 5000;
      // Derive the watchdog registrations from LOOP_REGISTRY (the single source
      // of loop names + defaults) — filter to the loops actually started, then
      // override the intervals that are operator/config-driven.
      const started = new Set<LoopName>();
      if (this.rewardClaimLoop) started.add('reward-claim');
      if (this.balanceTopupLoop) started.add('balance-topup');
      if (this.evictionLoop) started.add('eviction-check');
      if (this.checkpointLoop) started.add('checkpoint');
      if (this.harvestLoop) started.add('harvest');
      if (this.workLoop) started.add('work');
      if (this.evaluatorLoop) started.add('evaluator');
      if (this.postingLoop) started.add('posting');
      if (this.projectorLoop) started.add('projector');
      if (this.evidenceDriverLoop) started.add('evidence-driver');
      const overrides: Partial<Record<LoopName, number>> = {
        'reward-claim': this.config.rewardClaim?.intervalMs,
        'balance-topup': this.config.balanceTopup?.intervalMs,
        'eviction-check': this.config.evictionCheck?.intervalMs,
        checkpoint: this.config.checkpoint?.intervalMs,
        harvest: this.config.harvest?.intervalMs,
        work: this.config.work?.pollIntervalMs,
        evaluator: this.config.evaluator?.pollIntervalMs ?? this.config.pollIntervalMs,
        posting: this.config.posting?.intervalMs,
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
        stalenessFactor: watchdogConfig.stalenessFactor,
        checkIntervalMs: watchdogConfig.checkIntervalMs,
        autoRestart: watchdogConfig.autoRestart,
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
    this.rewardClaimLoop?.stop();
    this.balanceTopupLoop?.stop();
    this.evictionLoop?.stop();
    this.harvestLoop?.stop();
    this.checkpointLoop?.stop();
    this.workLoop?.stop();
    this.evaluatorLoop?.stop();
    this.postingLoop?.stop();
    this.projectorLoop?.stop();
    this.evidenceDriverLoop?.stop();
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
