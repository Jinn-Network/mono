// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it, vi } from "vitest";

import { createAnchorResolver } from "./anchors.js";

const DIGEST = ("sha256:" + "a".repeat(64)) as Sha256Digest;

describe("createAnchorResolver", () => {
  it("resolves an anchor observation and caches it forever", async () => {
    const lookupAnchor = vi.fn(async () => ({ digest: DIGEST, anchorTime: "2026-01-01T00:00:00.000Z" }));
    const resolver = createAnchorResolver({ client: { lookupAnchor } });

    await expect(resolver.lookupAnchor(DIGEST)).resolves.toEqual({
      digest: DIGEST,
      anchorTime: "2026-01-01T00:00:00.000Z",
    });
    await expect(resolver.lookupAnchor(DIGEST)).resolves.toEqual({
      digest: DIGEST,
      anchorTime: "2026-01-01T00:00:00.000Z",
    });
    expect(lookupAnchor).toHaveBeenCalledTimes(1);
  });

  it("does not cache a not-yet-observed anchor (the surface may still receive it later)", async () => {
    const lookupAnchor = vi.fn(async () => null);
    const resolver = createAnchorResolver({ client: { lookupAnchor } });

    await expect(resolver.lookupAnchor(DIGEST)).resolves.toBeNull();
    await expect(resolver.lookupAnchor(DIGEST)).resolves.toBeNull();
    expect(lookupAnchor).toHaveBeenCalledTimes(2);
  });
});
