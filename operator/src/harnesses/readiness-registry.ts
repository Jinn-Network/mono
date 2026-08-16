/**
 * HarnessReadinessRegistry — per-harness Harness.isReady() composition for the
 * daemon's claim loops and the SPA's per-harness setup cards.
 *
 * See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 *
 * Single writer: the background refresh tick. Readers (claim loops + the
 * /v1/harnesses/readiness endpoint) read the cached snapshot lock-free.
 * Bounded staleness = tickIntervalMs.
 */

import type { Harness, ReadyStatus } from './types.js';

export interface JoinedHarnessSpec {
  harnessName: string;
  roles: Array<'solver' | 'evaluator'>;
}

export interface HarnessReadinessSnapshot {
  lastRefreshedAt: string;  // ISO-8601
  harnesses: Array<{
    harnessName: string;
    manifestCids: string[];
    ready: boolean;
    reason?: string;
    nextStep?: ReadyStatus['nextStep'];
  }>;
}

export interface HarnessReadinessRegistryOptions {
  /** Harness instances indexed by Harness.name. */
  harnessesByName: Record<string, Harness>;
  /** joinedSolverNets shape, narrowed to harness lookup. */
  joinedHarnessesByCid: Record<string, JoinedHarnessSpec>;
  /** Background refresh interval (ms). Default 4000 (matches existing Claude auth poll cadence). */
  tickIntervalMs?: number;
  /** Per-isReady() timeout (ms). Default 5000. */
  isReadyTimeoutMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 4_000;
const DEFAULT_IS_READY_TIMEOUT_MS = 5_000;

export class HarnessReadinessRegistry {
  private readonly opts: Required<HarnessReadinessRegistryOptions>;
  private snapshot: HarnessReadinessSnapshot = {
    lastRefreshedAt: new Date(0).toISOString(),
    harnesses: [],
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  constructor(opts: HarnessReadinessRegistryOptions) {
    this.opts = {
      tickIntervalMs: opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      isReadyTimeoutMs: opts.isReadyTimeoutMs ?? DEFAULT_IS_READY_TIMEOUT_MS,
      harnessesByName: opts.harnessesByName,
      joinedHarnessesByCid: opts.joinedHarnessesByCid,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refreshNow(); }, this.opts.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): HarnessReadinessSnapshot {
    return this.snapshot;
  }

  /**
   * Frozen-at-construction `joinedHarnessesByCid` map. Exposed so callers
   * that already have a registry reference (e.g. the `/v1/status` handler
   * building a HarnessRollup) can pair it with `getSnapshot()` without
   * reaching past the registry's encapsulation boundary.
   */
  getJoinedHarnessesByCid(): Record<string, JoinedHarnessSpec> {
    return this.opts.joinedHarnessesByCid;
  }

  /**
   * The by-name harness instance map seeded at construction. Exposed so the
   * `/v1/harnesses/auth-status` endpoint (#564) can call each harness's
   * `getAuthSource()` without re-deriving the harness set.
   */
  getHarnesses(): Record<string, Harness> {
    return this.opts.harnessesByName;
  }

  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      await this._doRefresh();
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async _doRefresh(): Promise<void> {
    // Build a harnessName -> manifestCids map keyed by EVERY registered harness
    // (not just joined ones), then fold the joined entries in, so we only call
    // isReady() once per harness. Seeding every registered harness means the
    // snapshot covers harnesses the operator could pick but has not joined yet.
    // The SPA join form (#332) consults this snapshot to disable not-ready
    // harness options before any join exists, so an unjoined harness must still
    // appear (with an empty `manifestCids`).
    const harnessToCids = new Map<string, string[]>();
    for (const name of Object.keys(this.opts.harnessesByName)) {
      harnessToCids.set(name, []);
    }
    for (const [cid, joined] of Object.entries(this.opts.joinedHarnessesByCid)) {
      const list = harnessToCids.get(joined.harnessName) ?? [];
      list.push(cid);
      harnessToCids.set(joined.harnessName, list);
    }

    const results = await Promise.all(
      Array.from(harnessToCids.entries()).map(async ([name, cids]) => {
        const harness = this.opts.harnessesByName[name];
        if (!harness) {
          return {
            harnessName: name,
            manifestCids: cids,
            ready: false,
            reason: `harness ${name} not registered in this daemon build`,
            nextStep: {
              description: 'Upgrade daemon or change SolverNet harness selection',
            },
          };
        }
        if (!harness.isReady) {
          // No isReady → treat as always-ready (matches existing default).
          return {
            harnessName: name,
            manifestCids: cids,
            ready: true,
          };
        }
        try {
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const status = await Promise.race([
            harness.isReady({ solverType: '*' }),
            new Promise<ReadyStatus>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error('isReady timed out')),
                this.opts.isReadyTimeoutMs,
              );
            }),
          ]).finally(() => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          });
          return {
            harnessName: name,
            manifestCids: cids,
            ready: status.ready,
            reason: status.reason,
            nextStep: status.nextStep,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            harnessName: name,
            manifestCids: cids,
            ready: false,
            reason: `isReady threw: ${msg}`,
          };
        }
      }),
    );

    this.snapshot = {
      lastRefreshedAt: new Date().toISOString(),
      harnesses: results,
    };
  }
}
