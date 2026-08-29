// SPDX-License-Identifier: Apache-2.0

/**
 * The compound gate for the anchored closure (anchor-evidence design §7.4, §8): a bundle this
 * product materialized round-trips through the portable reader, and the reader's own claim rebuild
 * byte-compares against the sealed claim.
 *
 * The tamper cases below are the bundle-level half of §11's families — the check-level half is
 * unit-tested against the conformance kit inside the reader package. What can only be tested here
 * is that the two halves agree on one real byte string.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RFC3161_TSA_ANCHOR_PROFILE, canonicalJsonBytes } from "@jinn-network/trust-core";
import { verifyPublicBundle } from "@colophon-claims/verify";
import { BUNDLE_V6_FORMAT, buildBundleManifest } from "./manifest.js";
import { LOCAL_VENUE_LIMITS } from "../operations/run-results.js";
import {
  V6_FIXTURE_SPLICED_GEN_TIME_DER,
  createSyntheticV6BundleFixture,
  type SyntheticV6AnchorPlan,
  type SyntheticV6BundleFixture,
} from "./testing/v6-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(plans?: readonly SyntheticV6AnchorPlan[]): Promise<SyntheticV6BundleFixture> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "anchored-v6-verify-"));
  roots.push(workspaceDir);
  return createSyntheticV6BundleFixture({ workspaceDir, ...(plans === undefined ? {} : { plans }) });
}

async function declaringFixture(
  taskSelection: "claimant-chosen" | "fixed-public-set" | "drawn-post-lock",
): Promise<SyntheticV6BundleFixture> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "anchored-v6-selection-"));
  roots.push(workspaceDir);
  return createSyntheticV6BundleFixture({ workspaceDir, taskSelection });
}

/** A detached copy, so every tamper case runs against bytes with no workspace behind them. */
function detach(bundleDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "anchored-v6-detached-"));
  roots.push(root);
  const copy = join(root, "bundle");
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

/** Rebuilds the manifest over whatever members the directory now holds, so a tamper case is refused
 * by the semantic check under test rather than by the manifest digest that precedes it. */
function rewriteManifest(bundleDir: string, paths: readonly string[]): void {
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, [...paths], { format: BUNDLE_V6_FORMAT }).bytes,
  );
}

function memberPaths(bundleDir: string): string[] {
  return (json(bundleDir, "bundle.json").files as Array<{ path: string }>).map((entry) => entry.path);
}

async function expectRefusal(bundleDir: string, fragment: string): Promise<void> {
  let message = "";
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }
  expect(message, `expected a refusal mentioning "${fragment}"`).toContain(fragment);
}

describe("anchored public bundle v6 — portable verification", () => {
  test("an anchored bundle round-trips producer to verifier and returns the seven checks", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    // The originating workspace is gone before a single byte is verified.
    rmSync(built.workspaceDir, { recursive: true, force: true });

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V6_FORMAT);
    expect(verified.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
    if (verified.format === "benchmark-product-public-bundle/5") throw new Error("unreachable");
    expect(verified.anchors?.anchors).toHaveLength(1);
    // No trust material was configured, so the honest outcome is `present`, never `verified`.
    expect(verified.anchors?.anchors[0]).toMatchObject({
      status: "present",
      subject: "lock",
      timeBasis: "authority-time",
      trustMaterial: "none",
    });
    expect(verified.anchors?.subjects).toEqual([
      { subject: "lock", outcome: "anchored" },
      { subject: "matrix", outcome: "absent" },
    ]);
  }, 180_000);

  test("verifier-supplied roots move the same bundle from present to verified", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    const withRoots = await verifyPublicBundle(bundleDir, {
      anchorTrust: { rfc3161: { trustAnchorsDer: [built.authority.certificateDer] } },
    });
    if (withRoots.format === "benchmark-product-public-bundle/5") throw new Error("unreachable");
    expect(withRoots.anchors?.anchors[0]).toMatchObject({ status: "verified", trustMaterial: "supplied" });
    // The sealed claim is the same bytes either way: the copy keys on the record, not on this
    // reader's configuration.
    expect(json(bundleDir, "claim-package.json")).toEqual(json(built.bundle.bundleDir, "claim-package.json"));
  }, 180_000);

  test("an unanchored bundle still verifies with exactly the six frozen checks", async () => {
    const built = await fixture();
    const verified = await verifyPublicBundle(detach(built.bundle.bundleDir));
    expect(verified.format).toBe("benchmark-product-public-bundle/2");
    expect(verified.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
    if (verified.format === "benchmark-product-public-bundle/5") throw new Error("unreachable");
    expect(verified.anchors).toBeUndefined();
  }, 180_000);

  test("both carried records of an upgraded pair verify and the completed one governs", async () => {
    const built = await fixture([{ kind: "opentimestamps-lock-upgraded" }, { kind: "opentimestamps-matrix" }]);
    const verified = await verifyPublicBundle(detach(built.bundle.bundleDir));
    if (verified.format === "benchmark-product-public-bundle/5") throw new Error("unreachable");
    expect(verified.anchors?.anchors.map((entry) => entry.status).sort()).toEqual(["pending", "present", "present"]);
    expect(verified.anchors?.subjects).toEqual([
      { subject: "lock", outcome: "anchored" },
      { subject: "matrix", outcome: "anchored" },
    ]);
  }, 180_000);

  test("a lock anchor spliced past the run's close instant fails the whole verification (family 8)", async () => {
    // The splice-catch is enforced on BOTH sides. `runAnchor` applies it at acquisition (§19.5:
    // enforcing it only at verification bricks a run whose anchoring window has already shut), and
    // the reader applies it again because a producer cannot be trusted to have done so. That second
    // half is what this case covers, so the bundle is built by simulating exactly such a producer:
    // the record and its RunState entry are written directly, with no producer operation in the
    // path. A conformant producer can no longer reach this state, which is the point.
    const built = await fixture([{
      kind: "rfc3161-lock",
      genTimeDer: V6_FIXTURE_SPLICED_GEN_TIME_DER,
      bypassProducerGuard: true,
    }]);
    await expectRefusal(
      detach(built.bundle.bundleDir),
      "after this run's own pre-registered close instant",
    );
  }, 180_000);

  test("a declared but unsatisfied intent stays on the anchored closure and is disclosed (family 5)", async () => {
    const built = await createSyntheticV6BundleFixture({
      workspaceDir: mkdtempSync(join(tmpdir(), "anchored-v6-declared-")),
      declaredProviders: [RFC3161_TSA_ANCHOR_PROFILE],
    });
    roots.push(built.workspaceDir);

    // The bundle carries no anchor at all, and still cannot drop back to a closure version with
    // nothing to say about the declaration it seals.
    expect(built.bundle.files.some((path) => path.startsWith("anchors/"))).toBe(false);
    const verified = await verifyPublicBundle(detach(built.bundle.bundleDir));
    expect(verified.format).toBe(BUNDLE_V6_FORMAT);
    expect(verified.checks.at(-1)).toBe("integrity-anchors");
    if (verified.format === "benchmark-product-public-bundle/5") throw new Error("unreachable");
    expect(verified.anchors?.anchors).toHaveLength(0);
    expect(verified.anchors?.subjects[0]).toEqual({
      subject: "lock",
      outcome: "declared-but-absent",
      declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE],
    });

    // Nothing about the declaration upgrades the copy: the unconditional sentences stand.
    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.anchors).toEqual([]);
    expect(claim.venueHonesty.preRegistration).toBe("structural-and-append-order-only");
    expect(claim.venueHonesty.limits).toEqual([...LOCAL_VENUE_LIMITS]);
  }, 180_000);

  test("a stripped anchor cannot pass as an unanchored bundle (family 3, absence-hiding)", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    const anchorPath = memberPaths(bundleDir).find((path) => path.startsWith("anchors/"))!;
    unlinkSync(join(bundleDir, anchorPath));
    rewriteManifest(bundleDir, memberPaths(bundleDir).filter((path) => path !== anchorPath));

    // The claim still names the anchor the bundle no longer carries, so the rebuild disagrees.
    await expectRefusal(bundleDir, "claim package anchors is not the exact projection");
  }, 180_000);

  test("an anchored bundle whose stored claim carries the unanchored copy fails (family 13)", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    const claim = json(bundleDir, "claim-package.json");
    claim.venueHonesty.preRegistration = "structural-and-append-order-only";
    claim.venueHonesty.limits = [...LOCAL_VENUE_LIMITS];
    writeFileSync(join(bundleDir, "claim-package.json"), canonicalJsonBytes(claim));
    rewriteManifest(bundleDir, memberPaths(bundleDir));

    await expectRefusal(bundleDir, "is not the exact projection of verified facts");
  }, 180_000);

  test("an unanchored bundle whose stored claim asserts an anchor fails (family 13, the other way)", async () => {
    const anchored = await fixture([{ kind: "rfc3161-lock" }]);
    const plain = await fixture();
    const bundleDir = detach(plain.bundle.bundleDir);
    const claim = json(bundleDir, "claim-package.json");
    // Lift the anchored claim's own section and copy verbatim onto a bundle that carries nothing.
    claim.anchors = json(anchored.bundle.bundleDir, "claim-package.json").anchors;
    writeFileSync(join(bundleDir, "claim-package.json"), canonicalJsonBytes(claim));
    writeFileSync(
      join(bundleDir, "bundle.json"),
      buildBundleManifest(bundleDir, memberPaths(bundleDir), { format: "benchmark-product-public-bundle/2" }).bytes,
    );

    // claim-package/1 has no anchors section at all, so the document fails its own public schema.
    await expectRefusal(bundleDir, "claim-package.json");
  }, 240_000);

  test("a malformed anchor-intent declaration is a record refusal, not an operational failure", async () => {
    const built = await fixture();
    const bundleDir = detach(built.bundle.bundleDir);
    const run = json(bundleDir, "run.json");
    // Present, namespaced, and outside its own schema. A reader that only touched this field when
    // something downstream asked for it would raise a raw schema error out of a path with no way to
    // classify it; the Run schema refuses it as what it is — a Run that does not conform.
    run["https://spec.jinn.network/extensions/anchor-intent/v1"] = { providers: [] };
    writeFileSync(join(bundleDir, "run.json"), canonicalJsonBytes(run));
    writeFileSync(
      join(bundleDir, "bundle.json"),
      buildBundleManifest(bundleDir, memberPaths(bundleDir), { format: "benchmark-product-public-bundle/2" }).bytes,
    );

    let code = "";
    try {
      await verifyPublicBundle(bundleDir);
    } catch (cause) {
      code = String((cause as { code?: unknown }).code);
    }
    // `record-integrity` is the exit-1 class: an invalid bundle, never a broken verifier.
    expect(code).toBe("record-integrity");
    await expectRefusal(bundleDir, "primary benchmark record is invalid");
  }, 180_000);

  test("an anchor member in a bundle that is not the anchored closure is not allowlisted", async () => {
    const anchored = await fixture([{ kind: "rfc3161-lock" }]);
    const plain = await fixture();
    const bundleDir = detach(plain.bundle.bundleDir);
    const anchorPath = memberPaths(detach(anchored.bundle.bundleDir)).find((path) => path.startsWith("anchors/"))!;
    cpSync(join(anchored.bundle.bundleDir, anchorPath), join(bundleDir, anchorPath), { recursive: false });
    writeFileSync(
      join(bundleDir, "bundle.json"),
      buildBundleManifest(bundleDir, [...memberPaths(bundleDir), anchorPath], {
        format: "benchmark-product-public-bundle/2",
      }).bytes,
    );

    await expectRefusal(bundleDir, "non-allowlisted file");
  }, 240_000);
});

/**
 * Task-selection provenance, end to end (issue #2980).
 *
 * The unit tests either side of this file can both be right while the feature is still broken: the
 * producer renders assets and the reader byte-compares its own rebuild of them, so a declaration
 * that reaches only one of the two refuses the whole bundle AFTER the irreversible lock. Only a
 * round trip through `draft update` -> `runLock` -> `materialize` -> `verifyPublicBundle` proves
 * the two agree. It also proves the stronger modes are reachable at all: every task-set intake in
 * this product re-authors the Benchmark under the workspace key that is also the Run owner, so a
 * verifier rule keyed on that relationship would make them dead letters.
 */
describe("task-selection provenance round trip", () => {
  for (const mode of ["claimant-chosen", "fixed-public-set"] as const) {
    test(`${mode} survives lock, materialization, and cold verification`, async () => {
      const { bundle } = await declaringFixture(mode);
      const verified = await verifyPublicBundle(detach(bundle.bundleDir));
      expect(verified.checks).toContain("claim-consistency");
    }, 120_000);
  }

  test("a contradicted declaration is refused at the lock, not after publication", async () => {
    // SWE-bench intake reveals its items immediately, so `drawn-post-lock` is genuinely false for
    // it. The claimant must learn that while the draft is still editable — refusing this at publish
    // would strand a locked, executed, reported run in a bundle nothing can ever verify.
    await expect(declaringFixture("drawn-post-lock")).rejects.toThrow(/reveals its items immediately/);
  }, 120_000);

  test("the declared sentence reaches the published face", async () => {
    const { bundle } = await declaringFixture("claimant-chosen");
    const html = readFileSync(join(bundle.bundleDir, "index.html"), "utf8");
    expect(html).toContain('<p class="neutral">The claimant chose which tasks appear in this report.</p>');
  }, 120_000);

  test("an undeclared run publishes the same face bytes it always did", async () => {
    const declared = await declaringFixture("claimant-chosen");
    const undeclared = await fixture();
    const face = (dir: string) => readFileSync(join(dir, "index.html"), "utf8");
    expect(face(undeclared.bundle.bundleDir)).not.toContain("The claimant chose");
    expect(face(declared.bundle.bundleDir)).not.toBe(face(undeclared.bundle.bundleDir));
  }, 120_000);
});
