import { describe, expect, test } from "vitest";
import type {
  AdmissionEvidencePort,
  AssemblyPorts,
  CloseBoundaryResolver,
  CostSource,
  InScopeCell,
  InputScope,
  PinningObservationPort,
  TrustResolver,
} from "./ports.js";

describe("injected assembly ports (design §8.3)", () => {
  test("a hand-built stub satisfies every port interface", async () => {
    const cell: InScopeCell = {
      cellKey: "a".repeat(64) + "/armA/1",
      armId: "armA",
      replicate: 1,
      taskDigest: "a".repeat(64),
      dispatches: 1,
      attempt: "urn:uuid:00000000-0000-5000-8000-000000000001",
      verdicts: [],
    };

    const inputScope: InputScope = {
      async *submissionsForRun() {
        yield cell;
      },
    };
    const trust: TrustResolver = {
      async resolveAgent() {
        return "urn:uuid:00000000-0000-5000-8000-000000000099";
      },
    };
    const closeBoundary: CloseBoundaryResolver = {
      async resolve(run) {
        return { at: run.closeAt };
      },
    };
    const pinning: PinningObservationPort = {
      async observe() {
        return {
          harness: "match",
          model: "match",
          loadout: "match",
          isolation: "match",
        };
      },
    };
    const admission: AdmissionEvidencePort = {
      async tierFor() {
        return "attested-only";
      },
    };
    const cost: CostSource = {
      async costFor() {
        return { value: "1.00", unit: "USD", source: "reported" };
      },
      async latencyFor() {
        return 42;
      },
    };

    const ports: AssemblyPorts = {
      inputScope,
      trust,
      closeBoundary,
      pinning,
      admission,
      cost,
    };

    const cells: InScopeCell[] = [];
    for await (const item of ports.inputScope.submissionsForRun("sha256:" + "b".repeat(64))) {
      cells.push(item);
    }
    expect(cells).toHaveLength(1);
    expect(await ports.trust.resolveAgent({}, new Date("2026-08-04T00:00:00Z"))).toMatch(/^urn:uuid:/);
    expect((await ports.closeBoundary.resolve({ closeAt: "2026-08-04T00:00:00Z" } as never)).at).toBe(
      "2026-08-04T00:00:00Z",
    );
    expect((await ports.pinning.observe({}, {})).harness).toBe("match");
    expect(await ports.admission.tierFor("a".repeat(64), "e".repeat(64))).toBe("attested-only");
    expect(await ports.cost.costFor(cell)).toEqual({ value: "1.00", unit: "USD", source: "reported" });
    expect(await ports.cost.latencyFor(cell)).toBe(42);
  });
});
