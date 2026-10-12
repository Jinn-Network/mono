// SPDX-License-Identifier: Apache-2.0

/**
 * The named coverage slices of an official suite.
 *
 * A suite selection states its coverage as one word: the first task, the first ten, the whole
 * dataset, or a custom selection. The word is derived from the selected task names and is never
 * free text, so two producers selecting the same tasks state the same coverage.
 *
 * The rule lives in the checker because a bundle that declares `terminal-bench-2-1-comparability`
 * seals its coverage in the Benchmark, and the checker recomputes the word from the selected names
 * rather than copy it. The product core re-exports these helpers from
 * `runtime/suite-protocol/manifest.ts`, so every producer and the checker run one implementation.
 */

export const SUITE_COVERAGE = ["one_task", "ten_task", "full", "custom"] as const;
export type SuiteCoverage = (typeof SUITE_COVERAGE)[number];

/** Lexicographic (Unicode code-point) first 1 / first 10 / all. Do not pick weekly. */
export function namedSliceTaskNames(taskNames: readonly string[], coverage: Exclude<SuiteCoverage, "custom">): string[] {
  const sorted = [...taskNames].sort(compareCodePoints);
  if (coverage === "one_task") return sorted.slice(0, 1);
  if (coverage === "ten_task") return sorted.slice(0, 10);
  return sorted;
}

export function coverageFromSelectedNames(datasetTaskNames: readonly string[], selected: readonly string[]): SuiteCoverage {
  const one = namedSliceTaskNames(datasetTaskNames, "one_task");
  const ten = namedSliceTaskNames(datasetTaskNames, "ten_task");
  const full = namedSliceTaskNames(datasetTaskNames, "full");
  if (sameNames(selected, one)) return "one_task";
  if (sameNames(selected, ten)) return "ten_task";
  if (sameNames(selected, full)) return "full";
  return "custom";
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftPoints[index] !== rightPoints[index]!) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}
