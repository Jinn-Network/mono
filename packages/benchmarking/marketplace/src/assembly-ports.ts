// SPDX-License-Identifier: MIT

import type { ContractGeneration } from "@jinn-network/marketplace-binding";
import type { AssemblyPorts, TrustResolver } from "@jinn-network/benchmarking-run";
import {
  assertCoherentCloseAnchor,
  cachedCloseBoundaryResolver,
  type CoherentCloseAuthority,
} from "./close-authority.js";
import { marketplaceCloseBoundary, type CloseBoundaryPorts } from "./close-boundary.js";
import { settledCostSource, type SettledCostPorts } from "./cost.js";
import {
  attestedPinningObservation,
  marketplaceAdmissionEvidence,
} from "./pinning-admission.js";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import {
  projectorInputScope,
  type CloseAnchorRef,
  type ProjectorCellJoinPort,
} from "./input-scope.js";
import type { SealedRecordMaterialPort } from "./cell-authority.js";
import {
  CoherentProjectionResolverError,
  deriveAuthorityProjectionResolverFromEvents,
  type AuthorityProjectionResolver,
} from "./projection-resolver.js";

/** Projector scope for coherent-close assembly (no mutable event source). */
export interface CoherentProjectorScopePorts {
  readonly closeAnchor: CloseAnchorRef;
  readonly orphanedBlockHashes?: ReadonlySet<string>;
  readonly runCancelled?: boolean;
  readonly join: ProjectorCellJoinPort;
  readonly sealedRecordMaterial?: SealedRecordMaterialPort;
  /** @deprecated Use {@link CoherentProjectorScopePorts.sealedRecordMaterial}. */
  readonly sealedSubmissionMaterial?: SealedRecordMaterialPort;
}

/** Projector scope for standalone assembly (derives projection once from events). */
export interface StandaloneProjectorScopePorts extends CoherentProjectorScopePorts {
  readonly eventsThroughAnchor: () =>
    | Iterable<ObservationMarketplaceEvent>
    | AsyncIterable<ObservationMarketplaceEvent>;
}

export type MarketplaceAssemblyPortsInput =
  | {
    readonly coherentClose: CoherentCloseAuthority;
    /** Required frozen resolver; must not re-read mutable event sources. */
    readonly authorityProjection: AuthorityProjectionResolver;
    readonly inputScope: CoherentProjectorScopePorts;
    readonly closeBoundary: CloseBoundaryPorts;
    readonly cost: Omit<SettledCostPorts, "projection" | "resolveProjection">;
    readonly trust: TrustResolver;
  }
  | {
    readonly coherentClose?: undefined;
    readonly authorityProjection?: undefined;
    readonly inputScope: StandaloneProjectorScopePorts;
    readonly closeBoundary: CloseBoundaryPorts;
    readonly cost: Omit<SettledCostPorts, "projection" | "resolveProjection">;
    readonly trust: TrustResolver;
  };

function wireSharedProjection(
  authorityProjection: AuthorityProjectionResolver,
): () => ReturnType<AuthorityProjectionResolver["resolve"]> {
  return () => authorityProjection.resolve();
}

/**
 * Wires marketplace-backed ports for `assembleMatrix` / `verifyMatrix`.
 *
 * **Coherent close:** supply `authorityProjection` frozen before wiring; do not pass
 * `eventsThroughAnchor`. InputScope and settled cost share that resolver exactly.
 *
 * **Standalone:** omit `coherentClose`; supply `eventsThroughAnchor` and the factory
 * derives the projection once internally.
 */
export function marketplaceAssemblyPorts(
  input: MarketplaceAssemblyPortsInput,
): AssemblyPorts {
  const closeAnchor = input.coherentClose?.anchor ?? input.inputScope.closeAnchor;

  let authorityProjection: AuthorityProjectionResolver;
  if (input.coherentClose !== undefined) {
    assertCoherentCloseAnchor(input.coherentClose.anchor, input.inputScope.closeAnchor);
    if (input.authorityProjection === undefined) {
      throw new CoherentProjectionResolverError(
        "coherent close assembly requires a frozen authorityProjection resolver",
      );
    }
    if ("eventsThroughAnchor" in input.inputScope) {
      throw new CoherentProjectionResolverError(
        "coherent close assembly must not supply mutable eventsThroughAnchor; freeze events before wiring authorityProjection",
      );
    }
    authorityProjection = input.authorityProjection;
  } else {
    authorityProjection = deriveAuthorityProjectionResolverFromEvents(
      input.inputScope.eventsThroughAnchor,
      closeAnchor,
      input.inputScope.orphanedBlockHashes,
    );
  }

  const resolveProjection = wireSharedProjection(authorityProjection);

  const closeBoundary = input.coherentClose !== undefined
    ? cachedCloseBoundaryResolver(input.coherentClose.boundary)
    : marketplaceCloseBoundary(input.closeBoundary);

  return {
    closeBoundary,
    inputScope: projectorInputScope({
      ...input.inputScope,
      closeAnchor,
      resolveProjection,
    }),
    cost: settledCostSource({
      ...input.cost,
      resolveProjection,
    }),
    pinning: attestedPinningObservation(),
    admission: marketplaceAdmissionEvidence(),
    trust: input.trust,
  };
}

export type { ContractGeneration };
