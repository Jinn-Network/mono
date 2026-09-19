// SPDX-License-Identifier: Apache-2.0

/**
 * The composed generation's manifest (bundle-capability-composition design §3.2; issue #3403).
 *
 * `benchmark-product-public-bundle/10`'s `bundle.json` is `/2`'s -- `format` and `files` -- plus one
 * required member, `capabilities`. Each rule on that member is pinned here at the first place a
 * reader meets it, `verifyBundleSnapshot`, because that is where an unknown shape has to be refused
 * whole: before a single member is read, and whichever later surface the caller was heading for.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BUNDLE_FORMAT, BUNDLE_V6_FORMAT } from "./legacy-closures.js";
import { expectRefusal } from "./testing/expect-refusal.js";
import { BUNDLE_V10_FORMAT, BundleManifestSchema, buildBundleManifest, verifyBundleSnapshot } from "./manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MEMBER = "static-bundle.json";
const MEMBER_BYTES = new TextEncoder().encode("{}");
const MEMBER_ENTRY = {
  path: MEMBER,
  sha256: createHash("sha256").update(MEMBER_BYTES).digest("hex"),
  bytes: MEMBER_BYTES.length,
};

/** A one-member bundle directory whose `bundle.json` is exactly `manifest`, canonically encoded. */
function bundleWith(manifest: unknown, options: { readonly omitMember?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "composed-manifest-"));
  roots.push(root);
  if (options.omitMember !== true) {
    mkdirSync(dirname(join(root, MEMBER)), { recursive: true });
    writeFileSync(join(root, MEMBER), MEMBER_BYTES);
  }
  writeFileSync(join(root, "bundle.json"), canonicalJsonBytes(manifest as never));
  return root;
}

describe("the composed manifest schema", () => {
  test("admits the vector, including the empty one, spelled rather than omitted", () => {
    for (const capabilities of [[], ["anchoring"], ["anchoring", "binary-qualification"]]) {
      const root = bundleWith({ format: BUNDLE_V10_FORMAT, capabilities, files: [MEMBER_ENTRY] });
      const snapshot = verifyBundleSnapshot(root);
      expect(snapshot.manifest).toEqual({ format: BUNDLE_V10_FORMAT, capabilities, files: [MEMBER_ENTRY] });
    }
  });

  test("a /10 manifest with no vector is refused: no capabilities is a statement, not an absence", () => {
    const refusal = expectRefusal(() => verifyBundleSnapshot(bundleWith({ format: BUNDLE_V10_FORMAT, files: [MEMBER_ENTRY] })));
    expect(refusal.issues[0]).toEqual(expect.objectContaining({ path: "bundle.json" }));
    expect(refusal.issues[0]!.message).toContain("manifest schema");
  });

  test("the composed object is closed: an unknown top-level member is refused", () => {
    const manifest = { format: BUNDLE_V10_FORMAT, capabilities: [], files: [MEMBER_ENTRY], profile: "x" };
    expect(BundleManifestSchema.safeParse(manifest).success).toBe(false);
    expect(expectRefusal(() => verifyBundleSnapshot(bundleWith(manifest))).issues[0]!.message).toContain("manifest schema");
  });

  test("a legacy format cannot carry a vector", () => {
    // The legacy object is open, so the member is stripped at parse -- and the canonical re-encoding
    // then differs from the bytes on disk. No pre-composition bundle grows a vector by relabeling.
    for (const format of [BUNDLE_FORMAT, BUNDLE_V6_FORMAT]) {
      const refusal = expectRefusal(() =>
        verifyBundleSnapshot(bundleWith({ format, capabilities: ["anchoring"], files: [MEMBER_ENTRY] })));
      expect(refusal.issues[0]!.message, format).toContain("canonical manifest encoding");
    }
  });

  test("a misordered, duplicated, or non-kebab vector is a different manifest, and is refused", () => {
    for (const capabilities of [["binary-qualification", "anchoring"], ["anchoring", "anchoring"], ["Anchoring"], "anchoring"]) {
      const refusal = expectRefusal(() =>
        verifyBundleSnapshot(bundleWith({ format: BUNDLE_V10_FORMAT, capabilities, files: [MEMBER_ENTRY] })));
      expect(refusal.issues[0]!.message, JSON.stringify(capabilities)).toContain("manifest schema");
    }
  });
});

describe("must-understand resolution at the manifest", () => {
  test("an unknown token refuses the bundle whole, by name, before any member is read", () => {
    // The listed member does not exist on disk. A reader that reached the file list first would
    // refuse for the missing member; refusing for the token proves resolution ran before it.
    const root = bundleWith(
      { format: BUNDLE_V10_FORMAT, capabilities: ["anchoring", "zz-unknown"], files: [MEMBER_ENTRY] },
      { omitMember: true },
    );
    const refusal = expectRefusal(() => verifyBundleSnapshot(root));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
    expect(refusal.issues[0]!.message).toContain('"zz-unknown"');
  });

  test("an unsatisfiable vector is refused the same way", () => {
    const root = bundleWith(
      { format: BUNDLE_V10_FORMAT, capabilities: ["disclosure-specification"], files: [MEMBER_ENTRY] },
      { omitMember: true },
    );
    const refusal = expectRefusal(() => verifyBundleSnapshot(root));
    expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
    expect(refusal.issues[0]!.message).toContain('requires "binary-qualification"');
  });
});

describe("building a composed manifest", () => {
  test("the vector is sealed into the identity: two vectors over the same files are two bundles", () => {
    const root = bundleWith({ format: BUNDLE_FORMAT, files: [MEMBER_ENTRY] });
    const bare = buildBundleManifest(root, [MEMBER], { format: BUNDLE_V10_FORMAT, capabilities: [] });
    const anchored = buildBundleManifest(root, [MEMBER], { format: BUNDLE_V10_FORMAT, capabilities: ["anchoring"] });
    expect(bare.manifest).toEqual({ format: BUNDLE_V10_FORMAT, capabilities: [], files: [MEMBER_ENTRY] });
    expect(anchored.identity).not.toBe(bare.identity);
  });

  test("a vector this build could not verify is not one it will seal", () => {
    // Both ends read one registry. A producer able to seal an unknown token, or a combination the
    // registry does not admit, would mint a bundle identity no reader can ever accept.
    const root = bundleWith({ format: BUNDLE_FORMAT, files: [MEMBER_ENTRY] });
    for (const capabilities of [["zz-unknown"], ["disclosure-specification"], ["binary-qualification", "anchoring"]]) {
      const refusal = expectRefusal(() => buildBundleManifest(root, [MEMBER], { format: BUNDLE_V10_FORMAT, capabilities }));
      expect(refusal.issues[0]!.path, JSON.stringify(capabilities)).toBe("bundle.manifest.capabilities");
    }
  });

  test("a legacy format still builds byte-identically, with no vector", () => {
    const root = bundleWith({ format: BUNDLE_FORMAT, files: [MEMBER_ENTRY] });
    expect(buildBundleManifest(root, [MEMBER]).manifest).toEqual({ format: BUNDLE_FORMAT, files: [MEMBER_ENTRY] });
    expect(buildBundleManifest(root, [MEMBER], { format: BUNDLE_V6_FORMAT }).manifest)
      .toEqual({ format: BUNDLE_V6_FORMAT, files: [MEMBER_ENTRY] });
  });
});
