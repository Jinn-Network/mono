// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url).pathname;

// "deterministic-process" is a frozen family identity, not a claim.
const UNBOUNDED_DETERMINISM = /\bdeterministic\b(?!-process)/gi;
const UNBOUNDED_VERIFIED = /\bverified\b/gi;

// A README sentence may use the words only alongside what bounds them.
const QUALIFIERS = [
  "attestation",
  "attestations",
  "attested",
  "trust policy",
  "under controls",
  "consecutive",
  "bounded",
  "never claims",
  "does not",
];

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("bounded claims", () => {
  it("uses neither word unqualified anywhere in source", async () => {
    for (const path of await sourceFiles(join(packageRoot, "src"))) {
      const text = await readFile(path, "utf8");
      expect(text.match(UNBOUNDED_DETERMINISM), `${path} claims determinism`).toBeNull();
      expect(text.match(UNBOUNDED_VERIFIED), `${path} claims verification`).toBeNull();
    }
  });

  it("uses neither word in the published package description", async () => {
    // The description ships to a registry page, where it is read with none of the README's
    // context around it — so it gets the source rule, not the README's qualified one.
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { description?: string };
    const description = manifest.description ?? "";
    expect(description.match(UNBOUNDED_DETERMINISM), "description claims determinism").toBeNull();
    expect(description.match(UNBOUNDED_VERIFIED), "description claims verification").toBeNull();
  });

  it("qualifies every use in the README", async () => {
    const readme = await readFile(join(packageRoot, "README.md"), "utf8");
    for (const line of readme.split("\n")) {
      const uses = UNBOUNDED_DETERMINISM.test(line) || UNBOUNDED_VERIFIED.test(line);
      UNBOUNDED_DETERMINISM.lastIndex = 0;
      UNBOUNDED_VERIFIED.lastIndex = 0;
      if (!uses) continue;
      expect(
        QUALIFIERS.some((qualifier) => line.toLowerCase().includes(qualifier)),
        `unqualified claim: ${line}`,
      ).toBe(true);
    }
  });
});
