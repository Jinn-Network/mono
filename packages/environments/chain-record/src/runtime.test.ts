import { describe, expect, test } from "vitest";

import { ChainRuntimeSchema } from "./runtime.js";

const MANIFEST = `sha256:${"1".repeat(64)}`;
const INDEX = `sha256:${"2".repeat(64)}`;

const runtime = () => ({
  family: "anvil",
  version: "1.3.7",
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `registry.example.test/chain/anvil@${MANIFEST}`,
    indexDigest: INDEX,
  },
  binary: { name: "anvil", digest: `sha256:${"3".repeat(64)}`, version: "1.3.7" },
  evm: {
    hardfork: "cancun",
    sandboxChainId: 1,
    nonDefaultSettings: { "disable-block-gas-limit": false, "memory-limit": "33554432" },
  },
  launch: {
    options: { "no-mining": true, "steps-tracing": false, "order": "fifo" },
    commandEvidence: "anvil --no-mining --order fifo",
  },
});

describe("runtime block (§4.3)", () => {
  test("accepts a fully pinned anvil runtime", () => {
    expect(ChainRuntimeSchema.safeParse(runtime()).success).toBe(true);
  });

  test("refuses a version that is not exact", () => {
    expect(ChainRuntimeSchema.safeParse({ ...runtime(), version: "latest" }).success).toBe(false);
    expect(ChainRuntimeSchema.safeParse({ ...runtime(), version: "^1.3.7" }).success).toBe(false);
  });

  test("refuses an unknown runtime family: `anvil` is the only v1 adapter", () => {
    expect(ChainRuntimeSchema.safeParse({ ...runtime(), family: "hardhat" }).success).toBe(false);
  });

  test("refuses an index digest presented as the platform manifest digest", () => {
    const document = runtime();
    document.image.indexDigest = document.image.manifestDigest;
    expect(ChainRuntimeSchema.safeParse(document).success).toBe(false);
  });

  test("refuses a bare-hex manifest digest: record bodies carry the sha256: prefix", () => {
    const document = runtime();
    document.image.manifestDigest = "1".repeat(64);
    delete (document.image as { reference?: string }).reference;
    expect(ChainRuntimeSchema.safeParse(document).success).toBe(false);
  });

  test("refuses a pull reference that does not pin this record's manifest digest", () => {
    const document = runtime();
    document.image.reference = "registry.example.test/chain/anvil:latest";
    expect(ChainRuntimeSchema.safeParse(document).success).toBe(false);
  });

  test("refuses an extra key: the launch configuration is closed, not extensible", () => {
    expect(
      ChainRuntimeSchema.safeParse({ ...runtime(), launchCommand: "anvil --fork-url ..." }).success,
    ).toBe(false);
  });

  test("the sandbox chain id is a runtime fact, and may be 1 without conferring authority", () => {
    const parsed = ChainRuntimeSchema.parse(runtime());
    expect(parsed.evm.sandboxChainId).toBe(1);
  });
});
