import { describe, expect, test } from "vitest";
import { GUI_CAPABILITY_CATALOG } from "@colophon-claims/core";
import { GUI_SERVER_ACTIONS } from "./gui-action-registry";

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
      } else expect.fail(`${operation} is still deferred to ${capability.deferredTo}`);
    }
  });

  test("no shipped operation remains deferred after BP-33", () => {
    const deferred = Object.entries(GUI_CAPABILITY_CATALOG)
      .filter(([, capability]) => capability.status === "deferred")
      .map(([operation, capability]) => [operation, capability.status === "deferred" ? capability.deferredTo : ""]);
    expect(deferred).toEqual([]);
  });
});
