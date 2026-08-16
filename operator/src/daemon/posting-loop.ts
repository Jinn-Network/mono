import type { Store } from '../store/store.js';
import { runLoop } from './loop-heartbeat.js';
import {
  RequesterError,
  isRequesterError,
  runPostingPreflight,
  assertPostingFunds,
  assertPostingFreshness,
  selectLiveTarget,
  type PostingFundsInput,
  type PostingFreshnessInput,
  type PostingTargetCandidate,
} from '../native-requester/work-client/index.js';

/**
 * The native posting loop — the host driver that turns `posting[]` config entries into posted
 * Submissions on the marketplace binding (cutover stage-3 posting-flow plan Task 16;
 * DR-2026-08-05 decision 1). It mirrors the legacy `CreatorLoop`'s shape (tick/run/stop over the
 * shared `runLoop` skeleton and the `posting` LOOP_REGISTRY entry) but drives the native
 * requester through injected ports, so it takes no host dependency beyond the extractable
 * work-client module and the store.
 *
 * Boot-inertness is a property of construction, not a runtime flag: `buildPostingLoop` returns
 * `undefined` for a legacy composition or an empty `posting[]`, so a default (legacy) boot never
 * constructs the loop and never registers it with the watchdog.
 */

/** One posting target: a live-annotated posting-config candidate plus what the leg needs to post. */
export interface PostingLoopTarget extends PostingTargetCandidate {
  /** Whether this entry drives the loop (launched-record `generatorEnabled`). */
  readonly generatorEnabled: boolean;
}

/** The ports the loop drives. Every one is injected by the host wiring — the loop constructs none. */
export interface PostingLoopPorts {
  /** Reconciles every durable posting/outbox before the loop admits new work (native `reconcile`). */
  reconcile(): Promise<void>;
  /** Resolves the configured `posting[]` entries to live-annotated targets from venue facts. */
  listTargets(): Promise<readonly PostingLoopTarget[]>;
  /** The funds preflight input for a target (Safe/agent balances + the target's delivery rates). */
  probeFunds(target: PostingLoopTarget): Promise<PostingFundsInput>;
  /** The freshness preflight input for a target (its claim/submission/session deadlines). */
  probeFreshness(target: PostingLoopTarget): Promise<PostingFreshnessInput>;
  /** Posts one target through the native requester; returns the on-chain task id when known. */
  post(target: PostingLoopTarget): Promise<{ readonly taskId?: string }>;
  /** Injectable clock (tests pin it); defaults to `Date.now`. */
  now?(): number;
}

export interface PostingLoopOptions {
  readonly store: Store;
  readonly ports: PostingLoopPorts;
  readonly intervalMs?: number;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

const DEFAULT_POSTING_INTERVAL_MS = 5000;

export class PostingLoop {
  private stopped = false;
  private stopResolve: (() => void) | null = null;
  private readonly stopPromise: Promise<void>;
  private readonly logger: { info(message: string): void; warn(message: string): void };

  constructor(private readonly options: PostingLoopOptions) {
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    this.stopPromise = new Promise((resolve) => {
      this.stopResolve = resolve;
    });
  }

  /**
   * One posting pass: reconcile durable state, then for every live, generator-enabled target run
   * the funds/freshness preflight and post it. Per-target failures are logged and skipped — one
   * bad target never strands the others — matching `CreatorLoop.tick`'s per-source isolation.
   * Returns the task ids posted this tick (empty when nothing was live/enabled).
   */
  async tick(): Promise<string[]> {
    await this.options.ports.reconcile();
    const targets = await this.options.ports.listTargets();
    const enabled = targets.filter((target) => target.generatorEnabled && target.live);
    const postedTaskIds: string[] = [];
    for (const target of enabled) {
      try {
        // eslint-disable-next-line no-await-in-loop -- posting is deliberately sequential (one Safe nonce stack).
        await this.preflight(target);
        // eslint-disable-next-line no-await-in-loop -- see above.
        const outcome = await this.options.ports.post(target);
        if (outcome.taskId !== undefined) postedTaskIds.push(outcome.taskId);
        this.logger.info(
          `[posting] posted ${target.postingKey}${outcome.taskId ? ` (task ${outcome.taskId})` : ''}`,
        );
      } catch (err) {
        const detail = isRequesterError(err)
          ? `${err.category}/${err.code}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        this.logger.warn(`[posting] skipped ${target.postingKey}: ${detail}`);
      }
    }
    return postedTaskIds;
  }

  /** Runs the funds and freshness legs of the work-client preflight for one target. */
  private async preflight(target: PostingLoopTarget): Promise<void> {
    const now = this.options.ports.now?.() ?? Date.now();
    await runPostingPreflight({
      config: async () => {},
      funds: async () => {
        assertPostingFunds(await this.options.ports.probeFunds(target));
      },
      venue: async () => {},
      target: async () => {
        // The live target must still resolve unambiguously against the current candidate set.
        selectLiveTarget({ candidates: [target], explicitPostingKey: target.postingKey });
      },
      freshness: async () => {
        assertPostingFreshness(await this.options.ports.probeFreshness(target), { nowMs: now });
      },
      documents: async () => {},
    });
  }

  async run(): Promise<void> {
    await runLoop({
      name: 'posting',
      store: this.options.store,
      tick: async () => {
        await this.tick();
      },
      intervalMs: this.options.intervalMs ?? DEFAULT_POSTING_INTERVAL_MS,
      stopSignal: () => this.stopped,
      stopPromise: this.stopPromise,
      emitSource: 'posting',
      onError: (err) => {
        this.logger.warn(
          `[posting] tick error: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}

/**
 * The boot-inertness gate. Returns a `PostingLoop` only for a native composition that has at
 * least one `posting[]` entry; a legacy boot or an empty posting config gets `undefined`, so the
 * loop is never constructed, never started, and never registered with the watchdog. This is the
 * single place the host decides whether the posting path exists.
 */
export function buildPostingLoop(input: {
  readonly compositionMode: 'legacy' | 'native';
  readonly postingEntryCount: number;
  readonly options: PostingLoopOptions;
}): PostingLoop | undefined {
  if (input.compositionMode !== 'native') return undefined;
  if (input.postingEntryCount <= 0) return undefined;
  return new PostingLoop(input.options);
}

export { RequesterError };
