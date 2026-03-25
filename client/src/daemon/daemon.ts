import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import type { DesiredState } from '../types/index.js';
import { Store } from '../store/store.js';
import { CreatorLoop } from './creator.js';
import { RestorerLoop } from './restorer.js';

export interface DaemonConfig {
  adapter: ExecutionAdapter;
  runner: Runner;
  desiredStates: DesiredState[];
  dbPath: string;
  shutdownTimeoutMs?: number;
}

export class Daemon {
  private store: Store;
  private creatorLoop: CreatorLoop;
  private restorerLoop: RestorerLoop;
  private adapter: ExecutionAdapter;
  private loopPromises: Promise<void>[] = [];
  private cachedShutdownState: string | null = null;

  constructor(private readonly config: DaemonConfig) {
    this.store = new Store(config.dbPath);
    this.adapter = config.adapter;
    this.creatorLoop = new CreatorLoop(this.adapter, config.desiredStates, this.store);
    this.restorerLoop = new RestorerLoop(this.adapter, config.runner, this.store);
  }

  async start(): Promise<void> {
    await this.adapter.initialize();
    this.store.setShutdownState('running');
    this.cachedShutdownState = 'running';

    this.loopPromises = [
      this.creatorLoop.run().catch(err => console.error('[daemon] creator crashed:', err)),
      this.restorerLoop.run().catch(err => console.error('[daemon] restorer crashed:', err)),
    ];
  }

  async stop(): Promise<void> {
    this.creatorLoop.stop();
    this.restorerLoop.stop();

    // Stop the adapter to unblock any pending async iterators
    await this.adapter.stop();

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
