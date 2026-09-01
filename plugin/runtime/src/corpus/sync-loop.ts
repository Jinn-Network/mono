// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

import type { LocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";

import type { CapabilityContext, RuntimeCapability } from "../capability.js";
import type { CorpusConfig, RuntimeConfig } from "../config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "../errors.js";
import type { HealthCheck } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import { indexPublicPlane } from "../relevance/indexing.js";
import type { RelevanceIndex } from "../relevance/index-store.js";
import type { TraceSpanSource } from "../relevance/trace-decode-adapter.js";
import { describeError } from "./errors.js";
import type { CorpusFilesystem } from "./fs.js";
import type { CorpusMirror, MirrorSyncOutcome } from "./mirror.js";
import type { CorpusReader } from "./read.js";
import type { CorpusRetrieval } from "./retrieve.js";
import {
  MIRROR_SYNC_STATUS_FILENAME,
  MIRROR_SYNC_STATUS_FORMAT,
  createFileMirrorSyncStatusStore,
  type MirrorSourceSyncStatus,
  type MirrorSyncStatusRecord,
  type MirrorSyncStatusStore,
} from "./sync-status.js";

const HEALTH_CHECK_NAME = "corpus-mirror-freshness";

export interface CreateCorpusSyncCapabilityOptions {
  /**
   * Thunks, not values: the corpus capability builds each of these per
   * operation and throws until it has started, and this capability is
   * registered after it, so a value captured at construction time would be a
   * throw waiting to happen.
   */
  readonly mirror: () => CorpusMirror;
  readonly reader: () => CorpusReader;
  readonly retrieval: () => CorpusRetrieval;
  readonly fs: CorpusFilesystem;
  /**
   * Injected factories, both with the same shape, because production sources
   * under `src/corpus/` may not import `node:fs` (the plugin-tree source
   * boundary): opening a SQLite index and opening the local evidence archive
   * are both filesystem authority this module is not allowed to hold.
   */
  readonly openIndex: (config: RuntimeConfig) => Promise<RelevanceIndex>;
  readonly spanSource: TraceSpanSource;
  readonly openLocalRuntime: (config: RuntimeConfig) => Promise<LocalEvidenceRuntime>;
  readonly now?: () => Date;
}

interface Started {
  readonly config: RuntimeConfig;
  readonly corpus: CorpusConfig;
  readonly log: RuntimeLogger;
  readonly index: RelevanceIndex;
  readonly statusStore: MirrorSyncStatusStore;
  /** The live report, seeded from disk at start and rewritten every cycle. */
  lastCycle?: MirrorSyncStatusRecord["lastCycle"];
  readonly sources: Record<string, MirrorSourceSyncStatus>;
  /** Aborted once, at `stop`; every cycle's deadline is composed with it. */
  readonly lifetime: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  /** The cycle in flight. Retained rather than discarded so `stop` can await it. */
  current: Promise<void>;
  indexedOnce: boolean;
}

/**
 * The standing mirror service: one sync cycle every `corpus.syncIntervalMs`,
 * each followed by a public-plane index pass, for as long as the runtime runs.
 *
 * It is a SEPARATE capability from `corpus` rather than a loop inside it
 * because the corpus capability is composed on every `serve` process, where a
 * standing sync loop would be wrong: `serve` is a short-lived session surface,
 * and the mirror holds an exclusive sync lock. Registering this one only under
 * the `mirror` command keeps the loop, and the health row that reports on it,
 * off every install that never asked for a mirror.
 */
export function createCorpusSyncCapability(
  options: CreateCorpusSyncCapabilityOptions,
): RuntimeCapability {
  const now = options.now ?? (() => new Date());
  let started: Started | undefined;

  function require_(): Started {
    if (started === undefined) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.runtimeNotStarted,
        "The corpus sync capability has not been started.",
      );
    }
    return started;
  }

  return Object.freeze({
    name: "corpus-sync",

    async start(context: CapabilityContext): Promise<void> {
      const statusStore = createFileMirrorSyncStatusStore({
        // Derived from the home directory rather than carried on
        // `RuntimeConfig`: this file is the sync SERVICE's report, and no
        // surface outside this capability reads it, so putting it on the
        // shared config would widen a type every capability sees for one
        // consumer's benefit.
        filePath: join(context.config.homeDirectory, MIRROR_SYNC_STATUS_FILENAME),
        fs: options.fs,
        log: context.log,
      });
      const seed = await statusStore.read();

      const state: Started = {
        config: context.config,
        corpus: context.config.corpus,
        log: context.log,
        index: await options.openIndex(context.config),
        statusStore,
        ...(seed?.lastCycle === undefined ? {} : { lastCycle: seed.lastCycle }),
        sources: { ...seed?.sources },
        lifetime: new AbortController(),
        current: Promise.resolve(),
        indexedOnce: false,
      };
      started = state;

      // Cycle one starts here and is NOT awaited: `start` must return so the
      // rest of the runtime composes and the process reaches its shutdown
      // wait. The promise is retained rather than dropped so `stop` can join
      // the cycle in flight instead of tearing the index out from under it.
      state.current = runCycle(state);
    },

    async stop(): Promise<void> {
      const state = started;
      if (state === undefined) return;
      started = undefined;
      state.lifetime.abort();
      if (state.timer !== undefined) clearTimeout(state.timer);
      await state.current;
      state.index.close();
    },

    async healthChecks(): Promise<readonly HealthCheck[]> {
      return [await freshnessCheck(require_())];
    },
  });

  /**
   * One cycle. It never rejects: every failure is folded into the status
   * record and the cycle log line, because the only caller is a timer, and a
   * rejection there is an unhandled rejection that kills the process rather
   * than a fault anyone can act on.
   */
  async function runCycle(state: Started): Promise<void> {
    // An explicit deadline timer rather than `AbortSignal.timeout`, so a test
    // driving fake timers can advance the runtime past a stuck cycle.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), state.corpus.syncTimeoutMs);
    const signal = AbortSignal.any([state.lifetime.signal, deadline.signal]);

    let status = "failed";
    let indexed = false;
    let error: string | undefined;
    try {
      const outcome = await options.mirror().syncOnce({ signal });
      status = outcome.status;
      if (outcome.status === "skipped-locked") {
        // Neither a success nor a fault: another process holds the sync lock,
        // so this cycle observed nothing about any source and must leave the
        // record alone rather than aging every source out of freshness.
        state.log.debug("corpus.mirror.skipped", { reason: "another process holds the sync lock" });
      } else {
        recordOutcome(state, outcome);
        if (outcome.status !== "failed" && shouldIndex(state, outcome)) {
          await indexPublicPlane({
            index: state.index,
            spanSource: options.spanSource,
            openLocalRuntime: () => options.openLocalRuntime(state.config),
            corpusReader: options.reader(),
            corpusRetrieval: options.retrieval(),
          });
          state.indexedOnce = true;
          indexed = true;
        }
      }
    } catch (caught) {
      error = describeError(caught);
    } finally {
      clearTimeout(timer);
      if (status !== "skipped-locked" || state.lastCycle === undefined) {
        state.lastCycle = { completedAt: now().toISOString(), status: status as "synced" };
      }
      await writeStatus(state);
      state.log.info("corpus.mirror.cycle", {
        status,
        indexed,
        ...(error === undefined ? {} : { error }),
      });
      if (!state.lifetime.signal.aborted) {
        state.timer = setTimeout(() => {
          state.current = runCycle(state);
        }, state.corpus.syncIntervalMs);
      }
    }
  }

  /**
   * The first cycle after start always indexes, even when it imported nothing:
   * the mirror may already hold records this process has never indexed — a
   * fresh index file, or a mirror populated by an earlier run — and waiting
   * for the next append to notice would leave `corpus_search` answering over
   * an empty index for as long as the followed feed is quiet.
   */
  function shouldIndex(state: Started, outcome: MirrorSyncOutcome): boolean {
    if (!state.indexedOnce) return true;
    return outcome.sources.reduce((total, report) => total + report.indexed, 0) > 0;
  }

  function recordOutcome(state: Started, outcome: MirrorSyncOutcome): void {
    const at = now().toISOString();
    for (const report of outcome.sources) {
      const key = `${report.source.agent}/${report.source.name}`;
      if (report.status === "synced") {
        // A source that just synced carries no standing failure: newest wins,
        // exactly as the corpus capability's chain-rejection map does.
        state.sources[key] = { lastSyncedAt: at };
      } else {
        state.sources[key] = {
          ...state.sources[key],
          lastFailure: {
            code: report.failure?.code ?? "UNKNOWN",
            message: report.failure?.message ?? "the mirror reported a failure with no detail",
            at,
          },
        };
      }
    }
  }

  async function writeStatus(state: Started): Promise<void> {
    try {
      await state.statusStore.write({
        format: MIRROR_SYNC_STATUS_FORMAT,
        ...(state.lastCycle === undefined ? {} : { lastCycle: state.lastCycle }),
        sources: state.sources,
      });
    } catch (caught) {
      state.log.warn("corpus.mirror.status.unwritable", { reason: describeError(caught) });
    }
  }

  /**
   * Is this mirror still keeping up with what it follows?
   *
   * Exactly one row, and it reports only what this capability owns. It does
   * NOT restate the verification posture or name the archives the chain
   * refused — `corpus-chain-verification` already does both, and duplicating
   * them here would attribute a verification fault to the sync loop (Finding
   * F10). A stale source is therefore reported as staleness, with a remedy
   * that points the operator at that row.
   */
  async function freshnessCheck(state: Started): Promise<HealthCheck> {
    const followed = state.corpus.sources;
    if (followed.length === 0) {
      return {
        name: HEALTH_CHECK_NAME,
        ok: true,
        detail: "Following no archives — there is nothing to keep fresh.",
        remedy: null,
      };
    }

    const lastCycle = state.lastCycle;
    if (lastCycle === undefined) {
      return {
        name: HEALTH_CHECK_NAME,
        ok: true,
        detail: "No sync cycle has completed yet.",
        remedy: null,
      };
    }

    const at = now().getTime();
    const heads = await describeHeadAges(at);

    if (lastCycle.status === "failed") {
      const failures = followed
        .map((source) => `${source.agent}/${source.name}`)
        .flatMap((key) => {
          const failure = state.sources[key]?.lastFailure;
          return failure === undefined ? [] : [`${key} (${failure.code}: ${failure.message})`];
        });
      return {
        name: HEALTH_CHECK_NAME,
        ok: false,
        detail:
          `The sync cycle that completed at ${lastCycle.completedAt} failed` +
          (failures.length === 0
            ? " before it reached any followed archive."
            : `: ${failures.join(", ")}.`) +
          heads,
        remedy:
          "Read the most recent `corpus.mirror.cycle` log line: it carries the cycle's status " +
          "and, when the cycle threw, the error that ended it.",
      };
    }

    // Two intervals of slack, or one interval plus a whole sync timeout,
    // whichever is longer: a cycle that runs to its deadline still finishes
    // inside the window, so an install with a slow feed does not flap red
    // between cycles that are in fact keeping up.
    const threshold = Math.max(
      2 * state.corpus.syncIntervalMs,
      state.corpus.syncIntervalMs + state.corpus.syncTimeoutMs,
    );
    const stale = followed.flatMap((source) => {
      const key = `${source.agent}/${source.name}`;
      const status = state.sources[key];
      const syncedAt = status?.lastSyncedAt === undefined ? NaN : Date.parse(status.lastSyncedAt);
      const age = Number.isNaN(syncedAt) ? undefined : at - syncedAt;
      if (age !== undefined && age <= threshold) return [];
      const failure = status?.lastFailure;
      return [
        `${key} ${age === undefined ? "has never synced" : `last synced ${describeAge(age)} ago`}` +
          (failure === undefined ? "" : ` (last failure ${failure.code}: ${failure.message})`),
      ];
    });

    if (stale.length === 0) {
      return {
        name: HEALTH_CHECK_NAME,
        ok: true,
        detail:
          `${String(followed.length)} followed archive(s) synced within the last ` +
          `${describeAge(threshold)}.${heads}`,
        remedy: null,
      };
    }

    return {
      name: HEALTH_CHECK_NAME,
      ok: false,
      detail:
        `${String(stale.length)} of ${String(followed.length)} followed archive(s) have not ` +
        `synced within the last ${describeAge(threshold)}: ${stale.join(", ")}.${heads}`,
      remedy:
        lastCycle.status === "skipped-locked"
          ? `Every recent cycle skipped because another process holds the mirror sync lock at ` +
            `${state.config.mirrorLockPath}. Stop the other instance, or delete that file if it ` +
            `is a stale lock left behind by a killed process.`
          : "Check the `corpus-chain-verification` row: it reports this runtime's verification " +
            "posture and names any archive whose chain it refused, which is the usual reason a " +
            "followed archive stops advancing.",
    };
  }

  /**
   * Head age is reported and never gates `ok`. Per #2549 every in-tree
   * publisher re-signs a head only after an append, so a correct but quiet
   * feed accumulates head age indefinitely; treating that as a fault would
   * make the row red on installs where nothing is wrong.
   */
  async function describeHeadAges(at: number): Promise<string> {
    let statuses;
    try {
      statuses = await options.reader().describeSources();
    } catch {
      // Supplementary detail only, so an unreadable catalog costs the sentence
      // rather than the verdict this row exists to deliver.
      return "";
    }
    const parts = statuses.flatMap((status) => {
      const issuedAt = status.highWaterMark?.issuedAt;
      const issued = issuedAt === undefined ? NaN : Date.parse(issuedAt);
      if (Number.isNaN(issued)) return [];
      return [`${status.source.agent}/${status.source.name} ${describeAge(at - issued)}`];
    });
    return parts.length === 0 ? "" : ` Source head ages: ${parts.join(", ")}.`;
  }
}

function describeAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}
