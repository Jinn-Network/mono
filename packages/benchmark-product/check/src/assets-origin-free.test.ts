// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #2981: reader-facing renderings must not name an unhosted origin or dump internal
 * protocol identifiers. Frozen formats stay byte-identical; `/10` is the presentation generation
 * that may change.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildPublicAssets } from "./assets.js";
import { BUNDLE_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT } from "./manifest.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const INTERNAL_NAMESPACE = /jinn\.network|jinn\.benchmarking/;
const UNHOSTED_ORIGIN = /https?:\/\/(?:[^/?#]*\.)?jinn\.(?:network|benchmarking)/u;
const NOT_HOSTED = /not hosted/iu;

describe("origin-free reader presentation (#2981)", () => {
  test("already-published formats still print the sealed method identifier", async () => {
    const html = decoder.decode(buildPublicAssets(await goldenInput(BUNDLE_FORMAT))["index.html"]!);
    const readme = decoder.decode(buildPublicAssets(await goldenInput(BUNDLE_FORMAT))["README.md"]!);
    expect(html).toContain("jinn.benchmarking.method/wilson");
    expect(readme).toContain("jinn.benchmarking.method/wilson");
  });

  test("/10 HTML and README name no internal protocol namespace and no unhosted origin", async () => {
    const assets = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    for (const name of ["index.html", "README.md"] as const) {
      const text = decoder.decode(assets[name]!);
      expect(text, name).not.toMatch(INTERNAL_NAMESPACE);
      expect(text, name).not.toMatch(UNHOSTED_ORIGIN);
      expect(text, name).not.toMatch(NOT_HOSTED);
    }
  });

  test("/10 still names the method by its path, so a reader can match the sealed record", async () => {
    const html = decoder.decode(buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT))["index.html"]!);
    expect(html).toContain("method/wilson @ 1");
    expect(html).not.toContain("jinn.benchmarking.method/wilson");
  });

  test("/10 aliases a protocol URL dumped from pinning JSON; /2 keeps the raw identifier", async () => {
    const origin = "https://spec.jinn.network/task-profiles/binary-judgment/2.0";
    const base = await goldenInput(BUNDLE_FORMAT);
    const poisoned = {
      ...base,
      claim: {
        ...base.claim,
        scope: {
          ...base.claim.scope,
          arms: base.claim.scope.arms.map((arm) => ({
            ...arm,
            pinning: { ...arm.pinning, profile: origin },
          })),
        },
      },
    };
    const published = decoder.decode(buildPublicAssets(poisoned)["index.html"]!);
    const composed = decoder.decode(
      buildPublicAssets({ ...poisoned, format: BUNDLE_V10_FORMAT })["index.html"]!,
    );
    expect(published).toContain(origin);
    expect(composed).not.toContain("spec.jinn.network");
    expect(composed).toContain("task-profiles/binary-judgment/2.0");
  });
});

describe("EXTERNAL-VERIFICATION Identifier note (#2981)", () => {
  test("does not name an unhosted origin or invite a fetch", () => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../EXTERNAL-VERIFICATION.md");
    const body = readFileSync(path, "utf8");
    const note = body.slice(body.indexOf("## Identifier note"));
    expect(note.length).toBeGreaterThan(80);
    expect(note).not.toMatch(NOT_HOSTED);
    expect(note).not.toMatch(UNHOSTED_ORIGIN);
    expect(note).toMatch(/names, not addresses/u);
  });
});
