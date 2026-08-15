// SPDX-License-Identifier: MIT

import type {
  BenchmarkRecord,
  RunRecord,
} from "@jinn-network/benchmarking-records";
import { sealRun } from "@jinn-network/benchmarking-records";
import {
  assembleMatrix,
  launchAndWatch,
  type AssembledMatrix,
  type CellStatusEvent,
  type LaunchOptions,
  type TrustResolver,
} from "@jinn-network/benchmarking-run";
import type { ContractGeneration } from "@jinn-network/marketplace-binding";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { marketplaceAssemblyPorts } from "./assembly-ports.js";
import { freezeAuthorityProjection } from "./projection-resolver.js";
import type { CloseBoundaryPorts } from "./close-boundary.js";
import {
  resolveCoherentCloseAuthority,
  type CoherentCloseAuthority,
} from "./close-authority.js";
import type { CloseAnchorRef } from "./input-scope.js";
import type { ProjectorCellJoinPort } from "./input-scope.js";
import type { SealedRecordMaterialPort } from "./cell-authority.js";
import { deriveAuthorityProjection } from "./authority-projection.js";
import {
  MarketplaceCompositionValidationError,
  validateMarketplaceBudget,
} from "./budget-validation.js";
import {
  buildAnchoredOrderingTranscript,
  enforceAnchoredOrderingGate,
  type AnchoredOrderingTranscript,
} from "./ordering-leg-b.js";

export { MarketplaceCompositionValidationError } from "./budget-validation.js";
export { AnchoredOrderingViolationError } from "./ordering-leg-b.js";

/**
 * Composition-time marketplace profile gate (program §7.136). Local/self-run mode remains legal
 * without budget; open-competition marketplace composition requires gating independence + budget.
 */
export function validateMarketplaceComposition(
  bench: BenchmarkRecord,
  run: RunRecord,
): void {
  if (run.venue?.kind !== "open-competition") {
    throw new MarketplaceCompositionValidationError(
      "venue.kind must be open-competition for runOnMarketplace",
    );
  }
  if (run.policy.independence !== "gating") {
    throw new MarketplaceCompositionValidationError(
      "policy.independence must be gating for runOnMarketplace",
    );
  }
  validateMarketplaceBudget(bench, run);
}

/** Host-injected projector surface — events are collected only after close anchor resolution. */
export interface MarketplaceProjectorPorts {
  /**
   * Authoritative projector event stream finalized through the resolved close anchor.
   * Called once after `launchAndWatch` completes and the close anchor is ready.
   */
  eventsThroughAnchor(
    anchor: CloseAnchorRef,
  ):
    | Iterable<ObservationMarketplaceEvent>
    | AsyncIterable<ObservationMarketplaceEvent>;
  readonly orphanedBlockHashes?: ReadonlySet<string>;
  readonly join: ProjectorCellJoinPort;
  readonly sealedRecordMaterial?: SealedRecordMaterialPort;
  readonly generation: ContractGeneration;
}

export interface RunOnMarketplaceOptions extends LaunchOptions {
  readonly closeBoundary: CloseBoundaryPorts;
  readonly projector: MarketplaceProjectorPorts;
  readonly trust: TrustResolver;
}

export interface RunOnMarketplaceResult {
  readonly statusEvents: readonly CellStatusEvent[];
  readonly matrix: AssembledMatrix;
  readonly anchoredOrdering: AnchoredOrderingTranscript;
  readonly coherentClose: CoherentCloseAuthority;
}

async function collectEventsOnce(
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

/**
 * Marketplace venue composition (M7 Task 7.2): unmodified `launchAndWatch` + `assembleMatrix`
 * with marketplace-backed ports. The binding is consumed only through `TaskExecutionBackend`
 * (2-arg `submit` only; never `engagement`, program §7.135).
 */
export async function runOnMarketplace(
  bench: BenchmarkRecord,
  run: RunRecord,
  backend: TaskExecutionBackend,
  opts: RunOnMarketplaceOptions,
): Promise<RunOnMarketplaceResult> {
  validateMarketplaceComposition(bench, run);

  const statusEvents: CellStatusEvent[] = [];
  for await (const event of launchAndWatch(bench, run, backend, opts)) {
    statusEvents.push(event);
  }

  const runCancelled = statusEvents.some((event) => event.cancelledRun === true);
  const runDigest = opts.runDigest ?? sealRun(run).digest;

  const coherent = await resolveCoherentCloseAuthority(run, opts.closeBoundary);
  const orphaned = opts.projector.orphanedBlockHashes ?? new Set<string>();
  const cachedEvents = await collectEventsOnce(
    opts.projector.eventsThroughAnchor(coherent.anchor),
  );
  const projection = deriveAuthorityProjection(cachedEvents, coherent.anchor, orphaned);

  const orderingGate = await enforceAnchoredOrderingGate({
    projection,
    runDigest,
    material: opts.projector.sealedRecordMaterial,
  });

  const authorityProjection = freezeAuthorityProjection(projection);
  const assemblyPorts = marketplaceAssemblyPorts({
    closeBoundary: opts.closeBoundary,
    coherentClose: coherent,
    authorityProjection,
    inputScope: {
      closeAnchor: coherent.anchor,
      orphanedBlockHashes: orphaned,
      runCancelled,
      join: opts.projector.join,
      sealedRecordMaterial: opts.projector.sealedRecordMaterial,
    },
    cost: {
      generation: opts.projector.generation,
      budgetUnit: run.budget!.unit,
    },
    trust: opts.trust,
  });

  const matrix = await assembleMatrix(bench, run, assemblyPorts);

  return {
    statusEvents,
    matrix,
    anchoredOrdering: buildAnchoredOrderingTranscript(orderingGate),
    coherentClose: coherent,
  };
}
