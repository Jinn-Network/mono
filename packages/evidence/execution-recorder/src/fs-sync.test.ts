// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { fsyncBestEffort, isFsyncUnsupportedError } from "./fs-sync.js";

describe("fsyncBestEffort", () => {
  test("ignores Yarn PnP FileHandle.sync stubs", async () => {
    await expect(
      fsyncBestEffort({
        sync: async () => {
          throw Object.assign(new Error("Method not implemented."), {
            code: "ENOSYS",
          });
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("rethrows real fsync failures", async () => {
    const failure = new Error("disk full");
    await expect(
      fsyncBestEffort({
        sync: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  test("classifies unsupported sync errors", () => {
    expect(
      isFsyncUnsupportedError(
        Object.assign(new Error("Method not implemented."), {}),
      ),
    ).toBe(true);
    expect(isFsyncUnsupportedError(new Error("EIO"))).toBe(false);
  });
});
