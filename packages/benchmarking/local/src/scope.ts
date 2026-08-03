// SPDX-License-Identifier: MIT

import type {
  CellCost,
  CloseBoundary,
  CloseBoundaryResolver,
  CostSource,
  InputScope,
  InScopeCell,
  TrustResolver,
} from "@jinn-network/benchmarking-run";
import type { RunRecord } from "@jinn-network/benchmarking-records";

export interface LocalInputScopeInput {
  /**
   * The owner-curated in-scope cells for a Run (benchmarking design §7.2 leg (c) / §12.2:
   * on a self-run local venue the scope is declared by the owner, not derived from a chain).
   */
  readonly cellsForRun: (
    runDigest: string,
  ) => Iterable<InScopeCell> | AsyncIterable<InScopeCell>;
  /** Set when launch drained early; the Matrix's run outcome becomes `cancelled`. */
  readonly runCancelled?: boolean;
}

/** Local-venue `InputScope` over a declared cell set. */
export function localInputScope(input: LocalInputScopeInput): InputScope {
  return {
    async *submissionsForRun(runDigest) {
      for await (const cell of input.cellsForRun(runDigest)) yield cell;
    },
    ...(input.runCancelled === undefined ? {} : { runCancelled: input.runCancelled }),
  };
}

/**
 * Local-venue `CloseBoundaryResolver`: `at` only.
 *
 * A local venue has no chain to anchor against, and the boundary's `at` MUST equal the Run's
 * pre-registered `closeAt` (design §8.1) — so there is nothing to resolve and nothing to
 * discover. Emitting a fabricated anchor here would be a false claim of finality.
 */
export function localCloseBoundary(): CloseBoundaryResolver {
  return {
    async resolve(run: RunRecord): Promise<CloseBoundary> {
      return { at: run.closeAt };
    },
  };
}

/**
 * Wrap a host-supplied trust resolver so a failure resolves to `unresolved` rather than
 * aborting assembly. Fail-closed: an unresolved identity is counted as unresolved for
 * independence accounting (design §8.3), which is strictly more conservative than a throw
 * that would leave the Matrix unassembled.
 */
export function failClosedTrustResolver(inner: TrustResolver): TrustResolver {
  return {
    async resolveAgent(evidence, at) {
      try {
        const resolved = await inner.resolveAgent(evidence, at);
        return typeof resolved === "string" && resolved.length > 0 ? resolved : "unresolved";
      } catch {
        return "unresolved";
      }
    },
  };
}

/** A trust resolver that resolves nothing — the honest floor when no bindings are wired. */
export function unresolvedTrustResolver(): TrustResolver {
  return {
    async resolveAgent() {
      return "unresolved";
    },
  };
}

export interface LocalCostInput {
  /** Cost the local runtime reported for a cell, in the Run's budget unit. */
  readonly costFor?: (
    cell: InScopeCell,
  ) => { value: string; unit: string } | undefined | Promise<{ value: string; unit: string } | undefined>;
  readonly latencyFor?: (cell: InScopeCell) => number | undefined | Promise<number | undefined>;
}

/**
 * Local-venue `CostSource`. The source is always `reported`: a local venue has no settlement
 * layer, so it can never produce a settled figure, and a reported figure must never be
 * dressed up as one.
 */
export function localReportedCost(input: LocalCostInput = {}): CostSource {
  return {
    async costFor(cell): Promise<CellCost | undefined> {
      const reported = await input.costFor?.(cell);
      if (reported === undefined) return undefined;
      return { value: reported.value, unit: reported.unit, source: "reported" };
    },
    async latencyFor(cell) {
      return input.latencyFor?.(cell);
    },
  };
}
