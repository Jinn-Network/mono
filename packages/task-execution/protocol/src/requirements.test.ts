import { describe, expect, test } from "vitest";
import { mergeRequirements } from "./requirements.js";

describe("mergeRequirements — comparison classes (profiles §5.1)", () => {
  test("exact: byte-equal values merge; unequal values are invalid-document", () => {
    const ok = mergeRequirements(
      { isolationPolicy: "sandboxed" },
      { isolationPolicy: "sandboxed" },
      { isolationPolicy: "exact" },
    );
    expect(ok).toEqual({ ok: true, effective: { isolationPolicy: "sandboxed" } });

    const bad = mergeRequirements(
      { isolationPolicy: "sandboxed" },
      { isolationPolicy: "unrestricted" },
      { isolationPolicy: "exact" },
    );
    expect(bad).toEqual({ ok: false, category: "invalid-document", key: "isolationPolicy" });
  });

  test("ceiling: Submission <= Task numeric value merges to the Submission's tighter value", () => {
    const ok = mergeRequirements(
      { maxAttemptDurationMs: 600000 },
      { maxAttemptDurationMs: 300000 },
      { maxAttemptDurationMs: "ceiling" },
    );
    expect(ok).toEqual({ ok: true, effective: { maxAttemptDurationMs: 300000 } });

    const bad = mergeRequirements(
      { maxAttemptDurationMs: 600000 },
      { maxAttemptDurationMs: 900000 },
      { maxAttemptDurationMs: "ceiling" },
    );
    expect(bad).toEqual({ ok: false, category: "invalid-document", key: "maxAttemptDurationMs" });
  });

  test("floor: effort tier, Submission >= Task merges to the Submission's higher tier", () => {
    const ok = mergeRequirements(
      { effort: "low" },
      { effort: "high" },
      { effort: "floor" },
    );
    expect(ok).toEqual({ ok: true, effective: { effort: "high" } });

    const bad = mergeRequirements(
      { effort: "high" },
      { effort: "low" },
      { effort: "floor" },
    );
    expect(bad).toEqual({ ok: false, category: "invalid-document", key: "effort" });
  });

  test("constraint: a Submission pin inside the Task's constraint merges to the pin", () => {
    const ok = mergeRequirements(
      { model: { provider: "anthropic" } },
      { model: { id: "claude-3-opus" } },
      { model: "constraint" },
    );
    expect(ok).toEqual({ ok: true, effective: { model: { id: "claude-3-opus" } } });

    const bad = mergeRequirements(
      { model: { provider: "anthropic" } },
      { model: { id: "gpt-4o" } },
      { model: "constraint" },
    );
    expect(bad).toEqual({ ok: false, category: "invalid-document", key: "model" });
  });

  test("addable: a key absent from the Task may be set freely by the Submission", () => {
    const ok = mergeRequirements(
      {},
      { harness: { id: "claude-code", version: "1.2.3" } },
      { harness: "addable" },
    );
    expect(ok).toEqual({
      ok: true,
      effective: { harness: { id: "claude-code", version: "1.2.3" } },
    });
  });

  test("a key present in both with no applicable relation is invalid-document on byte-inequality", () => {
    const unknownClass = mergeRequirements(
      { customKey: "a" },
      { customKey: "b" },
      { customKey: "addable" }, // addable's relation only applies when absent from the Task
    );
    expect(unknownClass).toEqual({ ok: false, category: "invalid-document", key: "customKey" });

    // an undeclared class is the same conservative default
    const noClass = mergeRequirements(
      { customKey: "a" },
      { customKey: "b" },
      {},
    );
    expect(noClass).toEqual({ ok: false, category: "invalid-document", key: "customKey" });
  });

  test("byte-equal values under an undeclared class still merge", () => {
    const ok = mergeRequirements(
      { customKey: "a" },
      { customKey: "a" },
      {},
    );
    expect(ok).toEqual({ ok: true, effective: { customKey: "a" } });
  });

  test("a Submission pinning key absent from a backend's capability inventory is not flagged here", () => {
    // mergeRequirements never consults a backend capability inventory — that check belongs to
    // the backend capability path (program §7.3); an unrecognized-by-this-backend key that is
    // structurally addable still merges successfully.
    const result = mergeRequirements(
      {},
      { loadout: { uri: "https://example.test/skill.tar", kind: "jinn.skill.v1" } },
      { loadout: "addable" },
    );
    expect(result.ok).toBe(true);
  });

  test("a Task-only requirement carries through as the effective value", () => {
    const result = mergeRequirements(
      { evidenceCapture: "always" },
      {},
      { evidenceCapture: "exact" },
    );
    expect(result).toEqual({ ok: true, effective: { evidenceCapture: "always" } });
  });
});
