import { describe, expect, test } from "vitest";
import { ATTEMPT_STATES, TERMINAL_STATES } from "./states.js";

describe("Attempt state machine", () => {
  test("has exactly the 8 §10.3 states", () => {
    expect([...ATTEMPT_STATES]).toEqual([
      "pending", "running", "delivered", "failed", "rejected", "cancelled",
      "expired", "lost",
    ]);
  });

  test("the terminal partition is every state except pending/running", () => {
    expect([...TERMINAL_STATES]).toEqual([
      "delivered", "failed", "rejected", "cancelled", "expired", "lost",
    ]);
    expect(TERMINAL_STATES).not.toContain("pending");
    expect(TERMINAL_STATES).not.toContain("running");
    expect(TERMINAL_STATES.length + 2).toBe(ATTEMPT_STATES.length);
  });
});
