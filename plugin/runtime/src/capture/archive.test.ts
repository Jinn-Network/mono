import { describe, expect, test, vi } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { ARCHIVE_BUSY_ERROR_CODE, withCaptureArchive } from "./archive.js";

class FakeLocalRuntimeError extends Error {
  override readonly name = "LocalEvidenceRuntimeError";
  constructor(readonly code: string) {
    super(code);
  }
}

const fakeRuntime = () => {
  const closed = { count: 0 };
  return {
    handle: { close: async () => void (closed.count += 1) } as never,
    closed,
  };
};

describe("withCaptureArchive", () => {
  test("opens, runs, and closes exactly once", async () => {
    const { handle, closed } = fakeRuntime();
    const open = vi.fn(async () => handle);
    const value = await withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 1000, open }, async () => 42);
    expect(value).toBe(42);
    expect(open).toHaveBeenCalledTimes(1);
    expect(closed.count).toBe(1);
  });

  test("closes even when the operation throws, and surfaces the original failure", async () => {
    const { handle, closed } = fakeRuntime();
    const boom = new Error("operation failed");
    await expect(
      withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 1000, open: async () => handle }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(closed.count).toBe(1);
  });

  test("a close failure never masks a successful result", async () => {
    const handle = { close: async () => { throw new Error("close failed"); } } as never;
    await expect(
      withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 1000, open: async () => handle }, async () => "ok"),
    ).resolves.toBe("ok");
  });

  test("retries ROOT_IN_USE with backoff and succeeds when the holder releases", async () => {
    const { handle } = fakeRuntime();
    const delays: number[] = [];
    let attempt = 0;
    const value = await withCaptureArchive(
      {
        rootDir: "/a",
        busyTimeoutMs: 10_000,
        now: () => attempt * 25,
        sleep: async (ms) => void delays.push(ms),
        open: async () => {
          attempt += 1;
          if (attempt < 4) throw new FakeLocalRuntimeError("ROOT_IN_USE");
          return handle;
        },
      },
      async () => "sealed",
    );
    expect(value).toBe("sealed");
    expect(delays).toEqual([25, 50, 100]);
  });

  test("gives up as capture-archive-busy once the budget is spent", async () => {
    let clock = 0;
    const error = await withCaptureArchive(
      {
        rootDir: "/a",
        busyTimeoutMs: 200,
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        open: async () => {
          throw new FakeLocalRuntimeError("ROOT_IN_USE");
        },
      },
      async () => "unreachable",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PluginRuntimeError);
    expect((error as PluginRuntimeError).code).toBe(ARCHIVE_BUSY_ERROR_CODE);
    expect((error as PluginRuntimeError).message).toContain("/a");
  });

  test("does not retry a runtime error that is not ROOT_IN_USE", async () => {
    const open = vi.fn(async () => {
      throw new FakeLocalRuntimeError("RUNTIME_CORRUPT");
    });
    await expect(
      withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 10_000, open }, async () => "x"),
    ).rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("stops retrying when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withCaptureArchive(
        {
          rootDir: "/a",
          busyTimeoutMs: 10_000,
          signal: controller.signal,
          open: async () => {
            throw new FakeLocalRuntimeError("ROOT_IN_USE");
          },
        },
        async () => "x",
      ),
    ).rejects.toBeInstanceOf(PluginRuntimeError);
  });
});
