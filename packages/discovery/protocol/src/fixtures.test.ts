import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { sealJson } from "./sealing.js";
import { parseAnnouncementEntry } from "./entry.js";
import { parseSourceHead } from "./head.js";

const fixtureRoot = new URL("../fixtures/", import.meta.url);

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, fixtureRoot), "utf8"));
}

const expectedDigests: Record<string, string> = JSON.parse(
  await readFile(new URL("expected-digests.json", fixtureRoot), "utf8"),
);

function expectPinnedDigest(name: string, bytes: Uint8Array, digest: string) {
  const expected = expectedDigests[name];
  if (expected === undefined) {
    throw new Error(
      `No pinned digest for "${name}" yet -- actual digest: ${digest}\n`
        + "Paste this into fixtures/expected-digests.json and re-run.",
    );
  }
  expect(digest).toBe(expected);
  // Sanity: the digest is over the exact sealed bytes, never re-derived.
  expect(new TextDecoder().decode(bytes).length).toBeGreaterThan(0);
}

describe("golden fixture sealing (pinned digests)", () => {
  it("seals the golden genesis entry to its pinned digest and parses structurally", async () => {
    const raw = await fixture("golden-entries/genesis.json");
    const { bytes, digest } = sealJson(raw);
    expectPinnedDigest("genesis", bytes, digest);
    const entry = parseAnnouncementEntry(raw);
    expect(entry.sequence).toBe("0000000000000001");
    expect(entry.previous).toBeNull();
  });

  it("seals a key-shuffled copy of the genesis entry to the identical digest (JCS key-order insensitivity)", async () => {
    const canonical = await fixture("golden-entries/genesis.json");
    const shuffled = await fixture("golden-entries/genesis-shuffled-keys.json");
    const canonicalSealed = sealJson(canonical);
    const shuffledSealed = sealJson(shuffled);
    expect(shuffledSealed.digest).toBe(canonicalSealed.digest);
    expectPinnedDigest("genesis-shuffled-keys", shuffledSealed.bytes, shuffledSealed.digest);
  });

  it("seals the golden available+withdrawn entry to its pinned digest and parses structurally", async () => {
    const raw = await fixture("golden-entries/available-withdrawn.json");
    const { bytes, digest } = sealJson(raw);
    expectPinnedDigest("available-withdrawn", bytes, digest);
    const entry = parseAnnouncementEntry(raw);
    expect(entry.announcements).toHaveLength(2);
  });

  it("seals the golden head to its pinned digest and parses structurally", async () => {
    const raw = await fixture("golden-heads/head.json");
    const { bytes, digest } = sealJson(raw);
    expectPinnedDigest("head", bytes, digest);
    const head = parseSourceHead(raw);
    expect(head.sequence).toBe("0000000000000002");
  });
});
