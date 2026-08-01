// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Absolutes this layer may never use about its own output. The claim is "K fresh
// materializations under blackhole produced identical canonical observations"; anything
// stronger is over-claiming (design §5.3 bounded claims, program contract 7).
const FORBIDDEN = [
  /\bdeterministic(?:ally)?\b/iu,
  /\bnon-?deterministic\b/iu,
  /\bguarantee[sd]?\b/iu,
  /\btrustless\b/iu,
  /\bauthenticated against\b/iu,
  /\bmainnet[- ]equivalent\b/iu,
  /\bfully reproducible\b/iu,
];

// "verified" and "proven" are legitimate in bounded form -- EIP-1186 proofs prove a subset
// against a declared root, and step 1 verifies a digest. A line earns them only by naming what
// bounds the claim.
const BOUNDED_WORDS = /\b(verified|verifies|verifiable|proven|proves)\b/iu;
const BOUNDING = new RegExp([
  "declared", "subset", "slice", "attestation", "digest", "proof-covered", "EIP-1186",
  "bounded", "never", "MUST NOT", "no claim", "does not", "cannot", "K fresh",
].join("|"), "iu");

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`);
}

describe("bounded claims", () => {
  it("no shipped file uses a forbidden absolute", async () => {
    // Source, the scripts that generate and smoke the published artifacts, and the fixture
    // corpus -- every file a third party reads. This file is the only exception: it must
    // spell the banned words to ban them.
    const paths = [
      ...await filesUnder(SOURCE_ROOT),
      ...await filesUnder(`${PACKAGE_ROOT}scripts`),
      ...await filesUnder(`${PACKAGE_ROOT}fixtures`),
    ].filter((path) => !path.endsWith("bounded-claims.test.ts"));
    expect(paths.some((path) => path.includes("/scripts/"))).toBe(true);
    expect(paths.some((path) => path.includes("/fixtures/"))).toBe(true);
    for (const path of paths) {
      const text = await readFile(path, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(text), `${path} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("every use of verified/proven names what bounds it", async () => {
    const paths = (await filesUnder(SOURCE_ROOT))
      .filter((path) => !path.endsWith("bounded-claims.test.ts"));
    const findings: string[] = [];
    for (const path of paths) {
      const text = await readFile(path, "utf8");
      text.split("\n").forEach((line, index) => {
        if (BOUNDED_WORDS.test(line) && !BOUNDING.test(line)) {
          findings.push(`${path}:${index + 1} -> ${line.trim()}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });

  it("the README and the caveats note state the bound explicitly", async () => {
    const readme = await readFile(`${PACKAGE_ROOT}README.md`, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(readme), `README matches ${String(pattern)}`).toBe(false);
    }
    expect(readme).toContain("K fresh materializations under blackhole produced identical canonical observations");
    expect(readme).toContain("It does not speak to");
    expect(readme).toContain("no fork backend");
    const caveats = await readFile(`${PACKAGE_ROOT}ANVIL-CAVEATS.md`, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(caveats), `ANVIL-CAVEATS matches ${String(pattern)}`).toBe(false);
    }
  });
});
