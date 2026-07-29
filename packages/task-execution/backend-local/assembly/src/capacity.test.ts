import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireStateRootWriter, CapacityGate } from "./capacity.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jinn-local-capacity-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CapacityGate", () => {
  test("never queues and reports backend-unavailable at the configured ceiling", () => {
    const gate = new CapacityGate(1);
    expect(gate.tryAcquire("attempt-1")).toEqual({ acquired: true });
    expect(gate.tryAcquire("attempt-2")).toMatchObject({
      acquired: false,
      error: { category: "backend-unavailable" },
    });
    gate.release("attempt-1");
    expect(gate.tryAcquire("attempt-2")).toEqual({ acquired: true });
  });
});

describe("one live writer per state root", () => {
  test("a second instance is unavailable until the first releases its lifetime lock", async () => {
    const stateRoot = await root();
    const first = acquireStateRootWriter(stateRoot);
    const second = acquireStateRootWriter(stateRoot);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error("unreachable");
    expect(second.error.category).toBe("backend-unavailable");

    if (first.acquired) first.release();
    const replacement = acquireStateRootWriter(stateRoot);
    expect(replacement.acquired).toBe(true);
    if (replacement.acquired) replacement.release();
  });
});
