import {
  expectedCellCount,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import type { BenchmarkBackendCapabilities } from "./backend-port.js";

export type QuoteErrorCode = "hard-cap-breach" | "unsupported-requirement";

export interface QuoteError {
  code: QuoteErrorCode;
  detail: string;
}

export interface QuoteReport {
  ok: boolean;
  expectedCellCount: number;
  estimatedCost?: { value: string; unit: string };
  errors: QuoteError[];
}

function mergeRequirements(
  pinning: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  return { ...baseline, ...pinning };
}

function unsupportedPinningErrors(
  run: RunRecord,
  caps: BenchmarkBackendCapabilities,
): QuoteError[] {
  const supported = new Map<string, Set<string>>(
    caps.runPinning.keys.map((entry: { key: string; inventory: readonly string[] }) => [
      entry.key,
      new Set(entry.inventory),
    ]),
  );
  const errors: QuoteError[] = [];
  for (const arm of run.arms) {
    const requirements = mergeRequirements(
      arm.pinning as Record<string, unknown>,
      run.policy.submissionBaseline as Record<string, unknown>,
    );
    for (const [key, value] of Object.entries(requirements)) {
      const inventory = supported.get(key);
      if (inventory === undefined) {
        errors.push({
          code: "unsupported-requirement",
          detail: `arm ${arm.armId}: pinning key "${key}" is not in backend runPinning inventory`,
        });
        continue;
      }
      const id =
        value !== null && typeof value === "object" && "id" in value
          ? String((value as { id: unknown }).id)
          : typeof value === "string"
            ? value
            : undefined;
      if (id !== undefined && !inventory.has(id)) {
        errors.push({
          code: "unsupported-requirement",
          detail: `arm ${arm.armId}: ${key} id "${id}" is not in backend inventory`,
        });
      }
    }
  }
  return errors;
}

function parseDecimal(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid decimal: ${value}`);
  return parsed;
}

/**
 * Side-effect-free validate + price (§10.1 op 3). Nothing signs, posts, or spends.
 * Unsupported pinning keys surface as quote errors, never throws.
 */
export function quoteRun(
  bench: BenchmarkRecord,
  run: RunRecord,
  caps: BenchmarkBackendCapabilities,
): QuoteReport {
  const cells = expectedCellCount(bench, run);
  const errors: QuoteError[] = [...unsupportedPinningErrors(run, caps)];

  let estimatedCost: QuoteReport["estimatedCost"];
  if (run.budget !== undefined) {
    const perCell =
      parseDecimal(run.budget.perCell.solve) + parseDecimal(run.budget.perCell.evaluate);
    const total = perCell * cells;
    estimatedCost = { value: String(total), unit: run.budget.unit };
    if (total > parseDecimal(run.budget.hardCap)) {
      errors.push({
        code: "hard-cap-breach",
        detail: `estimated cost ${total} ${run.budget.unit} exceeds hardCap ${run.budget.hardCap}`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    expectedCellCount: cells,
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    errors,
  };
}
