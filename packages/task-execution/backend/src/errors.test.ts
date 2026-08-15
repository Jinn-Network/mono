import { describe, expect, test } from "vitest";
import { TaskExecutionError } from "./errors.js";

describe("TaskExecutionError", () => {
  test("defaults retryable=true for backend-unavailable (§13 retryable table)", () => {
    const error = new TaskExecutionError("backend-unavailable");
    expect(error.category).toBe("backend-unavailable");
    expect(error.retryable).toBe(true);
    expect(error.name).toBe("TaskExecutionError");
  });

  test("defaults retryable=false for invalid-document", () => {
    const error = new TaskExecutionError("invalid-document");
    expect(error.retryable).toBe(false);
  });

  test("an explicit retryable override wins over the category default", () => {
    const error = new TaskExecutionError("invalid-document", { retryable: true });
    expect(error.retryable).toBe(true);
  });

  test("annotations and detail round-trip", () => {
    const error = new TaskExecutionError("unsupported-requirement", {
      message: "harness pin not supported",
      detail: "harness=codex not in inventory",
      annotations: { "network.jinn.local-binding": { field: "harness" } },
    });
    expect(error.message).toBe("harness pin not supported");
    expect(error.detail).toBe("harness=codex not in inventory");
    expect(error.annotations).toEqual({ "network.jinn.local-binding": { field: "harness" } });
  });

  test("message defaults to the category when unset", () => {
    const error = new TaskExecutionError("attempt-not-found");
    expect(error.message).toBe("attempt-not-found");
  });
});
