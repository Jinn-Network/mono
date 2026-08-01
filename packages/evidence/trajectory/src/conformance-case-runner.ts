// SPDX-License-Identifier: Apache-2.0

import { test } from "vitest";

import {
  TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS,
  type TrajectoryDerivationConformanceCaseId,
} from "./conformance-case-manifest.js";

const registered = new Set<string>();

export function registerConformanceCase(id: TrajectoryDerivationConformanceCaseId): void {
  if (registered.has(id)) {
    throw new Error(`duplicate conformance case registration: ${id}`);
  }
  if (!(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS as readonly string[]).includes(id)) {
    throw new Error(`unregistered conformance case id: ${id}`);
  }
  registered.add(id);
}

export function assertConformanceManifestComplete(): void {
  const missing = TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS.filter((id) => !registered.has(id));
  if (missing.length > 0) {
    throw new Error(`conformance cases not executed: ${missing.join(", ")}`);
  }
  const extra = [...registered].filter(
    (id) => !(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS as readonly string[]).includes(id),
  );
  if (extra.length > 0) {
    throw new Error(`unexpected conformance case registrations: ${extra.join(", ")}`);
  }
}

export function caseTest(
  id: TrajectoryDerivationConformanceCaseId,
  fn: () => void | Promise<void>,
): void {
  registerConformanceCase(id);
  test(id, fn);
}

export function caseTestManifestIntegrity(): void {
  test("conformance case manifest is complete", () => {
    assertConformanceManifestComplete();
  });
}
