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
import { derivePublicComparison, verifyPublicBundle } from "@colophon-claims/verify";
import { buildBundleManifest } from "./manifest.js";
import {
  BUNDLE_V6_FORMAT,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
} from "../legacy-closures.js";
import { BUNDLE_V9_FORMAT, type BuildBundleManifestOptions } from "./manifest.js";
import { buildPublicAssets } from "./assets.js";
import { parseBenchmark, parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
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
 * by the semantic check under test rather than by the manifest digest that precedes it. Keeps the
 * bundle's OWN declared format rather than stamping one: relabelling is its own tamper family, and
 * a helper that silently performed it would make every other case a relabel too. */
function rewriteManifest(bundleDir: string, paths: readonly string[]): void {
  const format = json(bundleDir, "bundle.json").format as BuildBundleManifestOptions["format"];
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, [...paths], { format }).bytes,
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

/**
 * A faithful `/6` bundle, built by moving a `/9` one back onto the allocation it succeeded.
 *
 * The producer no longer emits `/6` (issue #3698), but every `/6` bundle ever published still has
 * to verify, forever — that immutability is what makes a published claim citable, and
 * `claim-consistency` rebuilds each one's claim from its own records before byte-comparing. The
 * three things that differ between the two allocations are exactly the three rewritten here: the
 * format literal, the reader line the claim pins, and the page. Nothing else moves, which is the
 * whole content of the allocation.
 */
function moveOntoV6(bundleDir: string): void {
  const claim = json(bundleDir, "claim-package.json");
  claim.verification.command = PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND;
  claim.verification.compatibleCommand = PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND;
  writeFileSync(join(bundleDir, "claim-package.json"), canonicalJsonBytes(claim));

  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(bundleDir, name)));
  const manifest = json(bundleDir, "bundle.json");
  const paths = (manifest.files as Array<{ path: string }>).map((entry) => entry.path);
  // Line 1 is the assembly header, not a cell; the reader parses it under its own schema.
  const assembly = readFileSync(join(bundleDir, "verification/assembly.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .slice(1)
    .map((line) => JSON.parse(line) as { cellKey: string; verdicts: Array<{ verdict: string }> });
  const matrix = parseMatrix(read("matrix.json"));
  const recordSha256s = paths.flatMap((path) => {
    const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(path);
    return match === null ? [] : [match[1]!];
  });
  const assets = buildPublicAssets({
    format: BUNDLE_V6_FORMAT,
    claim: claim as never,
    matrix,
    report: parseReport(read("report.json")),
    reportSha256: claim.records.reportSha256 as string,
    matrixSha256: claim.records.matrixSha256 as string,
    recordSha256s,
    dissentCellKeys: assembly
      .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
      .map((cell) => cell.cellKey)
      .sort(),
    // Derived, not omitted: the verifier derives it for every non-binary bundle, and the page it
    // rebuilds is what these bytes are compared against.
    comparison: derivePublicComparison({
      benchmark: parseBenchmark(read("benchmark.json")),
      matrix,
      assemblyCells: assembly as never,
      recordBytes: new Map(recordSha256s.map((sha256) => [sha256, read(`records/${sha256}.bin`)])),
    }),
  } as never);
  for (const [name, bytes] of Object.entries(assets)) writeFileSync(join(bundleDir, name), bytes);
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, paths, { format: BUNDLE_V6_FORMAT }).bytes,
  );
}

describe("anchored public bundle v6 — portable verification", () => {
  test("a bundle on the superseded /6 allocation still verifies, page and pin included", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    rmSync(built.workspaceDir, { recursive: true, force: true });
    moveOntoV6(bundleDir);

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V6_FORMAT);
    expect(verified.checks.at(-1)).toBe("integrity-anchors");
  }, 120_000);

  test("a /9 bundle relabelled to /6 without moving its claim and page is refused", async () => {
    // The half that proves the test above is not simply accepting anything: relabelling alone
    // leaves a claim pinning the /9 line and a page without the denominator columns, and
    // `claim-consistency` rebuilds both from the format the manifest declares.
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    const paths = (json(bundleDir, "bundle.json").files as Array<{ path: string }>).map((entry) => entry.path);
    writeFileSync(
      join(bundleDir, "bundle.json"),
      buildBundleManifest(bundleDir, paths, { format: BUNDLE_V6_FORMAT }).bytes,
    );
    await expectRefusal(bundleDir, "is not the exact projection");
  }, 120_000);


  test("an anchored bundle round-trips producer to verifier and returns the seven checks", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const bundleDir = detach(built.bundle.bundleDir);
    // The originating workspace is gone before a single byte is verified.
    rmSync(built.workspaceDir, { recursive: true, force: true });

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V9_FORMAT);
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
    expect(verified.format).toBe(BUNDLE_V9_FORMAT);
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
 * declaration is sealed at the lock and judged again by a cold reader that only has bytes, so a
 * rule that reaches only one of the two refuses the whole bundle AFTER the irreversible lock. Only
 * a round trip through `draft update` -> `runLock` -> `materialize` -> `verifyPublicBundle` proves
 * the two agree. It also proves the stronger modes are reachable at all: every task-set intake in
 * this product re-authors the Benchmark under the workspace key that is also the Run owner, so a
 * verifier rule keyed on that relationship would make them dead letters.
 *
 * The face renders nothing for any of it -- that is held for issue #3416 -- and the last test here
 * is what keeps the hold honest end to end.
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
    // `requireOk` prefixes the stage label, so the `lock:` prefix is what proves the refusal came
    // from the lock rather than from materialization further downstream.
    await expect(declaringFixture("drawn-post-lock"))
      .rejects.toThrow(/^lock: .*reveals its items immediately/);
  }, 120_000);

  /**
   * The reader-compatibility invariant, end to end (issue #3416).
   *
   * The render is held, so a declaring bundle must publish a face that a task-selection-unaware
   * builder reproduces exactly -- which is what the pinned `@colophon-claims/verify@0.1.0` this
   * bundle's own claim package instructs a reader to run actually does. Two things prove it here:
   * no asset carries the held sentences, and cold verification passes, and passing IS the
   * byte-comparison of all five assets against a rebuild.
   */
  test("a declaring bundle publishes a face carrying no trace of the declaration", async () => {
    const { bundle } = await declaringFixture("claimant-chosen");
    const held = [
      "The claimant chose which tasks",
      "the complete, publicly declared set",
      "drawn by a fixed rule after the run was locked",
    ];
    for (const asset of ["index.html", "README.md", "share.txt", "badge.svg", "social-card.svg"]) {
      const text = readFileSync(join(bundle.bundleDir, asset), "utf8");
      for (const sentence of held) {
        expect(text, `${asset} must not render task-selection provenance`).not.toContain(sentence);
      }
    }
    // The claim package still points a reader at the classic pinned verifier, and that verifier
    // rebuilds these exact assets. Byte-comparing them is what `verifyPublicBundle` does below.
    expect(json(bundle.bundleDir, "claim-package.json").verification.command)
      .toBe("npx @colophon-claims/verify@0.1.0 <bundle-dir>");
    const verified = await verifyPublicBundle(detach(bundle.bundleDir));
    expect(verified.checks).toContain("claim-consistency");
  }, 120_000);
});
