// SPDX-License-Identifier: Apache-2.0

/**
 * The composed generation through the portable reader (bundle-capability-composition design §6;
 * issue #3403).
 *
 * `capability-lattice.test.ts` runs the member closure over generated path sets, and
 * `composed-manifest.test.ts` pins the vector's grammar at the manifest. This is the half neither
 * can supply: a real, fully signed bundle declaring a vector, taken through every check by the same
 * `verifyPublicBundle` a third party runs.
 *
 * The producer now emits the composed format by default (issue #3405). The bundle here is still
 * the conformance kit's published `/2` golden bundle, copied and converted to the composed bundle
 * the same facts produce under the empty vector -- the plain base graph, which is exactly the
 * closure `/2` describes -- so this file proves the reader independently of the producer. The
 * golden directory itself is never written to, and the first test proves it still verifies.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { buildPublicAssets } from "./assets.js";
import { BUNDLE_FORMAT, PUBLIC_BUNDLE_VERIFICATION_CHECKS } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT, buildBundleManifest } from "./manifest.js";
import { summarizeVerificationOutcome } from "./outcome.js";
import { COMPOSED_CLAIM_PACKAGE_SCHEMA_ID } from "./profile/claim.js";
import { readerInstructions } from "./capabilities.js";
import { GOLDEN_BUNDLE_DIR, goldenInput } from "./testing/golden-asset-input.js";
import { verifyPublicBundle } from "./verify.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

function memberPaths(bundleDir: string): string[] {
  return (json(bundleDir, "bundle.json")["files"] as { path: string }[]).map((file) => file.path);
}

/** Re-seals the manifest over the tree as it now stands, so what the reader refuses is the
 * semantic inconsistency and not a stale digest it would have caught anyway. */
function reseal(bundleDir: string, capabilities: readonly string[], paths = memberPaths(bundleDir)): void {
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, paths, { format: BUNDLE_V10_FORMAT, capabilities }).bytes,
  );
}

/**
 * A detached copy of the golden bundle, converted to the composed bundle the same facts produce
 * under the empty vector. Three edits, in the order a producer makes them: the claim becomes the
 * composed generation's claim package and pins the reader line the vector derives, every
 * presentation asset is re-rendered for the composed format, and the manifest is re-sealed with the
 * vector. No record moves.
 */
async function composedGolden(options: { readonly claimSchema?: string } = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "composed-verify-"));
  roots.push(root);
  const bundleDir = join(root, "bundle");
  cpSync(GOLDEN_BUNDLE_DIR, bundleDir, { recursive: true });

  const claim = json(bundleDir, "claim-package.json");
  claim["claimSchema"] = options.claimSchema ?? COMPOSED_CLAIM_PACKAGE_SCHEMA_ID;
  claim["verification"] = { ...claim["verification"], ...readerInstructions([]) };
  writeFileSync(join(bundleDir, "claim-package.json"), canonicalJsonBytes(claim as never));

  const assets = buildPublicAssets({ ...(await goldenInput(BUNDLE_V10_FORMAT)), claim: claim as never });
  for (const [path, bytes] of Object.entries(assets)) writeFileSync(join(bundleDir, path), bytes);
  reseal(bundleDir, []);
  return bundleDir;
}

async function refusal(bundleDir: string): Promise<{ path: string; message: string }> {
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    const issue = (cause as { readonly issues?: readonly { path?: string; message?: string }[] }).issues?.[0];
    return { path: issue?.path ?? "", message: issue?.message ?? String(cause) };
  }
  return { path: "NOT REFUSED", message: "NOT REFUSED" };
}

describe("an old-format bundle is untouched", () => {
  test("the published /2 golden bundle still verifies, on the legacy path, with its six checks", async () => {
    const verified = await verifyPublicBundle(GOLDEN_BUNDLE_DIR);
    expect(verified.format).toBe(BUNDLE_FORMAT);
    expect(verified.checks).toEqual(PUBLIC_BUNDLE_VERIFICATION_CHECKS);
    // A legacy result states no vector: capability is still encoded in its number.
    expect("capabilities" in verified).toBe(false);
  });
});

describe("the composed base graph", () => {
  test("verifies under the empty vector, with exactly the base checks", async () => {
    const bundleDir = await composedGolden();
    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(verified.capabilities).toEqual([]);
    expect(verified.checks).toEqual(PUBLIC_BUNDLE_VERIFICATION_CHECKS);
    expect(verified.anchors).toBeUndefined();
    expect(verified.qualification).toBeUndefined();

    // The denominator a reader is shown is derived from the vector, never inherited from a cell.
    const outcome = summarizeVerificationOutcome(verified);
    expect(outcome.total).toBe(6);
    expect(outcome.passed).toBe(6);
  });

  test("a composed bundle carrying a pre-composition claim id is refused on the field that disagrees", async () => {
    // claim-package/1 is a well-formed claim, so the admission schema accepts it. What refuses it
    // is the rebuild: the claim id is derived from the format the MANIFEST declares.
    const bundleDir = await composedGolden({ claimSchema: "benchmark-product.claim-package/1" });
    expect(await refusal(bundleDir)).toEqual({
      path: "claim-consistency",
      message: expect.stringContaining("claimSchema"),
    });
  });
});

describe("declaration is authoritative", () => {
  test("an unknown capability token refuses the bundle whole, by name", async () => {
    const bundleDir = await composedGolden();
    const manifest = json(bundleDir, "bundle.json");
    manifest["capabilities"] = ["zz-unknown"];
    writeFileSync(join(bundleDir, "bundle.json"), canonicalJsonBytes(manifest as never));
    expect(await refusal(bundleDir)).toEqual({
      path: "bundle.manifest.capabilities",
      message: expect.stringContaining('"zz-unknown"'),
    });
  });

  test("members without declaration: a planted anchor is a non-allowlisted file", async () => {
    const bundleDir = await composedGolden();
    const planted = `anchors/${"a".repeat(64)}.bin`;
    cpSync(join(bundleDir, "share.txt"), join(bundleDir, planted));
    reseal(bundleDir, [], [...memberPaths(bundleDir), planted]);
    expect(await refusal(bundleDir)).toEqual({
      path: planted,
      message: expect.stringContaining("non-allowlisted"),
    });
  });

  test("members without declaration: a planted qualification document is a non-allowlisted file", async () => {
    const bundleDir = await composedGolden();
    cpSync(join(bundleDir, "share.txt"), join(bundleDir, "qualification.json"));
    reseal(bundleDir, [], [...memberPaths(bundleDir), "qualification.json"]);
    expect(await refusal(bundleDir)).toEqual({
      path: "qualification.json",
      message: expect.stringContaining("non-allowlisted"),
    });
  });

  test("declared without members: binary-qualification with no qualification document is a missing member", async () => {
    const bundleDir = await composedGolden();
    reseal(bundleDir, ["binary-qualification"]);
    expect(await refusal(bundleDir)).toEqual({
      path: "qualification.json",
      message: expect.stringContaining("is missing"),
    });
  });

  test("declared without members: anchoring over an unanchored claim is refused at the section", async () => {
    // `anchoring` may carry no member, so the member closure has nothing to miss. What cannot be
    // absent is its claim section: declared means present, and the rebuild supplies the section the
    // declaration promises, so the stored claim differs exactly there.
    const bundleDir = await composedGolden();
    reseal(bundleDir, ["anchoring"]);
    expect(await refusal(bundleDir)).toEqual({
      path: "claim-consistency",
      message: expect.stringContaining("anchors"),
    });
  });
});
