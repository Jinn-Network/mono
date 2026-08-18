// SPDX-License-Identifier: Apache-2.0

/**
 * The producer half of the anchored closure (anchor-evidence design §7.4, §9.2): what
 * `materializePublicBundle` emits for a run that carries anchors, and — just as load-bearing — what
 * it still emits, byte for byte, for a run that does not.
 *
 * The verifier half (the `integrity-anchors` check, the trust-material split, the kit's fixture
 * families) lives in the reader package's own suites.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  parseExactAnchorEvidence,
} from "@jinn-network/trust-core";
import { MATRIX_RECORD_KIND, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { ANCHORED_CLAIM_PACKAGE_SCHEMA_ID, CLAIM_PACKAGE_SCHEMA_ID } from "../report/claim.js";
import { BUNDLE_V6_FORMAT } from "./manifest.js";
import { LOCAL_VENUE_LIMITS } from "../operations/run-results.js";
import { verifyRunWorkspace } from "../operations/verify.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  V6_FIXTURE_GEN_TIME,
  createSyntheticV6BundleFixture,
  type SyntheticV6BundleFixture,
} from "./testing/v6-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(plans?: Parameters<typeof createSyntheticV6BundleFixture>[0]["plans"]): Promise<SyntheticV6BundleFixture> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "anchored-v6-"));
  roots.push(workspaceDir);
  return createSyntheticV6BundleFixture({ workspaceDir, ...(plans === undefined ? {} : { plans }) });
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

describe("anchored public bundle v6 — producer", () => {
  test("a run with no anchors emits the unanchored closure byte-identically", async () => {
    const built = await fixture();

    const manifest = json(built.bundle.bundleDir, "bundle.json");
    expect(manifest.format).toBe("benchmark-product-public-bundle/2");
    expect(built.bundle.files.some((path) => path.startsWith("anchors/"))).toBe(false);

    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.claimSchema).toBe(CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.anchors).toBeUndefined();
    expect(claim.venueHonesty.preRegistration).toBe("structural-and-append-order-only");
    expect(claim.venueHonesty.limits).toEqual([...LOCAL_VENUE_LIMITS]);
    expect(claim.verification.trustRoot).toContain("there is no third-party trust anchor on the self-run venue");
    expect(claim.verification.checks).toHaveLength(6);
  }, 120_000);

  test("one RFC 3161 lock anchor moves the bundle onto v6 and the claim onto /4", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);

    const manifest = json(built.bundle.bundleDir, "bundle.json");
    expect(manifest.format).toBe(BUNDLE_V6_FORMAT);

    const anchorPaths = built.bundle.files.filter((path) => path.startsWith("anchors/"));
    expect(anchorPaths).toHaveLength(1);
    const recordSha256 = anchorPaths[0]!.slice("anchors/".length, -".bin".length);

    // The member is named by the digest of its own exact bytes, and those bytes are the exact
    // sealed AnchorEvidence encoding -- not a re-serialization of a parsed record.
    const bytes = new Uint8Array(readFileSync(join(built.bundle.bundleDir, anchorPaths[0]!)));
    expect(sha256Hex(bytes)).toBe(recordSha256);
    const record = parseExactAnchorEvidence(bytes);
    expect(record.provider).toBe(RFC3161_TSA_ANCHOR_PROFILE);
    expect(record.subject.kind).toBe(RUN_RECORD_KIND);
    expect(record.subject.digest.sha256).toBe(built.runSha256);

    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.claimSchema).toBe(ANCHORED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.anchors).toHaveLength(1);
    expect(claim.anchors[0]).toEqual({
      subject: "lock",
      kind: RUN_RECORD_KIND,
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      recordSha256,
      facts: {
        genTime: V6_FIXTURE_GEN_TIME,
        policyOid: expect.any(String),
        serialNumber: expect.stringMatching(/^[a-f0-9]+$/),
        signerCertificateSha256: built.authority.certificateSha256,
      },
    });
    // Byte-embedded facts only: no issuer distinguished name, no accuracy interval, no block time.
    expect(Object.keys(claim.anchors[0].facts).sort()).toEqual([
      "genTime",
      "policyOid",
      "serialNumber",
      "signerCertificateSha256",
    ]);
    expect(claim.verification.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
  }, 120_000);

  test("a governing authority-time lock anchor replaces exactly sentence 2 and the trust root", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const claim = json(built.bundle.bundleDir, "claim-package.json");

    expect(claim.venueHonesty.preRegistration).toBe("structural-append-order-and-anchored-time");
    expect(claim.venueHonesty.limits[1]).toBe(
      "Pre-registration here is anchored: an external timestamp authority asserts this run's sealed "
      + `design digest existed no later than ${V6_FIXTURE_GEN_TIME}. That assertion proves the design's `
      + "existence by that time and nothing else about the run — in particular, not that results were "
      + "produced after it — and it is only as good as the authority behind the signing key named in "
      + "the token.",
    );
    // Sentences 1, 3, 4, and 5 are untouched.
    expect(claim.venueHonesty.limits[0]).toBe(LOCAL_VENUE_LIMITS[0]);
    expect(claim.venueHonesty.limits.slice(2)).toEqual([...LOCAL_VENUE_LIMITS.slice(2)]);
    expect(claim.verification.trustRoot).toBe(
      "Signatures verify against the bundle-carried public keys minted by this workspace. The lock "
      + "digest additionally carries a third-party time anchor, checked against trust material "
      + "supplied on the verifier's side — never against roots carried in this bundle.",
    );
  }, 120_000);

  test("a chain-time governing anchor states the attributive form, keyed on block height", async () => {
    const built = await fixture([{ kind: "opentimestamps-lock-upgraded" }]);
    const claim = json(built.bundle.bundleDir, "claim-package.json");

    // The upgraded pair travels: each record is reported on its own bytes, and the complete one
    // governs the copy (§11 family 9).
    expect(claim.anchors).toHaveLength(2);
    const pending = claim.anchors.filter((anchor: any) => anchor.facts.pending === true);
    const complete = claim.anchors.filter((anchor: any) => typeof anchor.facts.blockHeight === "number");
    expect(pending).toHaveLength(1);
    expect(complete).toHaveLength(1);
    expect(complete[0].upgradesRecordSha256).toBe(pending[0].recordSha256);
    expect(pending[0].upgradesRecordSha256).toBeUndefined();

    expect(claim.venueHonesty.preRegistration).toBe("structural-append-order-and-anchored-time");
    expect(claim.venueHonesty.limits[1]).toBe(
      "Pre-registration here carries an anchor: an OpenTimestamps proof asserting a Bitcoin "
      + `commitment at block height ${complete[0].facts.blockHeight} covers this run's sealed design `
      + "digest. Checking that commitment requires Bitcoin block headers on the verifier's side; if "
      + "it holds, it shows the design existed no later than that block — and nothing else about the "
      + "run.",
    );
  }, 120_000);

  test("a pending-only proof is carried, gates nothing, and leaves every sentence unconditional", async () => {
    const built = await fixture([{ kind: "opentimestamps-lock-pending" }]);
    const claim = json(built.bundle.bundleDir, "claim-package.json");

    expect(claim.claimSchema).toBe(ANCHORED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.anchors).toHaveLength(1);
    expect(claim.anchors[0].facts).toEqual({ pending: true });
    expect(claim.venueHonesty.preRegistration).toBe("structural-and-append-order-only");
    expect(claim.venueHonesty.limits).toEqual([...LOCAL_VENUE_LIMITS]);
    expect(claim.verification.trustRoot).toContain("there is no third-party trust anchor on the self-run venue");
  }, 120_000);

  test("a matrix anchor adds its neutral line and upgrades nothing", async () => {
    const built = await fixture([{ kind: "rfc3161-matrix" }]);
    const claim = json(built.bundle.bundleDir, "claim-package.json");

    expect(claim.anchors).toHaveLength(1);
    expect(claim.anchors[0].subject).toBe("matrix");
    expect(claim.anchors[0].kind).toBe(MATRIX_RECORD_KIND);
    expect(claim.venueHonesty.preRegistration).toBe("structural-and-append-order-only");
    expect(claim.venueHonesty.limits[1]).toBe(LOCAL_VENUE_LIMITS[1]);
    expect(claim.venueHonesty.limits.at(-1)).toBe(
      `The terminal results digest carries a third-party time anchor of ${V6_FIXTURE_GEN_TIME}.`,
    );
    expect(claim.verification.trustRoot).toContain("there is no third-party trust anchor on the self-run venue");
  }, 120_000);

  test("a second lock anchor adds one neutral line while the earliest one governs", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }, { kind: "opentimestamps-lock-upgraded" }]);
    const claim = json(built.bundle.bundleDir, "claim-package.json");

    // The authority-time anchor carries a byte-embedded time and therefore governs; the chain-time
    // one carries no time at all and cannot displace it.
    expect(claim.venueHonesty.limits[1]).toContain("an external timestamp authority asserts");
    const height = claim.anchors
      .find((anchor: any) => anchor.provider === OPENTIMESTAMPS_ANCHOR_PROFILE && anchor.facts.blockHeight !== undefined)
      .facts.blockHeight;
    expect(claim.venueHonesty.limits).toContain(
      `The lock digest additionally carries a chain-time anchor of ${height}.`,
    );
  }, 120_000);

  test("workspace verify re-derives the anchored claim from the sealed anchor bytes", async () => {
    const built = await fixture([{ kind: "rfc3161-lock" }]);
    const verified = await verifyRunWorkspace(
      { workspaceDir: built.workspaceDir, principal: "synthetic-operator", clock: () => new Date().toISOString() },
      { draftId: built.draftId },
    );
    expect(verified.checks).toContain("claim-consistency");
  }, 120_000);
});
