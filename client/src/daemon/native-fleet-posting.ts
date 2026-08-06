/**
 * The fleet posting runtime (one-swap M5d, umbrella #2461, DR-2026-08-05 decision 1).
 *
 * Builds the {@link PostingLoopPorts} the native fleet daemon's posting loop (M5b) drives, from the
 * fleet's ALREADY-CONSTRUCTED pieces — same-instance discipline, program contract 2: the shared
 * Store, the one service Safe + agent EOA, the viem read client's balance reads, and the fleet
 * runtime's `agentIri`. It constructs no second identity set, no second Safe, and — critically for
 * the M5d provenance ledger — no discovery consumer.
 *
 * Scope honesty (M5d), stated where it bites rather than hidden:
 *
 *  - `listTargets` is REAL. It resolves `config.posting[]` to live-annotated targets by reading the
 *    launched SolverNet record each entry points at; a target is `live` only when that record's
 *    status is `launched`. This is the operator-visible value of the mount: configured posting
 *    entries and their liveness show up on the loop even before a broadcast can happen.
 *  - `probeFunds` reads the REAL, live Safe/agent balances. It asserts no delivery-rate barrier
 *    because the per-task rates and claim-slot count are a property of the venue posting terms the
 *    `post` bridge resolves; that source is not in the fleet's `JinnConfig` yet, so a truthful "no
 *    rate barrier known" (budget 0) is reported rather than a fabricated rate. The rate-gated funds
 *    check lands with `post`.
 *  - `probeFreshness` reports every deadline live for the same reason: posting deadlines are venue
 *    terms the `post` bridge resolves. The deadline-gated freshness check lands with `post`.
 *  - `reconcile` is a no-op: no durable posting draft can exist until `post` is live, so there is
 *    nothing to reconcile. It stays as the loop's first tick step so the reconcile-before-admit
 *    ordering is already wired for when `post` lands.
 *  - `post` is live in native mode WHENEVER the caller injects a `postTask` write port (one-swap
 *    M5e, #2461). That port is the requester WRITE path — `buildFleetRequesterWrite` over the
 *    composition's ONE Safe broadcaster (`native-fleet-requester-write.ts`) — closing the M5d
 *    finding's two gaps: the config -> request task construction and the venue -> requester posting
 *    bridge. `post` runs AFTER the loop's per-target preflight (`posting-loop.ts` calls preflight
 *    then `post`), so it only reaches the write path once funds/freshness passed. When no write
 *    port is injected (a legacy/solver-only boot, or an operator without requester admission
 *    custody), `post` stays the FAIL-CLOSED seam it was in M5d: it throws a typed
 *    {@link RequesterError} rather than fabricate a post, and the loop surfaces the throw as a
 *    visible per-target skip.
 *
 * Provenance ledger (M5d, 3rd shared-discovery consumer): the requester posting path is NOT a
 * `native_discovery_*` consumer. The solver (M3) reads the shared Store's `native_discovery_*`
 * queue; the evaluator (M4a) took a DISTINCT `discovery.sqlite` precisely so its reads cannot
 * starve or race the solver's on that queue. This runtime reads config + launched-record files +
 * on-chain balances and opens NO discovery consumer at all, so there is no shared-queue cross-feed
 * to separate. `test/daemon/native-fleet-posting.test.ts` pins that the module touches no
 * `native_discovery_*` surface.
 */
import { readFileSync } from 'node:fs';
import type { JinnConfig } from '../config.js';
import type { PostingConfigEntry } from '../config/shape-v2.js';
import { LaunchedSolverNetRecordSchema } from '../solvernets/store.js';
import {
  RequesterError,
  type PostingFreshnessInput,
  type PostingFundsInput,
} from '../native-requester/work-client/index.js';
import type { PostingLoopPorts, PostingLoopTarget } from './posting-loop.js';

/**
 * How far ahead of `now` the not-yet-resolved posting deadlines are reported. Wide enough that the
 * freshness reserve never trips it while the real venue-term deadlines are unwired; the actual
 * deadline source lands with `post`.
 */
export const POSTING_UNWIRED_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The launched-record facts `listTargets` needs, resolved from one posting entry. */
export interface ResolvedPostingTarget {
  /**
   * The target's profile identifier. Resolving a launched record to its concrete task-execution
   * profile URI is part of the `post` bridge; until then this carries the record's `manifestCid`
   * (the entry's stable identity), which no live path consumes because `post` fails closed.
   */
  readonly profileUri: string;
  /** `true` only when the launched record is in the `launched` status. */
  readonly live: boolean;
}

export interface FleetPostingRuntimeInput {
  readonly config: Pick<JinnConfig, 'posting'>;
  /** This operator's service Safe — the creator Safe a post would escrow against. */
  readonly safeAddress: `0x${string}`;
  /** This operator's agent EOA — the outer Safe exec signer. */
  readonly agentEoaAddress: `0x${string}`;
  /**
   * Reads an account's live ETH balance. The fleet passes `publicClient.getBalance`; tests inject a
   * fake. Same-instance: the fleet's ONE read client, never a second one.
   */
  readBalanceWei(address: `0x${string}`): Promise<bigint>;
  /**
   * Resolves one posting entry to its launched-record facts. Injected for tests; defaults to reading
   * `entry.launchedRecordPath` off disk and parsing it with `LaunchedSolverNetRecordSchema`.
   */
  readonly resolveLaunchedTarget?: (entry: PostingConfigEntry) => ResolvedPostingTarget;
  /**
   * The requester WRITE port (one-swap M5e, #2461). When present, `post` drives it to turn a
   * resolved target into a real broadcast `TaskCreated` and return the on-chain task id; when
   * absent, `post` stays the M5d fail-closed seam (throws). `main.ts` builds this from
   * `buildFleetRequesterWrite` over the composition's ONE Safe broadcaster, so a post here is the
   * SAME single-nonce authority the solver/evaluator/verdict legs serialize through — never a
   * second wallet or venue.
   */
  readonly postTask?: (target: PostingLoopTarget) => Promise<{ readonly taskId?: string }>;
  /**
   * Optional warn sink for the per-target launched-record resolution guard. A malformed launched
   * record degrades that entry to `live: false` (skipped) rather than stranding the whole tick; the
   * warn makes the degradation visible instead of silent. `main.ts` passes the daemon logger.
   */
  readonly logger?: { warn(message: string): void };
  now?(): number;
}

export interface FleetPostingRuntime {
  readonly ports: PostingLoopPorts;
  /** `config.posting[].length` — the boot-inertness gate `buildPostingLoop` reads. */
  readonly postingEntryCount: number;
}

/** Default launched-record resolution: read the file the posting entry points at and parse it. */
function readLaunchedTarget(entry: PostingConfigEntry): ResolvedPostingTarget {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(entry.launchedRecordPath, 'utf8'));
  } catch (cause) {
    throw new RequesterError(
      'config',
      'launched-record-unreadable',
      `posting entry ${entry.workKind} launched record ${entry.launchedRecordPath} is unreadable: `
      + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = LaunchedSolverNetRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequesterError(
      'config',
      'launched-record-invalid',
      `posting entry ${entry.workKind} launched record ${entry.launchedRecordPath} is not a valid `
      + `launched SolverNet record: ${parsed.error.message}`,
    );
  }
  return { profileUri: parsed.data.manifestCid, live: parsed.data.status === 'launched' };
}

/**
 * Assembles the fleet posting runtime. Pure over its injected reads — it opens no store, wallet, or
 * discovery consumer of its own; the caller owns those and passes the reads in.
 */
export function buildFleetPostingRuntime(input: FleetPostingRuntimeInput): FleetPostingRuntime {
  const entries = input.config.posting ?? [];
  const resolve = input.resolveLaunchedTarget ?? readLaunchedTarget;
  const now = input.now ?? (() => Date.now());

  const ports: PostingLoopPorts = {
    // No durable posting draft can exist until `post` is live; the reconcile step is wired for then.
    reconcile: async () => {},

    // Per-entry isolation (M5e hardening of the M5d finding): resolving a launched record can throw
    // (unreadable/invalid record). Resolve each entry inside its own try so one malformed record
    // degrades to a skipped `live: false` target rather than stranding the whole tick — a single
    // bad posting entry never blinds the loop to the others.
    listTargets: async (): Promise<readonly PostingLoopTarget[]> =>
      entries.map((entry) => {
        let resolved: ResolvedPostingTarget;
        try {
          resolved = resolve(entry);
        } catch (err) {
          input.logger?.warn(
            `[posting] launched record for ${entry.workKind} did not resolve — skipping this target `
            + `(live=false): ${err instanceof Error ? err.message : String(err)}`,
          );
          resolved = { profileUri: entry.workKind, live: false };
        }
        return {
          postingKey: entry.workKind,
          workKind: entry.workKind,
          profileUri: resolved.profileUri,
          live: resolved.live,
          generatorEnabled: entry.generatorEnabled,
          ...(entry.legacyManifestDigest === undefined
            ? {}
            : { legacyManifestDigest: entry.legacyManifestDigest }),
        };
      }),

    probeFunds: async (): Promise<PostingFundsInput> => ({
      safeBalanceWei: await input.readBalanceWei(input.safeAddress),
      agentBalanceWei: await input.readBalanceWei(input.agentEoaAddress),
      // Rates + claim slots are venue posting terms the `post` bridge resolves — unwired here, so no
      // rate barrier is asserted (budget 0). Balances above are the truthful live values.
      solutionMaxDeliveryRateWei: 0n,
      verdictMaxDeliveryRateWei: 0n,
      maxClaims: 1,
      agentGasReserveWei: 0n,
    }),

    probeFreshness: async (): Promise<PostingFreshnessInput> => {
      // Deadlines are venue terms the `post` bridge resolves — unwired here, so every deadline is
      // reported live (now + a wide window). The deadline-gated check lands with `post`.
      const live = now() + POSTING_UNWIRED_LIVE_WINDOW_MS;
      return { claimWindowEndMs: live, submissionDeadlineMs: live, sessionDeadlineMs: live };
    },

    // Live in native mode when a requester WRITE port is injected (M5e); otherwise the M5d
    // fail-closed seam. The loop has already run this target's funds/freshness preflight before it
    // calls `post` (`posting-loop.ts`), so reaching the write port means preflight passed.
    post: async (target: PostingLoopTarget): Promise<{ readonly taskId?: string }> => {
      if (input.postTask === undefined) {
        throw new RequesterError(
          'broadcast',
          'posting-bridge-unwired',
          `native posting broadcast is not wired for ${target.postingKey}: no requester write port `
          + 'was injected (a legacy/solver-only boot, or an operator without requester admission '
          + 'custody). Refusing fail-closed rather than posting the wrong work.',
        );
      }
      return input.postTask(target);
    },

    now,
  };

  return { ports, postingEntryCount: entries.length };
}
