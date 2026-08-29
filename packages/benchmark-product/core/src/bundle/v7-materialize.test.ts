// SPDX-License-Identifier: Apache-2.0

/**
 * The anchored binary-qualification closure, end to end (issue #3205).
 *
 * `benchmark-product-public-bundle/7` is v4's member list plus v6's `anchors/`, and its claim is
 * `benchmark-product.claim-package/5` — claim-package/2's exact qualification projection plus
 * claim-package/4's anchors section. Before this allocation existed the pairing had no closure at
 * all: an anchored run of a binary-instrument benchmark could not report, publish, or be verified,
 * which made anchoring and binary-instrument benchmarking mutually exclusive.
 *
 * Both halves are exercised here against ONE real fixture run: what the producer emits, and what
 * the standalone reader accepts and refuses when handed the copied directory.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import {
  RFC3161_TSA_ANCHOR_PROFILE,
  canonicalJsonBytes,
  parseExactAnchorEvidence,
} from "@jinn-network/trust-core";
import { verifyPublicBundle } from "@colophon-claims/check";
import {
  ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
} from "../report/claim.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { BUNDLE_V4_FORMAT, BUNDLE_V7_FORMAT, buildBundleManifest } from "./manifest.js";
import { PUBLIC_BUNDLE_V4_FILES } from "./materialize.js";
import {
  ANCHORED_V4_FIXTURE_GEN_TIME,
  createSyntheticV4BundleFixture,
  type SyntheticV4BundleFixture,
} from "./testing/v4-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let anchoredFixture: Promise<SyntheticV4BundleFixture> | undefined;

/** One real anchored binary run, built once: the fixture drives lock → anchor → launch → collect →
 * report → materialize through the production operations, and every test below reads the bundle it
 * produced. Tamper tests copy the directory rather than mutating it. */
function anchored(): Promise<SyntheticV4BundleFixture> {
  if (anchoredFixture === undefined) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "anchored-v7-"));
    anchoredFixture = createSyntheticV4BundleFixture({
      workspaceDir,
      truthAdmission: "operator-only",
      anchorLock: true,
    });
  }
  return anchoredFixture;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

function copyBundle(bundleDir: string, label: string): string {
  const copy = mkdtempSync(join(tmpdir(), `anchored-v7-tamper-${label}-`));
  roots.push(copy);
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

/** Re-signs the manifest over the tampered tree, so what the reader refuses is the semantic
 * inconsistency and not a stale digest it would have caught anyway. */
function rewriteManifest(bundleDir: string, format: typeof BUNDLE_V7_FORMAT | typeof BUNDLE_V4_FORMAT): void {
  const prior = json(bundleDir, "bundle.json");
  const paths = (prior.files as Array<{ path: string }>).map((entry) => entry.path);
  writeFileSync(join(bundleDir, "bundle.json"), buildBundleManifest(bundleDir, paths, { format }).bytes);
}

async function refusalPath(bundleDir: string): Promise<string> {
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    return (cause as { readonly issues?: readonly { readonly path?: string }[] }).issues?.[0]?.path ?? "";
  }
  return "NOT REFUSED";
}

describe("anchored binary-qualification bundle v7 — producer", () => {
  test("an anchored binary-instrument run publishes on v7 with a claim-package/5 claim", async () => {
    const built = await anchored();

    expect(json(built.bundle.bundleDir, "bundle.json").format).toBe(BUNDLE_V7_FORMAT);
    // v4's complete member list survives — the qualification document is not dropped by anchoring.
    for (const path of PUBLIC_BUNDLE_V4_FILES) expect(built.bundle.files).toContain(path);

    const anchorPaths = built.bundle.files.filter((path) => path.startsWith("anchors/"));
    expect(anchorPaths).toHaveLength(1);
    const recordSha256 = anchorPaths[0]!.slice("anchors/".length, -".bin".length);
    const bytes = new Uint8Array(readFileSync(join(built.bundle.bundleDir, anchorPaths[0]!)));
    expect(sha256Hex(bytes)).toBe(recordSha256);
    const record = parseExactAnchorEvidence(bytes);
    expect(record.provider).toBe(RFC3161_TSA_ANCHOR_PROFILE);
    expect(record.subject.kind).toBe(RUN_RECORD_KIND);

    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.claimSchema).toBe(ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.anchors).toHaveLength(1);
    expect(claim.anchors[0].subject).toBe("lock");
    expect(claim.anchors[0].facts.genTime).toBe(ANCHORED_V4_FIXTURE_GEN_TIME);
    // The projection itself is claim-package/2's, unchanged: the complete per-subject F6 result,
    // and no headline, comparison, or judge-family sibling.
    expect(claim.qualification).toEqual(claim.results.perSubject[0].results);
    expect(claim.headline).toBeUndefined();
    expect(claim.comparison).toBeUndefined();
    expect(claim.verification.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
    expect(claim.verification.command).toBe("npx @colophon-claims/verify@0.2.1 <bundle-dir>");
    expect(claim.verification.compatibleCommand).toBe("npx @colophon-claims/verify@0.2 <bundle-dir>");

    // `qualification.json` names the projection SHAPE, not the closure, and that shape is
    // claim-package/2's on both binary allocations — so the frozen literal does not move.
    expect(json(built.bundle.bundleDir, "qualification.json").claimSchema)
      .toBe(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
  }, 600_000);

  test("the same fixture without an anchor still emits v4 and claim-package/2, unchanged", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "unanchored-v4-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only" });

    expect(json(built.bundle.bundleDir, "bundle.json").format).toBe(BUNDLE_V4_FORMAT);
    expect(built.bundle.files.some((path) => path.startsWith("anchors/"))).toBe(false);
    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.claimSchema).toBe(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.anchors).toBeUndefined();
    expect(claim.verification.checks).toHaveLength(6);
    expect(json(built.bundle.bundleDir, "qualification.json").claimSchema)
      .toBe(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
    await expect(verifyPublicBundle(built.bundle.bundleDir)).resolves.toMatchObject({
      format: BUNDLE_V4_FORMAT,
      checks: [
        "manifest", "evidence-closure", "trust",
        "matrix-rederivation", "report-verification", "claim-consistency",
      ],
    });
  }, 600_000);
});

describe("anchored binary-qualification bundle v7 — the standalone reader", () => {
  test("verifies the copied bundle on all seven checks", async () => {
    const built = await anchored();
    const copy = copyBundle(built.bundle.bundleDir, "clean");

    const verified = await verifyPublicBundle(copy);
    expect(verified.format).toBe(BUNDLE_V7_FORMAT);
    expect(verified.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
    // The qualification disclosure the v4 closure already reported travels with the anchored one.
    expect(verified).toMatchObject({ qualification: { truthAdmission: "operator-only", publicationGrade: false } });
    // Anchors are DISCLOSED, never folded into a badge: the fixture authority's root is not
    // supplied, so a well-formed proof is reported `present`, not `verified`.
    expect((verified as { anchors?: { anchors: readonly { status: string }[] } }).anchors?.anchors)
      .toEqual([expect.objectContaining({ status: "present" })]);
  }, 600_000);

  test("refuses a stripped anchors section — an anchored bundle cannot demote itself to v4", async () => {
    const built = await anchored();
    const copy = copyBundle(built.bundle.bundleDir, "stripped");
    const manifest = json(copy, "bundle.json");
    const anchorPath = (manifest.files as Array<{ path: string }>)
      .map((entry) => entry.path).find((path) => path.startsWith("anchors/"))!;
    rmSync(join(copy, anchorPath), { force: true });
    writeFileSync(
      join(copy, "bundle.json"),
      buildBundleManifest(
        copy,
        (manifest.files as Array<{ path: string }>).map((entry) => entry.path).filter((path) => path !== anchorPath),
        { format: BUNDLE_V7_FORMAT },
      ).bytes,
    );

    expect(await refusalPath(copy)).toBe("claim-consistency");
  }, 600_000);

  test("refuses an edited qualification section on the anchored closure", async () => {
    const built = await anchored();
    const copy = copyBundle(built.bundle.bundleDir, "qualification");
    const claim = json(copy, "claim-package.json");
    claim.qualification.configuration.intervalAlpha = "0.01";
    writeFileSync(join(copy, "claim-package.json"), canonicalJsonBytes(claim));
    rewriteManifest(copy, BUNDLE_V7_FORMAT);

    expect(await refusalPath(copy)).toBe("claim-package.json");
  }, 600_000);

  test("refuses a qualification document whose frozen claim literal was moved to the new closure", async () => {
    const built = await anchored();
    const copy = copyBundle(built.bundle.bundleDir, "allocation");
    const qualification = json(copy, "qualification.json");
    qualification.claimSchema = ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID;
    writeFileSync(join(copy, "qualification.json"), canonicalJsonBytes(qualification));
    rewriteManifest(copy, BUNDLE_V7_FORMAT);

    expect(await refusalPath(copy)).toBe("qualification.json");
  }, 600_000);

  test("refuses an anchor member smuggled into a v4 bundle", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "unanchored-v4-smuggle-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only" });
    const anchoredBuilt = await anchored();
    const copy = copyBundle(built.bundle.bundleDir, "smuggled");
    const anchorPath = anchoredBuilt.bundle.files.find((path) => path.startsWith("anchors/"))!;
    cpSync(join(anchoredBuilt.bundle.bundleDir, anchorPath), join(copy, anchorPath), { recursive: true });
    const manifest = json(copy, "bundle.json");
    writeFileSync(
      join(copy, "bundle.json"),
      buildBundleManifest(
        copy,
        [...(manifest.files as Array<{ path: string }>).map((entry) => entry.path), anchorPath],
        { format: BUNDLE_V4_FORMAT },
      ).bytes,
    );

    expect(await refusalPath(copy)).toBe(anchorPath);
  }, 600_000);
});
