// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

// The ten Foundry/Hardhat default accounts derived from the well-known "test test … junk"
// mnemonic. Design §8: because a sandbox may report chain id 1 for contract compatibility,
// every EIP-155 transaction in a published solution script is a structurally valid mainnet
// transaction from that fixture address, permanently. It is inert only because the address
// holds nothing -- inert by economics, not by cryptography. A fixture address that someone
// might fund turns every published script into a replayable mainnet transaction from it.
const WELL_KNOWN = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
];

describe("fixture keys", () => {
  it("uses no well-known development address anywhere it ships", async () => {
    const roots = ["src", "fixtures", "scripts"];
    const paths = [];
    for (const root of roots) {
      const entries = await readdir(`${PACKAGE_ROOT}${root}`, {
        recursive: true, withFileTypes: true,
      });
      paths.push(...entries.filter((entry) => entry.isFile())
        .map((entry) => `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`));
    }
    for (const path of paths.filter((one) => !one.endsWith("fixture-keys.test.ts"))) {
      const text = (await readFile(path, "utf8")).toLowerCase();
      for (const address of WELL_KNOWN) {
        expect(text.includes(address), `${path} carries ${address}`).toBe(false);
      }
      expect(/test\s+test\s+test\s+test/iu.test(text), `${path} carries a dev mnemonic`)
        .toBe(false);
    }
  });

  it("never carries private key material", async () => {
    const entries = await readdir(`${PACKAGE_ROOT}src`, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((one) => one.isFile())) {
      const text = await readFile(
        `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`, "utf8",
      );
      // A 32-byte hex literal in this package would be a key, a digest, or a storage word;
      // digests and words carry their own prefixes, so a bare one is a finding.
      expect(/(?<![0-9a-fx:])[0-9a-f]{64}(?![0-9a-f])/u.test(text.replace(/["'`]/gu, "")))
        .toBe(false);
    }
  });
});
