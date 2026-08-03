// SPDX-License-Identifier: MIT

import type { RunRecord } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { localAssemblyPorts } from "./assembly-ports.js";

const MINIMAL = { inputScope: { cellsForRun: () => [] }, pinning: { evidenceFor: () => undefined } };

describe("localAssemblyPorts", () => {
  test("wires every port the assembly procedure consumes", () => {
    const ports = localAssemblyPorts(MINIMAL);
    expect(Object.keys(ports).sort())
      .toEqual(["admission", "closeBoundary", "cost", "inputScope", "pinning", "trust"]);
  });

  test("omits the optional Matrix signature port: a local venue signs no Matrix authority", () => {
    expect(localAssemblyPorts(MINIMAL).verifySignatures).toBeUndefined();
  });

  test("resolves nothing when no trust resolver is supplied", async () => {
    expect(await localAssemblyPorts(MINIMAL).trust.resolveAgent({}, new Date()))
      .toBe("unresolved");
  });

  test("wraps a supplied trust resolver fail-closed", async () => {
    const ports = localAssemblyPorts({
      ...MINIMAL,
      trust: { async resolveAgent() { throw new Error("binding store offline"); } },
    });
    // Assembly must stay total: an unresolvable identity is `unresolved`, never a throw.
    expect(await ports.trust.resolveAgent({}, new Date())).toBe("unresolved");
  });

  test("defaults the integrity tier to attested-only without an admission source", async () => {
    const ports = localAssemblyPorts(MINIMAL);
    expect(await ports.admission.tierFor({ cellKey: "a/arm/1", taskDigest: "a".repeat(64) }))
      .toBe("attested-only");
  });

  test("resolves the close boundary from the Run's own closeAt", async () => {
    const ports = localAssemblyPorts(MINIMAL);
    expect(await ports.closeBoundary.resolve({ closeAt: "2026-08-04T00:00:00Z" } as RunRecord))
      .toEqual({ at: "2026-08-04T00:00:00Z" });
  });
});
