/**
 * The enrichment worker's poll loop (#779), modelled on claim-relayer's
 * ClaimRelayer: a setTimeout-scheduled tick (NOT setInterval), re-entrancy
 * guarded so a slow IPFS batch never overlaps the next tick, with observable
 * /status stats.
 *
 * The worker shares no event loop with the indexer's `ponder serve` read path —
 * that process boundary is the structural fix for the 502s (#779). This class
 * just keeps the worker draining the backlog at a bounded rate.
 */
import type { EnrichDeps, EnrichBatchResult } from './enrich.js';
import { enrichBatch } from './enrich.js';
import type { EnrichmentStore } from './db.js';

export interface RunnerStats {
  ready: boolean;
  startedAt: string;
  lastError: string | null;
  ticks: number;
  discovered: number;
  enriched: number;
  failedFetch: number;
}

export interface EnrichmentRunnerConfig {
  pollIntervalMs: number;
}

export class EnrichmentRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private runInFlight: Promise<EnrichBatchResult> | null = null;
  private readonly stats: RunnerStats;

  constructor(
    private readonly store: EnrichmentStore,
    private readonly deps: EnrichDeps,
    private readonly config: EnrichmentRunnerConfig,
  ) {
    this.stats = {
      ready: false,
      startedAt: new Date().toISOString(),
      lastError: null,
      ticks: 0,
      discovered: 0,
      enriched: 0,
      failedFetch: 0,
    };
  }

  /** First poll + schedule. Does NOT itself fail loud on a dead DB: store.ready()
   *  swallows connection errors and returns false (so a schema-not-yet-present DB
   *  is "not ready", not a crash). The actual fail-loud boot guard is the
   *  pool.connect() probe in index.ts, which exits non-zero before this runs
   *  (the #1068 lesson — fail loud at boot, let Railway restart). */
  async start(): Promise<void> {
    this.stopped = false;
    // A first ready() probe surfaces a dead/missing DB at boot instead of
    // silently spinning. ready() tolerates schema-not-yet-exists (O3) — that is
    // NOT a boot failure, just "not ready yet".
    this.stats.ready = await this.store.ready();
    await this.runOnce();
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stats.ready = false;
  }

  getStatus(): RunnerStats {
    return { ...this.stats };
  }

  /** Re-entrancy guarded: a tick that arrives while a batch is in flight joins
   *  the in-flight promise instead of starting an overlapping batch. */
  async runOnce(): Promise<EnrichBatchResult> {
    if (this.runInFlight) return this.runInFlight;
    const run = this.runOnceInternal();
    this.runInFlight = run;
    try {
      return await run;
    } finally {
      if (this.runInFlight === run) this.runInFlight = null;
    }
  }

  private async runOnceInternal(): Promise<EnrichBatchResult> {
    if (!(await this.store.ready())) {
      // Schema not present yet (fresh deploy / mid rolling cutover). Back off;
      // /ready stays false until the schema resolves.
      this.stats.ready = false;
      return { discovered: 0, enriched: 0, failedFetch: 0 };
    }
    this.stats.ready = true;
    const result = await enrichBatch(this.store, this.deps);
    this.stats.ticks += 1;
    this.stats.discovered += result.discovered;
    this.stats.enriched += result.enriched;
    this.stats.failedFetch += result.failedFetch;
    return result;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledTick();
    }, this.config.pollIntervalMs);
  }

  private async runScheduledTick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error: unknown) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.scheduleNext();
    }
  }
}
