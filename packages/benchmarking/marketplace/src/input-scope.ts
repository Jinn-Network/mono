// SPDX-License-Identifier: MIT

import type { InputScope } from "@jinn-network/benchmarking-run";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import {
  authorizeCellFromProjection,
  type ProjectorCellJoinCandidate,
  type SealedRecordMaterialPort,
} from "./cell-authority.js";
import {
  deriveAuthorityProjection,
  isObservationEligible,
  isValidCloseAnchor,
  type AuthorityProjection,
} from "./authority-projection.js";

export { isObservationEligible, isValidCloseAnchor } from "./authority-projection.js";
export type { AuthorityProjection } from "./authority-projection.js";

export interface CloseAnchorRef {
  readonly chain: string;
  readonly blockNumber: number;
  readonly blockHash: string;
}

export interface ProjectorCellJoinPort {
  cellsFromObservations(input: {
    runDigest: string;
    observations: readonly AuthorityProjection["observations"][number][];
  }): Promise<readonly ProjectorCellJoinCandidate[]> | readonly ProjectorCellJoinCandidate[];
}

export interface ProjectorScopePorts {
  /** Host-attested marketplace events through the finalized close anchor (standalone only). */
  eventsThroughAnchor?():
    | Iterable<ObservationMarketplaceEvent>
    | AsyncIterable<ObservationMarketplaceEvent>;
  readonly closeAnchor: CloseAnchorRef;
  readonly orphanedBlockHashes?: ReadonlySet<string>;
  readonly runCancelled?: boolean;
  readonly join: ProjectorCellJoinPort;
  readonly sealedRecordMaterial?: SealedRecordMaterialPort;
  /** @deprecated Use {@link ProjectorScopePorts.sealedRecordMaterial}. */
  readonly sealedSubmissionMaterial?: SealedRecordMaterialPort;
  /** Shared authority projection (wired by {@link marketplaceAssemblyPorts}). */
  readonly resolveProjection?: () => Promise<AuthorityProjection>;
}

async function collectEvents(
  source:
    | Iterable<ObservationMarketplaceEvent>
    | AsyncIterable<ObservationMarketplaceEvent>,
): Promise<ObservationMarketplaceEvent[]> {
  const events: ObservationMarketplaceEvent[] = [];
  if (Symbol.asyncIterator in Object(source)) {
    for await (const event of source as AsyncIterable<ObservationMarketplaceEvent>) {
      events.push(event);
    }
    return events;
  }
  for (const event of source as Iterable<ObservationMarketplaceEvent>) {
    events.push(event);
  }
  return events;
}

export interface EligibleProjection {
  readonly observations: AuthorityProjection["observations"];
  readonly state: AuthorityProjection["state"];
}

/** @deprecated Use {@link deriveAuthorityProjection}. */
export function deriveEligibleProjection(
  events: readonly ObservationMarketplaceEvent[],
  anchor: CloseAnchorRef,
  orphanedBlockHashes: ReadonlySet<string> = new Set(),
): EligibleProjection {
  const projection = deriveAuthorityProjection(events, anchor, orphanedBlockHashes);
  return { observations: projection.observations, state: projection.state };
}

/** Observation-only view of {@link deriveAuthorityProjection}. */
export function deriveEligibleObservations(
  events: readonly ObservationMarketplaceEvent[],
  anchor: CloseAnchorRef,
  orphanedBlockHashes: ReadonlySet<string> = new Set(),
): AuthorityProjection["observations"] {
  return [...deriveAuthorityProjection(events, anchor, orphanedBlockHashes).observations];
}

/**
 * Projector-derived InputScope (design §8.3 / program §7.138).
 * Host join supplies coordinates only; package authority rebuilds every InScopeCell field.
 */
export function projectorInputScope(ports: ProjectorScopePorts): InputScope {
  const material = ports.sealedRecordMaterial ?? ports.sealedSubmissionMaterial;
  return {
    runCancelled: ports.runCancelled,
    async *submissionsForRun(runDigest) {
      const projection = ports.resolveProjection !== undefined
        ? await ports.resolveProjection()
        : deriveAuthorityProjection(
          await collectEvents(ports.eventsThroughAnchor!()),
          ports.closeAnchor,
          ports.orphanedBlockHashes,
        );
      if (projection.observations.length === 0) {
        return;
      }
      const candidates = await ports.join.cellsFromObservations({
        runDigest,
        observations: projection.observations,
      });
      for (const candidate of candidates) {
        const authorized = await authorizeCellFromProjection({
          runDigest,
          candidate,
          projection,
          material,
        });
        if (authorized !== undefined) {
          yield authorized;
        }
      }
    },
  };
}
