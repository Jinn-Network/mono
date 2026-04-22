import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import type { DesiredState } from '../types/index.js';
import { Store } from '../store/store.js';
import { CreatorLoop, type IntentGenerator } from './creator.js';
import { RestorerLoop } from './restorer.js';
import { DeliveryWatcherLoop } from './delivery-watcher.js';
import { startApiServer, type ApiServer } from '../api/server.js';
import type { StatusGatherConfig } from '../api/gather-status.js';
import { PeerSync } from '../api/peers.js';
import type { EthHttpSigner } from '../auth/erc8128.js';
import { Registry8004, type RegistryConfig } from '../discovery/registry.js';
import { queryArtifacts, queryNodes, getMetadataValue, type SubgraphConfig } from '../discovery/subgraph.js';
import type { X402Config } from '../x402/handler.js';
import { RewardClaimLoop, type RewardClaimLoopConfig } from './reward-claim-loop.js';
import { RestorationEngine, type RestorationEngineOptions } from '../restorer/engine/engine.js';
import { BalanceTopupLoop, type BalanceTopupLoopConfig } from './balance-topup-loop.js';
import { emitEvent } from '../observability/emit-event.js';

const DEFAULT_API_PORT = 7331;

export interface DaemonConfig {
  adapter: ExecutionAdapter;
  runner: Runner;
  desiredStates: DesiredState[];
  dbPath: string;
  shutdownTimeoutMs?: number;
  /** Engine tick interval (ms) for re-driving in-flight intents. Defaults to 5000. */
  pollIntervalMs?: number;
  apiPort?: number;
  peers?: string[];
  signer?: EthHttpSigner;
  registry?: RegistryConfig;
  subgraphUrl?: string;
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

  /** Passed to HTTP API for GET /v1/status (fleet + RPC hints). */
  status?: StatusGatherConfig;

  /**
   * Extra intent generators called each CreatorLoop tick. Each returns a
   * freshly-built DesiredState (or null to skip this tick). Used e.g. for
   * auto-posting price-aware prediction.v0 intents on testnet.
   */
  intentGenerators?: IntentGenerator[];

  /**
   * Creator Safe address — used to scope CreatorLoop's SQLite idempotency
   * cache keys per-Safe. Without this, two co-located daemons on the same
   * DB would collide. Optional for backwards compatibility.
   */
  creatorSafeAddress?: string;

  /**
   * When provided, the daemon uses RestorationEngine (new engine path) instead
   * of the legacy RestorerLoop for intent dispatch.
   *
   * Required for portfolio.v0 spec kind (both restoration and evaluation).
   * Evaluation intents (type === 'evaluation') are dispatched via supports() to
   * portfolio-v0-evaluator; legacy health-check intents (no spec) fall back to
   * legacy-claude via the default impl in the registry.
   */
  restorationEngine?: Omit<RestorationEngineOptions, 'store'>;
}

export class Daemon {
  private store: Store;
  private creatorLoop: CreatorLoop;
  /** @deprecated Kept for backwards compatibility (test suite). Not started when restorationEngine is configured. */
  private restorerLoop: RestorerLoop;
  private restorationEngine?: RestorationEngine;
  private engineStopped = false;
  private deliveryWatcherLoop: DeliveryWatcherLoop;
  private adapter: ExecutionAdapter;
  private loopPromises: Promise<void>[] = [];
  private cachedShutdownState: string | null = null;
  private apiServer?: ApiServer;
  private peerSync?: PeerSync;
  private registry?: Registry8004;
  private readonly apiPort: number;
  private rewardClaimLoop?: RewardClaimLoop;
  private balanceTopupLoop?: BalanceTopupLoop;

  constructor(private readonly config: DaemonConfig) {
    this.store = new Store(config.dbPath);
    this.adapter = config.adapter;
    this.apiPort = config.apiPort ?? parseInt(process.env['JINN_API_PORT'] ?? String(DEFAULT_API_PORT));
    this.creatorLoop = new CreatorLoop(
      this.adapter,
      config.desiredStates,
      this.store,
      config.intentGenerators ?? [],
      config.creatorSafeAddress,
    );
    this.restorerLoop = new RestorerLoop(this.adapter, config.runner, this.store, '/tmp', 300000, `http://127.0.0.1:${this.apiPort}`);
    this.deliveryWatcherLoop = new DeliveryWatcherLoop(this.adapter, this.store);

    if (config.restorationEngine) {
      this.restorationEngine = new RestorationEngine({
        ...config.restorationEngine,
        store: this.store,
      });
    }

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
  }

  async start(): Promise<void> {
    await this.adapter.initialize();
    this.store.setShutdownState('running');
    this.cachedShutdownState = 'running';
    emitEvent(this.store, { kind: 'startup', outcome: 'ok', detail: 'Daemon started' }, 'daemon');

    // Start HTTP API server
    this.apiServer = await startApiServer({
      port: this.apiPort,
      store: this.store,
      onArtifactPublished: (artifact) => this.registerArtifact(artifact),
      x402: this.config.x402,
      status: this.config.status,
    });

    // Initialize 8004 registry if configured
    if (this.config.registry) {
      this.registry = new Registry8004(this.config.registry);
      console.log('[daemon] 8004 registry configured');
    }

    // Backfill remote artifacts from subgraph if configured
    const subgraphUrl = this.config.subgraphUrl ?? process.env['JINN_SUBGRAPH_URL'];
    if (subgraphUrl) {
      try {
        await this.backfillFromSubgraph({ url: subgraphUrl });
      } catch (err) {
        console.error('[daemon] Subgraph backfill failed (non-fatal):', err instanceof Error ? err.message : err);
        emitEvent(this.store, {
          kind: 'tick_error',
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'daemon');
      }
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
        this.peerSync.run().catch(err => console.error('[daemon] peer-sync crashed:', err)),
      );
    }

    if (this.restorationEngine) {
      // Engine path: recover in-flight intents, then run event-watching loop.
      const engine = this.restorationEngine;
      await engine.recoverInFlight();
      this.loopPromises.push(
        this.creatorLoop.run().catch(err => console.error('[daemon] creator crashed:', err)),
        this._runEngineWatcherLoop(engine).catch(err => console.error('[daemon] engine-watcher crashed:', err)),
        engine.runTickLoop(this.config.pollIntervalMs ?? 5000).catch(err => console.error('[daemon] engine-tick crashed:', err)),
        this.deliveryWatcherLoop.run().catch(err => console.error('[daemon] delivery-watcher crashed:', err)),
      );
    } else {
      // Legacy path: RestorerLoop handles claim + run + submitResult.
      this.loopPromises.push(
        this.creatorLoop.run().catch(err => console.error('[daemon] creator crashed:', err)),
        this.restorerLoop.run().catch(err => console.error('[daemon] restorer crashed:', err)),
        this.deliveryWatcherLoop.run().catch(err => console.error('[daemon] delivery-watcher crashed:', err)),
      );
    }

    if (this.rewardClaimLoop) {
      this.loopPromises.push(
        this.rewardClaimLoop.run().catch(err => console.error('[daemon] reward-claim crashed:', err)),
      );
    }
    if (this.balanceTopupLoop) {
      this.loopPromises.push(
        this.balanceTopupLoop.run().catch(err => console.error('[daemon] balance-topup crashed:', err)),
      );
    }
  }

  async stop(): Promise<void> {
    this.creatorLoop.stop();
    this.restorerLoop.stop();
    this.engineStopped = true;
    if (this.restorationEngine) {
      this.restorationEngine.stop();
      await this.restorationEngine.releaseClaimedNotStarted().catch(err =>
        console.error('[daemon] engine releaseClaimedNotStarted failed (non-fatal):', err),
      );
    }
    this.deliveryWatcherLoop.stop();
    this.rewardClaimLoop?.stop();
    this.balanceTopupLoop?.stop();
    this.peerSync?.stop();

    // Stop the adapter to unblock any pending async iterators
    await this.adapter.stop();
    await this.apiServer?.close();

    const timeout = this.config.shutdownTimeoutMs ?? 30000;
    await Promise.race([
      Promise.allSettled(this.loopPromises),
      new Promise(r => setTimeout(r, timeout)),
    ]);

    this.store.setShutdownState('clean');
    this.cachedShutdownState = 'clean';
    emitEvent(this.store, { kind: 'shutdown', outcome: 'ok', detail: 'Daemon stopped cleanly' }, 'daemon');
    this.store.close();
  }

  getShutdownState(): string | null {
    return this.cachedShutdownState;
  }

  /**
   * Bridge loop: consumes adapter.watchForRequests() and routes each request to
   * the RestorationEngine via observe() + process().
   *
   * For legacy intents (no spec), the engine dispatches to the legacy-claude impl.
   * For portfolio.v0 intents, the engine dispatches to claude-mcp-hyperliquid.
   * For portfolio.v0.eval intents, the engine dispatches to portfolio-v0-evaluator.
   *
   * On-chain provenance (intentCid, onchainCreationTx, onchainCreationBlock) is
   * populated from the RestorationRequest when available (MechAdapter sets these
   * from the MarketplaceRequest event log). Legacy paths that don't populate them
   * fall back to safe defaults with a warning.
   */
  private async _runEngineWatcherLoop(engine: RestorationEngine): Promise<void> {
    const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 h

    for await (const request of this.adapter.watchForRequests()) {
      if (this.engineStopped) break;
      if (!request.requestId) continue;

      const specKind = request.desiredState.spec?.kind ?? undefined;
      const windowStartTs = request.desiredState.window?.startTs ?? Date.now();
      const windowEndTs = request.desiredState.window?.endTs ?? (windowStartTs + DEFAULT_WINDOW_MS);

      // Warn on missing provenance — legacy intents may legitimately lack it.
      if (!request.intentCid) {
        console.warn(`[daemon] intent ${request.requestId} missing provenance field intentCid — manifest integrity checks may fail`);
      }
      if (!request.onchainCreationTx) {
        console.warn(`[daemon] intent ${request.requestId} missing provenance field onchainCreationTx — manifest integrity checks may fail`);
      }
      if (request.onchainCreationBlock == null) {
        console.warn(`[daemon] intent ${request.requestId} missing provenance field onchainCreationBlock — manifest integrity checks may fail`);
      }

      try {
        await engine.observe({
          requestId: request.requestId,
          intentCid: request.intentCid ?? '',
          onchainCreationTx: request.onchainCreationTx ?? (request.requestId as `0x${string}`),
          onchainCreationBlock: request.onchainCreationBlock ?? 0,
          specKind,
          intentType: (request.desiredState.type ?? 'restoration') as 'restoration' | 'evaluation',
          windowStartTs,
          windowEndTs,
          desiredState: request.desiredState,
        });

        // Drive the engine state machine for this request.
        // process() advances one transition per call; the engine handles retries
        // internally on the next daemon iteration if the intent is re-encountered.
        // Fire-and-forget: each intent processes independently. SQLite serialises
        // writes through better-sqlite3's synchronous interface, so concurrent
        // process() calls don't corrupt state. Future readers: do NOT await — that
        // would serialise all intent processing into a single queue.
        engine.process(request.requestId).catch(err => {
          console.error(`[daemon] engine.process failed for ${request.requestId}:`, err instanceof Error ? err.message : err);
          emitEvent(this.store, {
            kind: 'tick_error',
            requestId: request.requestId,
            specKind,
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          }, 'daemon');
        });
      } catch (err) {
        console.error(`[daemon] engine.observe failed for ${request.requestId}:`, err instanceof Error ? err.message : err);
        emitEvent(this.store, {
          kind: 'tick_error',
          requestId: request.requestId,
          specKind,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'daemon');
      }
    }
  }

  /**
   * Register an artifact on the 8004 registry (fire-and-forget).
   * Called after local artifact publish if registry is configured.
   */
  registerArtifact(artifact: { id: string; title: string; tags: string[]; outcome: string }): void {
    if (!this.registry) return;
    const endpoint = this.config.nodeEndpoint ?? `http://localhost:${this.config.apiPort ?? DEFAULT_API_PORT}`;
    this.registry.registerArtifact({ ...artifact, endpoint }).catch(err => {
      console.error(`[daemon] 8004 artifact registration failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    });
  }

  private async backfillFromSubgraph(config: SubgraphConfig): Promise<void> {
    console.log(`[daemon] Backfilling from subgraph: ${config.url}`);

    // Backfill artifacts
    const artifacts = await queryArtifacts(config);
    let artifactCount = 0;
    for (const result of artifacts) {
      const artifactId = getMetadataValue(result, 'artifactId');
      const title = getMetadataValue(result, 'title') ?? '';
      const outcome = getMetadataValue(result, 'outcome') ?? 'UNKNOWN';
      const endpoint = getMetadataValue(result, 'endpoint') ?? '';
      const tagsRaw = getMetadataValue(result, 'tags');
      const tags = tagsRaw ? JSON.parse(tagsRaw) as string[] : [];

      if (!artifactId || !endpoint) continue;

      this.store.insertRemoteArtifact({
        id: artifactId,
        desiredStateId: '',
        requestId: '',
        title,
        tags,
        outcome: outcome as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
        ownerAddress: result.owner,
        endpoint,
      });
      artifactCount++;
    }

    // Backfill peer nodes
    const nodes = await queryNodes(config);
    const discoveredPeers: string[] = [];
    for (const result of nodes) {
      const endpoint = getMetadataValue(result, 'endpoint');
      if (endpoint) discoveredPeers.push(endpoint);
    }

    console.log(`[daemon] Backfill complete: ${artifactCount} artifacts, ${discoveredPeers.length} nodes`);

    // Auto-add discovered peers to peer sync
    if (discoveredPeers.length > 0 && this.peerSync) {
      // PeerSync is already running with configured peers — discovered peers
      // would need to be merged. For now, just log them.
      console.log(`[daemon] Discovered peers: ${discoveredPeers.join(', ')}`);
    }
  }
}
