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
    });

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
}
