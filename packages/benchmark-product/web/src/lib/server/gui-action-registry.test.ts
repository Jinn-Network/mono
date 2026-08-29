import { describe, expect, test } from "vitest";
import { GUI_CAPABILITY_CATALOG } from "@colophon-claims/core";
import { GUI_SERVER_ACTIONS } from "./gui-action-registry";

const EXPECTED_UNAVAILABLE_REASONS = {
  importRunRecords:
    "reads a local run dump and every evidence file it names by relative path; browser upload of a path-rooted evidence tree is intentionally unavailable",
  importBinaryItemBank:
    "requires local licensed item, source/license, and human-admission manifests; browser upload is intentionally unavailable",
  createHumanReviewPackets:
    "requires local licensed item files and evaluator packet custody; browser upload is intentionally unavailable",
  signHumanReviewResponse:
    "requires a machine-local configured signer key; browser key custody is forbidden",
  admitHumanTruth:
    "requires local signed-review, roster, and licensed truth evidence files",
  migrateTerminalBenchLegacyTask:
    "requires server-configured migration input paths; browser-supplied paths are forbidden",
  exportDerivedBundle:
    "copies a machine-local job or log directory; browser path-based export is forbidden",
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
