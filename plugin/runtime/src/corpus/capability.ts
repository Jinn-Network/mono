// SPDX-License-Identifier: Apache-2.0

import type { DsseChainVerifier, Sha256Digest } from "@jinn-network/trust-core";
import type { Transport } from "@jinn-network/record-discovery-client";

import type { CapabilityContext, RuntimeCapability } from "../capability.js";
import type { CorpusConfig, RuntimeConfig } from "../config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "../errors.js";
import type { HealthCheck } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import {
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
  createTrustPolicyAdmission,
  type CorpusAdmission,
} from "./admission.js";
import {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
  type ChainVerification,
} from "./chain-verification.js";
import { describeError } from "./errors.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { createCorpusMirror, type CorpusMirror } from "./mirror.js";
import { createCorpusReader, type CorpusReader } from "./read.js";
import { createCorpusRetrieval, type CorpusRetrieval } from "./retrieve.js";
import { withCorpusMirrorStore } from "./store.js";

export interface CreateCorpusCapabilityOptions {
  readonly transport: Transport;
  /** Injected per custody law C1/C3 — C5 implements no cryptography. */
  readonly dsseVerifier: DsseChainVerifier;
  /** Host-supplied loader for the trust-policy version chain. */
  readonly readPolicyVersions: (directory: string) => Promise<readonly Uint8Array[]>;
  readonly now?: () => Date;
}

export interface CorpusCapability extends RuntimeCapability {
  readonly mirror: CorpusMirror;
  readonly reader: CorpusReader;
  readonly retrieval: CorpusRetrieval;
}

interface Started {
  readonly config: RuntimeConfig;
  readonly corpus: CorpusConfig;
  readonly admission: CorpusAdmission;
  readonly chainVerification: ChainVerification;
  readonly log: RuntimeLogger;
  readonly policyError?: string;
  readonly policyCount: number;
}

export function createCorpusCapability(
  options: CreateCorpusCapabilityOptions,
): CorpusCapability {
  const now = options.now ?? (() => new Date());
  let started: Started | undefined;

  function require_(): Started {
    if (started === undefined) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.runtimeNotStarted,
        "The corpus capability has not been started.",
      );
    }
    return started;
  }

  return Object.freeze({
    name: "corpus",

    async start(context: CapabilityContext): Promise<void> {
      // Cheap, contention-free setup only (C3 finding F-C3-8): no catalog is
      // opened and no lock is taken here. Every surface below opens the store
      // per operation and closes it.
      const corpus = context.config.corpus;

      let policyVersions: readonly Uint8Array[] = [];
      let policyError: string | undefined;
      if (corpus.trust !== undefined) {
        try {
          policyVersions = await options.readPolicyVersions(corpus.trust.policyDirectory);
        } catch (error) {
          policyError = describeError(error);
        }
      }

      const producerAdmission: CorpusAdmission =
        corpus.trust === undefined || policyError !== undefined
          ? createDeniedProducerAdmission()
          : createTrustPolicyAdmission({
              policyVersions,
              genesisDigest: corpus.trust.genesisDigest as Sha256Digest,
              producerPurpose: corpus.trust.producerPurpose,
              now: () => now().toISOString(),
              dsseVerifier: options.dsseVerifier,
            });

      started = {
        config: context.config,
        corpus,
        admission: composeAdmission(
          createFollowedSourceAdmission(corpus.sources),
          producerAdmission,
        ),
        chainVerification: corpus.acknowledgeUnverifiedChain
          ? createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT)
          : createRejectingChainVerification(),
        log: context.log,
        ...(policyError === undefined ? {} : { policyError }),
        policyCount: policyVersions.length,
      };

      context.log.info("corpus.capability.started", {
        archives: corpus.sources.length,
        chainVerification: started.chainVerification.mode,
      });
    },

    async stop(): Promise<void> {
      started = undefined;
    },

    async healthChecks(): Promise<readonly HealthCheck[]> {
      const state = require_();
      const reader = buildReader(state);
      const statuses = await reader.describeSources();
      const synced = statuses.filter((status) => status.highWaterMark !== undefined).length;

      // There is deliberately no `corpus-sources` check. An earlier draft had
      // one, and it was a release note wearing a check's clothes: its `ok` was
      // unconditionally `true`, so it could never tell an operator anything,
      // and its remedy ("add entries under `corpus.sources`") was a no-op for
      // anyone who deliberately follows none. Its only real content — the
      // archive count and the honest empty state — is folded into
      // `corpus-mirror`'s detail below, where it sits beside a condition that
      // actually varies. See Finding F9.
      const followed = state.corpus.sources.length;

      // The sync position lives in a file SEPARATE from the catalog
      // (`mirrorStatePath` vs `mirrorCatalogPath`), so it can outlive the data
      // it describes — the mirror image of the bug C6 hit, where a marker
      // derived from live rows died with them. If the catalog is deleted or
      // recreated while the state file survives, `returningSync` resumes from a
      // position whose records are gone, walks nothing new, and the mirror
      // stays permanently empty while reporting a sync position. That wedge is
      // detected here rather than reported as green. See Finding F11.
      const populated = followed === 0 ? true : await mirrorHasAnyRecord(state);
      const wedged = synced > 0 && !populated;

      const checks: HealthCheck[] = [
        {
          name: "corpus-mirror",
          // Green with no archives (nothing to sync) and green once at least
          // one archive has a position AND the catalog actually holds records;
          // red when archives are followed but nothing has synced, and red when
          // a sync position survives a catalog that no longer has the data.
          ok: followed === 0 || (synced > 0 && populated),
          detail:
            followed === 0
              ? "Following no archives — the corpus is empty by configuration."
              : wedged
                ? `${String(synced)} archive(s) report a sync position but the mirror holds no records — ` +
                  "the stored position is ahead of the catalog, so no further sync will import anything."
                : `${String(synced)} of ${String(followed)} followed archive(s) have a sync position.`,
          remedy:
            followed === 0
              ? null
              : wedged
                ? // This one genuinely repairs the state: clearing the position
                  // makes the next sync a cold walk from genesis.
                  `Delete the mirror state file at ${state.config.mirrorStatePath} to re-sync from genesis.`
                : "Run a mirror sync; the runtime also syncs opportunistically at session start.",
        },
        // This check measures whether THIS INSTALL is configured coherently —
        // not whether this VERSION of the software has a verification driver.
        // The latter is a universal, operator-unfixable capability fact (C5
        // Finding F1); reporting it as a per-install failure would make every
        // correct install red with a remedy nobody can act on, which spec §9.3
        // forbids by name ("the doctor reports a known-outage state ... instead
        // of printing a no-op remedy") and which trains operators to ignore red.
        chainVerificationCheck(state),
      ];

      if (state.corpus.trust === undefined) {
        checks.push({
          name: "corpus-trust-policy",
          ok: false,
          detail: "No trust policy is configured, so no producer is admitted.",
          remedy: "Set `corpus.trust.genesisDigest` and `corpus.trust.policyDirectory`.",
        });
      } else if (state.policyError !== undefined) {
        checks.push({
          name: "corpus-trust-policy",
          ok: false,
          detail: `The trust policy could not be read: ${state.policyError}`,
          // C3's "not fixable from this machine" state.
          remedy: null,
        });
      } else {
        checks.push({
          name: "corpus-trust-policy",
          ok: state.policyCount > 0,
          detail: `${String(state.policyCount)} trust-policy version(s) loaded.`,
          remedy:
            state.policyCount > 0
              ? null
              : "Populate the configured trust-policy directory with the signed version chain.",
        });
      }

      return checks;
    },

    get mirror(): CorpusMirror {
      const state = require_();
      return createCorpusMirror({
        sources: state.corpus.sources,
        maxEntriesPerSync: state.corpus.maxEntriesPerSync,
        lockPath: state.config.mirrorLockPath,
        storePaths: storePathsOf(state.config),
        highWaterMarks: createFileHighWaterMarkStore({
          filePath: state.config.mirrorStatePath,
        }),
        admission: state.admission,
        chainVerification: state.chainVerification,
        transport: options.transport,
        log: loggerOf(state),
      });
    },

    get reader(): CorpusReader {
      return buildReader(require_());
    },

    get retrieval(): CorpusRetrieval {
      const state = require_();
      return createCorpusRetrieval({
        storePaths: storePathsOf(state.config),
        sources: state.corpus.sources,
        admission: state.admission,
        transport: options.transport,
      });
    },
  });

  function storePathsOf(config: RuntimeConfig) {
    return {
      catalogPath: config.mirrorCatalogPath,
      objectsDirectory: config.mirrorObjectsDirectory,
      now,
    };
  }

  /**
   * Does the mirror hold any record at all, across all three families?
   *
   * Reads the catalog RAW rather than going through `CorpusReader`: the reader
   * is trust-filtered, so a catalog whose every producer is currently
   * unadmitted would look empty and be misreported as a wedged mirror. The
   * question here is about data presence, not admissibility — the trust
   * question is `corpus-trust-policy`'s row, and conflating the two is exactly
   * the misattribution Finding F10 is about, in miniature.
   */
  async function mirrorHasAnyRecord(state: Started): Promise<boolean> {
    return withCorpusMirrorStore(storePathsOf(state.config), async (store) => {
      const [executions, evaluations, verifications] = await Promise.all([
        store.catalog.findExecutions({ limit: 1, availability: "available" }),
        store.catalog.findEvaluations({ limit: 1, availability: "available" }),
        store.catalog.findVerifications({ limit: 1, availability: "available" }),
      ]);
      return (
        executions.items.length > 0 ||
        evaluations.items.length > 0 ||
        verifications.items.length > 0
      );
    });
  }

  /**
   * Posture-vs-configuration, deliberately — NOT capability presence.
   *
   * Three states, and each carries information a different one does not:
   *  - nothing to verify (no archives followed) → green;
   *  - a driver is wired → green, and the check silently starts reporting a
   *    real verification result the day one exists;
   *  - archives followed with the unverified posture acknowledged → green,
   *    with the posture named in `detail` and `remedy: null`, because the
   *    operator explicitly wrote that flag and there is nothing to do;
   *  - archives followed with NO posture chosen → red, because this install
   *    will silently never index anything, and one config line fixes it.
   *
   * Red therefore means "something here is wrong and you can fix it", which is
   * the only meaning that keeps red worth reading.
   */
  function chainVerificationCheck(state: Started): HealthCheck {
    if (state.chainVerification.mode === "verified") {
      return {
        name: "corpus-chain-verification",
        ok: true,
        detail: "Announcement chains are verified before indexing.",
        remedy: null,
      };
    }
    if (state.corpus.sources.length === 0) {
      return {
        name: "corpus-chain-verification",
        ok: true,
        detail: "No archives are followed, so there is no announcement chain to verify.",
        remedy: null,
      };
    }
    if (state.corpus.acknowledgeUnverifiedChain) {
      return {
        name: "corpus-chain-verification",
        ok: true,
        detail:
          "Mirroring without announcement-chain verification — signatures on followed archives " +
          "are not verified by this runtime. Record digests and producer admission still apply.",
        remedy: null,
      };
    }
    return {
      name: "corpus-chain-verification",
      ok: false,
      detail:
        `${String(state.corpus.sources.length)} archive(s) are followed but no chain-verification ` +
        "posture was chosen, so the mirror will not index anything from them.",
      remedy:
        "Set `corpus.acknowledgeUnverifiedChain` to true to mirror without chain verification, " +
        "or stop following archives under `corpus.sources`.",
    };
  }

  function buildReader(state: Started): CorpusReader {
    return createCorpusReader({
      storePaths: storePathsOf(state.config),
      sources: state.corpus.sources,
      admission: state.admission,
      highWaterMarks: createFileHighWaterMarkStore({ filePath: state.config.mirrorStatePath }),
    });
  }

  function loggerOf(state: Started): RuntimeLogger {
    return state.log;
  }
}
