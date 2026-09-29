// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #2981: reader-facing renderings print a Jinn protocol identifier whole only when the spec
 * origin serves it, and never dump one a reader cannot follow. Frozen formats stay byte-identical;
 * `/10` is the presentation generation that may change.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { resolvesAtSpecOrigin } from "./identifier-presentation.js";
import { BUNDLE_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT } from "./manifest.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const INTERNAL_NAMESPACE = /jinn\.network|jinn\.benchmarking/;
const JINN_URL = /https?:\/\/(?:[^/?#]*\.)?jinn\.(?:network|benchmarking)/u;
const NOT_HOSTED = /not hosted/iu;

/** The golden facts with every arm's pinning naming `profile`, as a pinning dump would carry it. */
function withPinnedProfile(base: PublicAssetInput, profile: string) {
  return {
    ...base,
    claim: {
      ...base.claim,
      scope: {
        ...base.claim.scope,
        arms: base.claim.scope.arms.map((arm) => ({
          ...arm,
          pinning: { ...arm.pinning, profile },
        })),
      },
    },
  };
}

function readerAssets(input: PublicAssetInput): { readonly html: string; readonly readme: string } {
  const assets = buildPublicAssets(input);
  return { html: decoder.decode(assets["index.html"]!), readme: decoder.decode(assets["README.md"]!) };
}

describe("origin-free reader presentation (#2981)", () => {
  test("already-published formats still print the sealed method identifier", async () => {
    const html = decoder.decode(buildPublicAssets(await goldenInput(BUNDLE_FORMAT))["index.html"]!);
    const readme = decoder.decode(buildPublicAssets(await goldenInput(BUNDLE_FORMAT))["README.md"]!);
    expect(html).toContain("jinn.benchmarking.method/wilson");
    expect(readme).toContain("jinn.benchmarking.method/wilson");
  });

  test("/10 HTML and README print none of the golden bundle's unresolvable Jinn identifiers", async () => {
    const assets = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    for (const name of ["index.html", "README.md"] as const) {
      const text = decoder.decode(assets[name]!);
      expect(text, name).not.toMatch(INTERNAL_NAMESPACE);
      expect(text, name).not.toMatch(JINN_URL);
      expect(text, name).not.toMatch(NOT_HOSTED);
    }
  });

  test("/10 still names the method by its path, so a reader can match the sealed record", async () => {
    const html = decoder.decode(buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT))["index.html"]!);
    expect(html).toContain("method/wilson @ 1");
    expect(html).not.toContain("jinn.benchmarking.method/wilson");
  });

  test("/10 keeps a served protocol URL from pinning JSON whole, so a reader can follow it", async () => {
    const served = "https://spec.jinn.network/task-profiles/binary-judgment/2.0";
    expect(resolvesAtSpecOrigin(served)).toBe(true);
    const poisoned = withPinnedProfile(await goldenInput(BUNDLE_FORMAT), served);
    const published = readerAssets(poisoned);
    const composed = readerAssets({ ...poisoned, format: BUNDLE_V10_FORMAT });
    expect(published.html).toContain(served);
    expect(composed.html).toContain(served);
    // The README spells the scheme `https\://` (markdown escaping); the served identifier is still
    // printed whole, not cut down to its path.
    expect(composed.readme).toContain("https\\://spec.jinn.network/task-profiles/binary-judgment/2.0");
  });

  test("/10 aliases an unserved protocol URL from pinning JSON; /2 keeps the raw identifier", async () => {
    const unserved = "https://spec.jinn.network/task-profiles/binary-judgment/1.0";
    expect(resolvesAtSpecOrigin(unserved)).toBe(false);
    const poisoned = withPinnedProfile(await goldenInput(BUNDLE_FORMAT), unserved);
    const published = readerAssets(poisoned);
    const composed = readerAssets({ ...poisoned, format: BUNDLE_V10_FORMAT });
    expect(published.html).toContain(unserved);
    for (const text of [composed.html, composed.readme]) {
      expect(text).not.toContain("spec.jinn.network");
      expect(text).toContain("task-profiles/binary-judgment/1.0");
    }
  });
});

describe("EXTERNAL-VERIFICATION Identifier note (#2981)", () => {
  test("says which identifiers resolve and which are names only", () => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../EXTERNAL-VERIFICATION.md");
    const body = readFileSync(path, "utf8");
    // Unwrapped: the hard wrap is cosmetic, so a re-flow must not break a phrase match.
    const note = body.slice(body.indexOf("## Identifier note")).replace(/\s+/gu, " ");
    expect(note.length).toBeGreaterThan(80);
    expect(note).not.toMatch(NOT_HOSTED);
    expect(note).toMatch(/names, not addresses/u);
    const named = note.match(/https:\/\/spec\.jinn\.network\/[^\s`]*/gu) ?? [];
    expect(named).toContain("https://spec.jinn.network/protocols/benchmarking/v1/schemas/");
    expect(named.filter(resolvesAtSpecOrigin)).toEqual([
      "https://spec.jinn.network/task-profiles/binary-judgment/2.0",
    ]);
  });
});
