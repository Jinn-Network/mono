import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import type { DesiredState } from '../types/index.js';
import { Store } from '../store/store.js';
import { CreatorLoop } from './creator.js';
import { RestorerLoop } from './restorer.js';
import { DeliveryWatcherLoop } from './delivery-watcher.js';
import { startApiServer, type ApiServer } from '../api/server.js';
import { PeerSync } from '../api/peers.js';
import type { EthHttpSigner } from '../auth/erc8128.js';
import { Registry8004, type RegistryConfig } from '../discovery/registry.js';
import { queryArtifacts, queryNodes, getMetadataValue, type SubgraphConfig } from '../discovery/subgraph.js';
import type { X402Config } from '../x402/handler.js';

const DEFAULT_API_PORT = 7331;

export interface DaemonConfig {
  adapter: ExecutionAdapter;
  runner: Runner;
  desiredStates: DesiredState[];
  dbPath: string;
  shutdownTimeoutMs?: number;
  apiPort?: number;
  peers?: string[];
  signer?: EthHttpSigner;
  registry?: RegistryConfig;
  subgraphUrl?: string;
  /** This node's public HTTP endpoint (for 8004 registration) */
  nodeEndpoint?: string;
  x402?: X402Config;
}

export class Daemon {
  private store: Store;
  private creatorLoop: CreatorLoop;
  private restorerLoop: RestorerLoop;
  private deliveryWatcherLoop: DeliveryWatcherLoop;
  private adapter: ExecutionAdapter;
  private loopPromises: Promise<void>[] = [];
  private cachedShutdownState: string | null = null;
  private apiServer?: ApiServer;
  private peerSync?: PeerSync;
  private registry?: Registry8004;

  constructor(private readonly config: DaemonConfig) {
    this.store = new Store(config.dbPath);
    this.adapter = config.adapter;
    this.creatorLoop = new CreatorLoop(this.adapter, config.desiredStates, this.store);
    this.restorerLoop = new RestorerLoop(this.adapter, config.runner, this.store);
    this.deliveryWatcherLoop = new DeliveryWatcherLoop(this.adapter);
  }

  async start(): Promise<void> {
    await this.adapter.initialize();
    this.store.setShutdownState('running');
    this.cachedShutdownState = 'running';

    // Start HTTP API server
    const apiPort = this.config.apiPort ?? parseInt(process.env['JINN_API_PORT'] ?? String(DEFAULT_API_PORT));
    this.apiServer = await startApiServer({
      port: apiPort,
      store: this.store,
      onArtifactPublished: (artifact) => this.registerArtifact(artifact),
      x402: this.config.x402,
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

    this.loopPromises.push(
      this.creatorLoop.run().catch(err => console.error('[daemon] creator crashed:', err)),
      this.restorerLoop.run().catch(err => console.error('[daemon] restorer crashed:', err)),
      this.deliveryWatcherLoop.run().catch(err => console.error('[daemon] delivery-watcher crashed:', err)),
    );
  }

  async stop(): Promise<void> {
    this.creatorLoop.stop();
    this.restorerLoop.stop();
    this.deliveryWatcherLoop.stop();
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
    this.store.close();
  }

  getShutdownState(): string | null {
    return this.cachedShutdownState;
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
