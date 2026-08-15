// SPDX-License-Identifier: MIT

import { assembleMatrix } from "@jinn-network/benchmarking-run";
import {
  buildMiniatureAssemblyPorts,
  describeAssemblyConformance,
  type AssemblyPorts as KitAssemblyPorts,
  type PinningObservationPort as KitPinningObservationPort,
} from "@jinn-network/benchmarking-testing";
import { expect, test } from "vitest";
import { localAssemblyPorts } from "./assembly-ports.js";
import { localPinningObservation, pinningObservationForCell, requirementsDigest } from "./pinning-bridge.js";

// The kit owns the assembly oracle; running its driver here proves the implementation this
// package composes against is the conformant one.
describeAssemblyConformance(assembleMatrix);

test("the local port bundle satisfies the kit's AssemblyPorts contract", () => {
  const bundle = localAssemblyPorts({
    inputScope: { cellsForRun: () => [] },
    pinning: { isolationInventory: ["fixture"], evidenceFor: () => undefined },
  });
  // Assignability is the contract: a type error here means the bundle has drifted from the
  // kit-owned shape, which is what the kit exists to prevent.
  const asKitPorts: KitAssemblyPorts = bundle;
  const asKitPinning: KitPinningObservationPort = localPinningObservation({
    isolationInventory: ["fixture"],
    evidenceFor: () => undefined,
  });
  expect(typeof asKitPorts.inputScope.submissionsForRun).toBe("function");
  expect(typeof asKitPorts.trust.resolveAgent).toBe("function");
  expect(typeof asKitPorts.closeBoundary.resolve).toBe("function");
  expect(typeof asKitPorts.admission.tierFor).toBe("function");
  expect(typeof asKitPorts.cost.costFor).toBe("function");
  expect(typeof asKitPinning.observe).toBe("function");
});

test("the local bundle drives the kit's miniature Run to the kit's own Matrix", async () => {
  // The kit's fixtures dictate the expected per-cell verification; the local bundle supplies
  // the surrounding ports and the pinning bridge is fed evidence that reproduces them.
  const { bench, run, ports: kitPorts, procedure, expectedBytes } =
    await buildMiniatureAssemblyPorts();
  const bundle = localAssemblyPorts({
    inputScope: { cellsForRun: (runDigest) => kitPorts.inputScope.submissionsForRun(runDigest) },
    pinning: { isolationInventory: ["fixture"], evidenceFor: () => undefined },
    trust: kitPorts.trust,
  });
  const assembled = await assembleMatrix(
    bench,
    run,
    { ...bundle, pinning: kitPorts.pinning, admission: kitPorts.admission, cost: kitPorts.cost },
    procedure,
  );
  // InputScope, trust wrapping, and close-boundary resolution are this package's; they must
  // not perturb the kit's byte oracle.
  expect(assembled.bytes).toEqual(expectedBytes);
});

test("the kit's miniature Matrix is not reachable through this bridge, and why", async () => {
  // Finding M-3. The bridge cannot drive the kit's byte oracle, for exactly one reason: all
  // twelve kit cells expect `loadout: "match"`, but neither the kit's arms nor its
  // submissionBaseline pin a `loadout` axis at all. `match` means "the pinned value is
  // corroborated" (identity design §7); an unpinned axis has no pinned value, so no evidence
  // a host could inject reaches `match` without fabricating a pin. Every other kit value IS
  // reachable — asserted below so this stays a statement about one axis, not a blanket
  // excuse. If the kit fixture ever pins a loadout, delete this test and wire the oracle.
  const { run } = await buildMiniatureAssemblyPorts();
  const pinnedKeys = new Set([
    ...Object.keys(run.policy.submissionBaseline),
    ...run.arms.flatMap((arm) => Object.keys(arm.pinning)),
  ]);
  expect([...pinnedKeys].sort()).toEqual(["harness", "isolationPolicy", "model"]);
  expect(pinnedKeys.has("loadout")).toBe(false);

  const pinning = { ...run.policy.submissionBaseline, ...run.arms[0]!.pinning };
  const venue = { isolationInventory: ["fixture"] };
  const evidence = {
    dispatches: 1,
    admission: { ready: true, checkedRequirementsDigest: requirementsDigest(pinning) },
  };
  expect(pinningObservationForCell({ pinning, evidence, venue })).toEqual({
    // Reachable, and reached.
    harness: "match",
    model: "match",
    isolation: "match",
    // The one unreachable value the kit oracle asserts.
    loadout: "unverifiable",
  });
});
