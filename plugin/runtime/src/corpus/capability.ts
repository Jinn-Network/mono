// SPDX-License-Identifier: Apache-2.0

import type { DsseChainVerifier, Sha256Digest } from "@jinn-network/trust-core";
import type { Transport, VerifyDriver } from "@jinn-network/record-discovery-client";

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
  createDriverChainVerification,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
  type ChainVerification,
  type ChainVerificationInput,
  type ChainVerificationOutcome,
} from "./chain-verification.js";
import { describeError } from "./errors.js";
import type { CorpusFilesystem } from "./fs.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { createCorpusMirror, type CorpusMirror } from "./mirror.js";
import { createCorpusReader, type CorpusReader } from "./read.js";
import { createCorpusRetrieval, type CorpusRetrieval } from "./retrieve.js";
import { withCorpusMirrorStore } from "./store.js";

export interface CreateCorpusCapabilityOptions {
  readonly transport: Transport;
  readonly fs: CorpusFilesystem;
  /** Injected per custody law C1/C3 — C5 implements no cryptography. */
  readonly dsseVerifier: DsseChainVerifier;
  /** Host-supplied loader for the trust-policy version chain. */
  readonly readPolicyVersions: (directory: string) => Promise<readonly Uint8Array[]>;
  /**
   * The announcement-chain verification driver, injected by the composition
   * root for the same reason `dsseVerifier` is (custody law C1/C3): C5
   * implements no cryptography and resolves no keys itself. Absent means the
   * `verified` posture cannot be honored, and the capability fails closed to
   * rejecting rather than quietly downgrading to unverified.
   */
  readonly verifyDriver?: VerifyDriver;
  readonly now?: () => Date;
}

export interface CorpusCapability extends RuntimeCapability {
  readonly mirror: CorpusMirror;
  readonly reader: CorpusReader;
  readonly retrieval: CorpusRetrieval;
  /** Producer admission composed at start — shared with the MCP pickup filter. */
  readonly admission: CorpusAdmission;
}

interface Started {
  readonly config: RuntimeConfig;
  readonly corpus: CorpusConfig;
  readonly admission: CorpusAdmission;
  readonly chainVerification: ChainVerification;
  /** Why the configured posture is not the live one, when they differ. */
  readonly chainVerificationShortfall?: "driver-unavailable";
  /** Head-signature refusals observed since start, newest wins, keyed by `agent/name`. */
  readonly chainRejections: Map<string, string>;
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

      const chainRejections = new Map<string, string>();
      const posture = selectChainVerification(corpus.chainVerification, options.verifyDriver);

      started = {
        config: context.config,
        corpus,
        admission: composeAdmission(
          createFollowedSourceAdmission(corpus.sources),
          producerAdmission,
        ),
        chainVerification: recordingChainVerification(posture.verification, chainRejections),
        ...(posture.shortfall === undefined ? {} : { chainVerificationShortfall: posture.shortfall }),
        chainRejections,
        log: context.log,
        ...(policyError === undefined ? {} : { policyError }),
        policyCount: policyVersions.length,
      };

      context.log.info("corpus.capability.started", {
        archives: corpus.sources.length,
        configuredChainVerification: corpus.chainVerification,
        chainVerification: started.chainVerification.mode,
        ...(posture.shortfall === undefined ? {} : { chainVerificationShortfall: posture.shortfall }),
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
        // This check measures whether THIS INSTALL is configured and composed
        // coherently. When there was no way to inject a verification driver at
        // all, driver absence was a universal, operator-unfixable capability
        // fact (C5 Finding F1) and reporting it per-install would have made
        // every correct install red with a remedy nobody could act on — which
        // spec §9.3 forbids by name. Now that the driver is an injected port,
        // its absence is this composition root's choice and both exits are
        // real, so the check reports it.
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
        fs: options.fs,
        storePaths: storePathsOf(state.config),
        highWaterMarks: createFileHighWaterMarkStore({
          filePath: state.config.mirrorStatePath,
          fs: options.fs,
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

    get admission(): CorpusAdmission {
      return require_().admission;
    },
  });

  /**
   * Configuration names the posture; composition decides whether the runtime
   * can honor it. `verified` without a driver is NOT silently demoted to
   * unverified — that would be the exact accident
   * `UNVERIFIED_CHAIN_ACKNOWLEDGEMENT` exists to make impossible — it fails
   * closed to rejecting, and the health check says which of the two states
   * this install is in.
   */
  function selectChainVerification(
    mode: CorpusConfig["chainVerification"],
    driver: VerifyDriver | undefined,
  ): { readonly verification: ChainVerification; readonly shortfall?: "driver-unavailable" } {
    if (mode === "unverified") {
      return { verification: createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT) };
    }
    if (mode === "rejecting") {
      return { verification: createRejectingChainVerification() };
    }
    if (driver === undefined) {
      return { verification: createRejectingChainVerification(), shortfall: "driver-unavailable" };
    }
    return { verification: createDriverChainVerification(driver) };
  }

  /**
   * A refusal is the mirror's answer to one source, and the mirror is
   * constructed per operation — so without this the reason a feed is being
   * refused lives only in that call's return value and the log, and health
   * can report only the downstream symptom (no sync position) with no cause.
   * The wrapper keeps the newest reason per source so the check can name it.
   */
  function recordingChainVerification(
    inner: ChainVerification,
    rejections: Map<string, string>,
  ): ChainVerification {
    return Object.freeze({
      mode: inner.mode,
      async verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome> {
        const key = `${input.source.agent}/${input.source.name}`;
        const outcome = await inner.verify(input);
        if (outcome.status === "rejected") rejections.set(key, outcome.reason);
        else rejections.delete(key);
        return outcome;
      },
    });
  }

  function storePathsOf(config: RuntimeConfig) {
    return {
      catalogPath: config.mirrorCatalogPath,
      objectsDirectory: config.mirrorObjectsDirectory,
      fs: options.fs,
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
   * Every state below is one an operator can either act on or has explicitly
   * asked for, which is what keeps red worth reading:
   *  - nothing to verify (no archives followed) → green;
   *  - the driver posture is live → green, and any source the driver has
   *    actually refused is named here with its reason, because the mirror
   *    that saw the refusal is constructed per operation and cannot report it;
   *  - `verified` configured but the runtime was composed without a driver →
   *    red: this install indexes nothing, and both exits (compose the driver,
   *    or choose another posture) are in the remedy;
   *  - archives followed with the unverified posture acknowledged → green,
   *    with the posture named in `detail` and `remedy: null`, because the
   *    operator explicitly wrote that flag and there is nothing to do;
   *  - archives followed with the rejecting posture → red, because that
   *    install will silently never index anything and one config line fixes
   *    it.
   */
  function chainVerificationCheck(state: Started): HealthCheck {
    const name = "corpus-chain-verification";
    // Every branch below keys off the CONFIGURED posture, never the live
    // object's `mode`: `mode` has two values for three postures — rejecting
    // reports itself as `unverified` because it, too, verifies nothing — so
    // reading it here would render an install that admits nothing as one that
    // is happily mirroring.
    const configured = state.corpus.chainVerification;
    if (configured === "verified" && state.chainVerificationShortfall === undefined) {
      const refused = [...state.chainRejections.entries()];
      return {
        name,
        ok: refused.length === 0,
        detail:
          refused.length === 0
            ? "Announcement chains are verified before indexing."
            : `Announcement chains are verified before indexing; ${String(refused.length)} ` +
              `archive(s) were refused at their last verification: ${refused
                .map(([source, reason]) => `${source} (${reason})`)
                .join(", ")}.`,
        remedy:
          refused.length === 0
            ? null
            : "A refused archive is serving a chain this runtime cannot verify; the reason above " +
              "names which check failed — start from the archive's head signature, the signing " +
              "keys this runtime resolves for it, and the entry linkage it served.",
      };
    }
    if (state.corpus.sources.length === 0) {
      return {
        name,
        ok: true,
        detail: "No archives are followed, so there is no announcement chain to verify.",
        remedy: null,
      };
    }
    if (configured === "verified") {
      return {
        name,
        ok: false,
        detail:
          `${String(state.corpus.sources.length)} archive(s) are followed under the \`verified\` ` +
          "posture, but this runtime was composed without an announcement-chain verification " +
          "driver, so the mirror will not index anything from them.",
        remedy:
          "Compose the runtime with a corpus verification driver, or — for local development " +
          "only — set `corpus.chainVerification` to `unverified` together with " +
          "`corpus.acknowledgeUnverifiedChain`.",
      };
    }
    if (configured === "unverified") {
      return {
        name,
        ok: true,
        detail:
          "Mirroring without announcement-chain verification — signatures on followed archives " +
          "are not verified by this runtime. Record digests and producer admission still apply.",
        remedy: null,
      };
    }
    return {
      name,
      ok: false,
      detail:
        `${String(state.corpus.sources.length)} archive(s) are followed under the \`rejecting\` ` +
        "posture, so the mirror will not index anything from them.",
      remedy:
        "Set `corpus.chainVerification` to `verified` (and compose the runtime with a " +
        "verification driver), or to `unverified` with `corpus.acknowledgeUnverifiedChain` for " +
        "local development.",
    };
  }

  function buildReader(state: Started): CorpusReader {
    return createCorpusReader({
      storePaths: storePathsOf(state.config),
      sources: state.corpus.sources,
      admission: state.admission,
      highWaterMarks: createFileHighWaterMarkStore({
        filePath: state.config.mirrorStatePath,
        fs: options.fs,
      }),
    });
  }

  function loggerOf(state: Started): RuntimeLogger {
    return state.log;
  }
}
