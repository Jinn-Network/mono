// SPDX-License-Identifier: MIT

// The chain-derived half of the projector-backed `MarketplaceObservePort` (design §7, Task 16).
// Composes `observe-store.ts`'s durable requester-scope + delivery-bytes store with the
// projector's own reorg-aware canonical selection (`selectCanonicalMarketplaceObservations`) to
// retire the binding's in-memory stub (§6.1: "Milestone M4, not yet built"). `observe`/`recover`/
// `drive` fold the host-supplied projector feed for one Attempt at a time, filtered through the
// chain log source's orphaned-hash set, so a reorged fact is excluded while an explicit `lost`
// correction survives (§7.30).
import { selectCanonicalMarketplaceObservations } from "@jinn-network/marketplace-projector";
import type { MarketplaceChainConfig, MarketplaceObservePort } from "@jinn-network/marketplace-binding";
import {
  TaskExecutionError,
  type AttemptUri,
  type ObservationCursor,
  type ObservationSnapshot,
  type ReconciliationReport,
  type SubmissionUri,
} from "@jinn-network/task-execution-backend";
import { foldObservations, type AttemptDescriptor, type ProtocolObservation } from "@jinn-network/task-execution-protocol";
import type { ChainLogSource } from "../log-source/chain-log-source.js";
import type { VenueStateDatabase } from "../state/database.js";
import { createObserveStore } from "./observe-store.js";

const ATTEMPT_ENGAGED_TYPE = "network.jinn.task-execution.attempt-engaged.v1";

type EngagedObservation = Extract<ProtocolObservation, { type: typeof ATTEMPT_ENGAGED_TYPE }>;

function isEngaged(observation: ProtocolObservation): observation is EngagedObservation {
  return observation.type === ATTEMPT_ENGAGED_TYPE;
}

function bySequence(a: ProtocolObservation, b: ProtocolObservation): number {
  return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0;
}

export interface CreateProjectorObservePortInput {
  // Every observation already carries its own `derivation.chainId`; `chain` is accepted for
  // signature symmetry with the sibling port factories (Tasks 7-15), not read here.
  readonly chain: MarketplaceChainConfig;
  readonly state: VenueStateDatabase;
  readonly logSource: ChainLogSource;
  /** The host's projector-fed observation source (every observation ever projected). */
  readonly observations: () => Promise<readonly ProtocolObservation[]>;
}

/** Builds the production `MarketplaceObservePort`: projector-backed, retiring the in-memory stub. */
export function createProjectorObservePort(input: CreateProjectorObservePortInput): MarketplaceObservePort {
  const store = createObserveStore(input.state);
  // Host-driven observations (`drive`) and `simulateReconciliation` overrides are process-local
  // by design (design §7, Task 16 schema): neither table in the Task 16 schema addition persists
  // them, and both are conformance-kit / cross-source-annotation hooks, not chain facts.
  const driven = new Map<AttemptUri, ProtocolObservation[]>();
  const reconciliationOverrides = new Map<string, ReconciliationReport>();

  async function canonicalObservations(): Promise<readonly ProtocolObservation[]> {
    const raw = await input.observations();
    return selectCanonicalMarketplaceObservations(raw, input.logSource.orphanedBlockHashes());
  }

  function observationsFor(canonical: readonly ProtocolObservation[], attempt: AttemptUri): ProtocolObservation[] {
    return [...canonical.filter((observation) => observation.subject === attempt), ...(driven.get(attempt) ?? [])]
      .sort(bySequence);
  }

  /**
   * Resolves a ref to its Attempt (§14): the ref may already be an Attempt the chain (or a
   * `drive`-supplied observation) has recorded against; otherwise it is treated as a Submission,
   * resolved first through a canonical `attempt-engaged` fact and, failing that, through the
   * durable requester-scope's recorded two-party engagement (TEP Addendum 2026-07-28-b) -- the
   * case where the scope is resolved before the projector has ingested the matching chain log.
   */
  function resolveAttempt(
    canonical: readonly ProtocolObservation[],
    ref: SubmissionUri | AttemptUri,
  ): AttemptUri | undefined {
    if (canonical.some((observation) => observation.subject === ref) || driven.has(ref as AttemptUri)) {
      return ref as AttemptUri;
    }
    const engagedBySubmission = canonical.find(
      (observation): observation is EngagedObservation => isEngaged(observation) && observation.data.submission === ref,
    );
    if (engagedBySubmission !== undefined) return engagedBySubmission.subject as AttemptUri;
    return store.findResolvedScope(ref as SubmissionUri)?.engagementAttempt;
  }

  return {
    claimSubmissionScope: store.claimSubmissionScope,
    readSubmissionScope: store.readSubmissionScope,
    scanPendingSubmissionScopes: store.scanPendingSubmissionScopes,
    reclaimSubmissionScope: store.reclaimSubmissionScope,
    resolveRecoveredSubmissionScope: store.resolveRecoveredSubmissionScope,
    resolveSubmissionScope: store.resolveSubmissionScope,
    recordDelivery: store.recordDelivery,
    deliveries: store.deliveries,
    fetchDelivery: store.fetchDelivery,

    async observe(ref): Promise<ObservationSnapshot> {
      const canonical = await canonicalObservations();
      const attempt = resolveAttempt(canonical, ref);
      if (attempt === undefined) {
        throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt or Submission for ref "${ref}"` });
      }
      const observations = observationsFor(canonical, attempt);
      const engaged = observations.find(isEngaged);
      if (engaged === undefined) {
        throw new TaskExecutionError("attempt-not-found", { detail: `no attempt-engaged observation recorded for "${attempt}"` });
      }
      const derived = foldObservations(observations, {
        now: new Date().toISOString(),
        effectiveDeadline: engaged.data.effectiveDeadline,
      });
      const descriptor: AttemptDescriptor = {
        attempt,
        // The schema-level `Sha256Digest`/`UrnUuid` regexes infer as plain `string` (`common.ts`);
        // `AttemptDescriptor` pins the stricter branded literal, so the cast is a type-level
        // narrowing only -- the runtime value is already regex-validated at observation ingest.
        task: engaged.data.task as `sha256:${string}`,
        submission: engaged.data.submission as `urn:uuid:${string}`,
        ...(engaged.data.annotations !== undefined ? { annotations: engaged.data.annotations } : {}),
        derived,
      };
      const cursor: ObservationCursor = { sequence: observations.at(-1)?.sequence ?? "0000000000000000" };
      return { descriptor, cursor, observations };
    },

    async recover(ref): Promise<ReconciliationReport> {
      const override = reconciliationOverrides.get(ref);
      if (override !== undefined) {
        reconciliationOverrides.delete(ref);
        return override;
      }
      const canonical = await canonicalObservations();
      const scope = store.findResolvedScope(ref as SubmissionUri);
      const durableAttempt = scope?.engagementAttempt ?? (ref as AttemptUri);
      const chainEngaged = canonical.find(
        (observation): observation is EngagedObservation => isEngaged(observation) && observation.subject === durableAttempt,
      );
      if (chainEngaged === undefined) {
        return { classification: "absent", detail: `no chain-derived attempt engagement for "${durableAttempt}"` };
      }
      if (scope !== undefined && chainEngaged.data.submission !== scope.submissionUri) {
        return {
          classification: "contradictory",
          detail: `chain attempt "${durableAttempt}" is bound to Submission "${chainEngaged.data.submission}", `
            + `not the durably recorded "${scope.submissionUri}"`,
        };
      }
      return { classification: "matching" };
    },

    async drive(attempt, observations): Promise<void> {
      const canonical = await canonicalObservations();
      const known = canonical.some((observation) => observation.subject === attempt) || driven.has(attempt);
      if (!known) {
        throw new TaskExecutionError("attempt-not-found", { detail: `no Attempt "${attempt}"` });
      }
      driven.set(attempt, [...(driven.get(attempt) ?? []), ...observations]);
    },

    simulateReconciliation(ref, outcome): void {
      reconciliationOverrides.set(ref, outcome);
    },
  };
}
