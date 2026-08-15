import { describe, expect, test } from "vitest";
import {
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  isDraftMutable,
  transition,
  type LifecycleEvent,
  type LifecycleState,
} from "./lifecycle.js";

/** Every legal row of the spec §4.1 transition table, in the order the spec lists them. */
const LEGAL_TRANSITIONS: ReadonlyArray<readonly [LifecycleState, LifecycleEvent, LifecycleState]> = [
  ["draft", "edit", "draft"],
  ["draft", "preview", "draft"],
  ["draft", "quote", "quoted"],
  ["quoted", "preview", "quoted"],
  ["quoted", "edit", "draft"],
  ["quoted", "lock", "locked"],
  ["locked", "launch", "running"],
  ["running", "watch", "running"],
  ["running", "resume", "running"],
  ["running", "cancel", "closed"],
  ["running", "close-boundary", "closed"],
  ["closed", "report", "reported"],
  ["reported", "publish", "published-bundle"],
];

describe("transition — every legal row", () => {
  for (const [state, event, expected] of LEGAL_TRANSITIONS) {
    test(`${state} --${event}--> ${expected}`, () => {
      expect(transition(state, event)).toEqual({ ok: true, state: expected });
    });
  }
});

describe("transition — exhaustive illegal sweep", () => {
  const legalSet = new Set(LEGAL_TRANSITIONS.map(([state, event]) => `${state}::${event}`));

  for (const state of LIFECYCLE_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      if (legalSet.has(`${state}::${event}`)) continue;

      test(`${state} --${event}--> refused`, () => {
        const result = transition(state, event);
        expect(result.ok).toBe(false);
        if (result.ok) return; // unreachable; narrows for TS below
        expect(result.error.code).toBe("illegal-transition");
        expect(result.error.detail).toContain(state);
        expect(result.error.detail).toContain(event);
      });
    }
  }

  test("the sweep actually covers every non-legal pair (sanity on the sweep itself)", () => {
    const totalPairs = LIFECYCLE_STATES.length * LIFECYCLE_EVENTS.length;
    expect(totalPairs - legalSet.size).toBeGreaterThan(0);
  });
});

describe("isDraftMutable", () => {
  test("true for draft", () => {
    expect(isDraftMutable("draft")).toBe(true);
  });

  test("true for quoted", () => {
    expect(isDraftMutable("quoted")).toBe(true);
  });

  test("false for every later state", () => {
    expect(isDraftMutable("locked")).toBe(false);
    expect(isDraftMutable("running")).toBe(false);
    expect(isDraftMutable("closed")).toBe(false);
    expect(isDraftMutable("reported")).toBe(false);
    expect(isDraftMutable("published-bundle")).toBe(false);
  });
});

describe("preview is non-advancing (A5)", () => {
  test("draft --preview--> draft (unchanged)", () => {
    expect(transition("draft", "preview")).toEqual({ ok: true, state: "draft" });
  });

  test("quoted --preview--> quoted (unchanged)", () => {
    expect(transition("quoted", "preview")).toEqual({ ok: true, state: "quoted" });
  });
});

describe("edit invalidates a quote (A2)", () => {
  test("quoted --edit--> draft", () => {
    expect(transition("quoted", "edit")).toEqual({ ok: true, state: "draft" });
  });
});
