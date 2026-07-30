import type { EvaluationSpec } from "./schema.js";
import type { MeasurementMap } from "./verdict-rule.js";

/** The names of every measurement the spec declares `required: true`. */
export function requiredMeasurementNames(spec: EvaluationSpec): string[] {
  return spec.measurements
    .filter((measurement) => measurement.required)
    .map((measurement) => measurement.name);
}

/** Whether a delivered measurement map covers every measurement the spec requires. */
export function checkMeasurementCoverage(
  spec: EvaluationSpec,
  delivered: MeasurementMap,
): { ok: true } | { ok: false; missing: string[] } {
  const missing = requiredMeasurementNames(spec).filter((name) => !Object.hasOwn(delivered, name));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
