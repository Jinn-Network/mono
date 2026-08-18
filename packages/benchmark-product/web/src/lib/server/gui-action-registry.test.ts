import { describe, expect, test } from "vitest";
import { GUI_CAPABILITY_CATALOG } from "@colophon-claims/core";
import { GUI_SERVER_ACTIONS } from "./gui-action-registry";

const EXPECTED_UNAVAILABLE_REASONS = {
  importBinaryItemBank:
    "requires local licensed item, source/license, and human-admission manifests; browser upload is intentionally unavailable",
  createHumanReviewPackets:
    "requires local licensed item files and evaluator packet custody; browser upload is intentionally unavailable",
  signHumanReviewResponse:
    "requires a machine-local configured signer key; browser key custody is forbidden",
  admitHumanTruth:
    "requires local signed-review, roster, and licensed truth evidence files",
  selectInspectEvalRuntime:
    "requires machine-local Inspect host paths; browser-supplied paths are forbidden",
  exportInspectViewBundle:
    "copies machine-local Inspect .eval logs; browser path-based View export is forbidden",
  bindInspectBinaryJudge:
    "requires machine-local OCI runtime paths and pre-sealed instrument digests; browser-supplied paths are forbidden",
  selectHarborRuntime:
    "requires server-configured Harbor host paths; browser-supplied paths are forbidden",
  selectTerminalBench2Runtime:
    "requires server-configured Terminal-Bench and Harbor host paths; browser-supplied paths are forbidden",
  selectTerminalBench21Runtime:
    "requires server-configured Terminal-Bench 2.1 and Harbor host paths; browser-supplied paths are forbidden",
  selectTerminalBench30Runtime:
    "requires server-configured Terminal-Bench 3.0 and Harbor host paths; browser-supplied paths are forbidden",
  selectSwebenchVerifiedRuntime:
    "requires server-configured SWE-bench Verified harness paths; browser-supplied paths are forbidden",
  selectApexAgentsRuntime:
    "requires server-configured APEX-Agents Archipelago paths; browser-supplied paths are forbidden",
  selectApexSweDevRuntime:
    "requires server-configured APEX-SWE-dev host paths; browser-supplied paths are forbidden",
  selectDeepSweV11Runtime:
    "requires server-configured DeepSWE v1.1 and Pier host paths; browser-supplied paths are forbidden",
  migrateTerminalBenchLegacyTask:
    "requires server-configured migration input paths; browser-supplied paths are forbidden",
  exportHarborHubPackage:
    "copies a machine-local Harbor job directory; browser path-based job export is forbidden",
  exportSwebenchPredictions:
    "copies machine-local predictions and harness reports; browser path-based export is forbidden",
  exportApexAgentsInspection:
    "copies machine-local Archipelago grades; browser path-based export is forbidden",
  exportApexSwePackage:
    "copies machine-local Mercor harness JSON; browser path-based export is forbidden",
  exportDeepSwePackage:
    "copies a machine-local Pier job directory; browser path-based job export is forbidden",
} as const;

describe("generated library / CLI / GUI parity", () => {
  test("every shipped GUI capability has exactly one server action and every operation is dispositioned", () => {
    const shipped = Object.values(GUI_CAPABILITY_CATALOG)
      .filter((capability) => capability.status === "shipped")
      .map((capability) => capability.action)
      .sort();
    expect(Object.keys(GUI_SERVER_ACTIONS).sort()).toEqual(shipped);

    for (const [operation, capability] of Object.entries(GUI_CAPABILITY_CATALOG)) {
      if (capability.status === "shipped") {
        expect(GUI_SERVER_ACTIONS, `${operation} maps to a missing rendered server action`).toHaveProperty(capability.action);
      } else {
        expect(capability.status).toBe("unavailable");
        expect(GUI_SERVER_ACTIONS).not.toHaveProperty(operation);
      }
    }

    // The anchor surface is shipped on both sides, not silently CLI-only: its endpoint is server
    // configuration, which is exactly what makes a GUI action safe to offer.
    expect(GUI_CAPABILITY_CATALOG.runAnchor).toEqual({ status: "shipped", action: "run.anchor" });
    expect(GUI_CAPABILITY_CATALOG.anchoringConfigure).toEqual({ status: "shipped", action: "anchoring.configure" });

    const unavailableReasons = Object.fromEntries(
      Object.entries(GUI_CAPABILITY_CATALOG)
        .flatMap(([operation, capability]) => capability.status === "unavailable"
          ? [[operation, capability.reason] as const]
          : []),
    );
    expect(unavailableReasons).toEqual(EXPECTED_UNAVAILABLE_REASONS);
  });

  test("no operation remains deferred; unsafe runtime path inputs are explicitly unavailable", () => {
    const deferred = Object.entries(GUI_CAPABILITY_CATALOG as Readonly<Record<string, { readonly status: string; readonly deferredTo?: string }>>)
      .filter(([, capability]) => capability.status === "deferred")
      .map(([operation, capability]) => [operation, capability.deferredTo ?? ""]);
    expect(deferred).toEqual([]);
  });
});
