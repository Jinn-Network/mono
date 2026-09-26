// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3939: `PUBLIC-BUNDLE.md` claims the released `@0.1` line verifies a prompted-screening
 * `benchmark-product-public-bundle/2` whose own assets name `@0.2.1`, because claim-package/1
 * states no reader requirement. The in-repo reader is `0.2.1`, so a fixture built only against
 * current source re-asserts today's claim-package/1 path. This suite pins the published
 * `@colophon-claims/verify@0.1.0` tarball (2026-08-21) and round-trips a prompted `/2` claim
 * through that frozen grammar plus the current schema and asset builder.
 *
 * Full `colophon-verify` against a producer-accurate prompted `/2` is a different question: 0.1.0
 * rebuilds claim-package/1 with `@0.1.0` and has no prompted-screening branch, so claim-consistency
 * would disagree with a sealed `@0.2.1` command. The published claim is the pin admission, which
 * is what this file settles.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PROMPTED_SCREENING_PROFILE } from "./admission/contracts.js";
import { buildPublicAssets } from "./assets.js";
import {
  BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  BUNDLE_FORMAT,
  CLAIM_PACKAGE_SCHEMA_ID,
  PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
  PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
} from "./legacy-closures.js";
import { ClaimPackageSchema } from "./profile/claim.js";
import { GOLDEN_BUNDLE_DIR, goldenInput } from "./testing/golden-asset-input.js";

const TARBALL = fileURLToPath(new URL(
  "../fixtures/released-verify-0.1.0/verify-0.1.0.tgz",
  import.meta.url,
));
/** SHA-256 of the exact npm `verify-0.1.0.tgz` (registry integrity `sha512-Wtp6q4…wORA==`). */
const RELEASED_VERIFY_0_1_0_SHA256 =
  "cdd2f0ae2d7368f8e0eaaf27e0b925276df8340473581802730d6dbeb3185247";
const decoder = new TextDecoder();

function extractFromReleasedTarball(member: string): string {
  return execFileSync("tar", ["-xOz", "-f", TARBALL, member], { encoding: "utf8" });
}

function promptedPublicBundle2Claim(base: Record<string, unknown>): Record<string, unknown> {
  const method = base["method"] as { readonly parameters?: Record<string, unknown> };
  const verification = base["verification"] as Record<string, unknown>;
  return {
    ...base,
    method: {
      ...method,
      parameters: {
        ...(method.parameters ?? {}),
        promptedScreeningProfile: PROMPTED_SCREENING_PROFILE,
      },
    },
    verification: {
      ...verification,
      command: PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND,
      compatibleCommand: PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
    },
  };
}

function zeroBinaryProjection() {
  const zeroRate = {
    numerator: 0,
    denominator: 0,
    estimate: null,
    wilsonInterval: null,
    withheldReason: "zero-denominator",
  };
  const projection = {
    item: { expected: 0, complete: 0, excluded: 0, unstable: 0 },
    call: { expected: 0, evaluated: 0, parseInvalid: 0 },
    confusion: { correctAccepted: 0, correctRejected: 0, wrongAccepted: 0, wrongRejected: 0 },
    agreement: zeroRate,
    falseAccept: zeroRate,
    falseReject: zeroRate,
    instability: zeroRate,
    parserInvalid: zeroRate,
  };
  return {
    configuration: {
      verdictRule: "sole",
      k: 1,
      reduction: "strict-majority",
      measurementProfile: "binary-instrument@1",
      candidateClasses: ["factuality"],
      strata: ["core", "stress"],
      parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous",
      intervalAlpha: "0.05",
    },
    arms: Object.fromEntries(["arm-a", "arm-b", "arm-c", "arm-d"].map((armId, index) => [armId, {
      instrumentSha256: `sha256:${String(index + 1).repeat(64)}`,
      ...projection,
      byCandidateClass: { factuality: projection },
      byStratum: { core: projection, stress: projection },
    }])),
    itemDecisions: [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  };
}

function unpromptedBinaryClaim(): Record<string, unknown> {
  const qualification = zeroBinaryProjection();
  const digest = "a".repeat(64);
  return {
    claimSchema: BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
    scope: {
      draftId: "draft-1",
      benchmarkSha256: digest,
      taskCount: 0,
      arms: [],
      replicates: 1,
      venue: "self-run",
    },
    records: {
      benchmarkSha256: digest,
      runSha256: digest,
      matrixSha256: digest,
      reportSha256: digest,
      reportEnvelopeSha256: digest,
    },
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters: {},
      preregistered: true,
    },
    results: { perSubject: [{ subjectSha256: digest, results: qualification }] },
    completeness: {},
    attrition: {},
    conflicted: qualification.conflicted,
    assurance: {
      preset: "single",
      resolved: {
        independence: "disclosed",
        minVerdicts: 1,
        distinctEvaluator: false,
        verdictRule: "sole",
      },
      disclosure: "self-run",
    },
    disclosures: {
      perSubject: [],
      integrityTierCounts: { "re-derivable": 0, "attested-only": 0 },
      pinningUnverifiableCounts: { harness: 0, model: 0, loadout: 0, isolation: 0 },
    },
    limitations: [],
    venueHonesty: {},
    verification: {
      command: BINARY_QUALIFICATION_VERIFICATION_COMMAND,
      compatibleCommand: "npx @colophon-claims/verify@0.1 <bundle-dir>",
      checks: [
        "manifest",
        "evidence-closure",
        "trust",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ],
      trustRoot: "self-run",
    },
    qualification,
  };
}

describe("released verify@0.1.0 vs prompted-screening public-bundle/2", () => {
  test("the vendored tarball is the published 0.1.0 reader", () => {
    const bytes = readFileSync(TARBALL);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(RELEASED_VERIFY_0_1_0_SHA256);
    const manifest = JSON.parse(extractFromReleasedTarball("package/package.json")) as {
      readonly name: string;
      readonly version: string;
      readonly gitHead: string;
    };
    expect(manifest.name).toBe("@colophon-claims/verify");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.gitHead).toBe("2f249073718111afd810127ff7bbbc19b206dc93");
  });

  test("0.1.0 claim-package/1 returns without inspecting verification.command", () => {
    const claimJs = extractFromReleasedTarball("package/dist/profile/claim.js");
    expect(claimJs).toContain("parameters: z.record(z.string(), z.unknown())");
    expect(claimJs).not.toContain("promptedScreening");
    const v1 = claimJs.indexOf("if (claim.claimSchema === CLAIM_PACKAGE_SCHEMA_ID)");
    expect(v1, "claim-package/1 refine").toBeGreaterThan(-1);
    const next = claimJs.indexOf("if (claim.method.id !== BENCHMARKING_METHOD_IDS.binaryInstrument", v1);
    expect(next).toBeGreaterThan(v1);
    const v1Branch = claimJs.slice(v1, next);
    expect(v1Branch).toContain("return;");
    expect(v1Branch).not.toContain("verification.command");
    expect(v1Branch).not.toContain("must pin verifier");
    const binaryPin = claimJs.indexOf("binary claim package must pin verifier 0.1.0/@0.1");
    expect(binaryPin, "claim-package/2 still pins 0.1.0").toBeGreaterThan(next);
  });

  test("a prompted public-bundle/2 claim is admitted and its assets name @0.2.1", async () => {
    const goldenClaim = JSON.parse(
      readFileSync(join(GOLDEN_BUNDLE_DIR, "claim-package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(goldenClaim["claimSchema"]).toBe(CLAIM_PACKAGE_SCHEMA_ID);
    const prompted = promptedPublicBundle2Claim(goldenClaim);
    expect(ClaimPackageSchema.safeParse(prompted).success).toBe(true);

    const facts = await goldenInput(BUNDLE_FORMAT);
    const assets = buildPublicAssets({ ...facts, claim: prompted as typeof facts.claim });
    const html = decoder.decode(assets["index.html"]!);
    const share = decoder.decode(assets["share.txt"]!);
    expect(html).toContain("npx @colophon-claims/verify@0.2.1 &lt;bundle-dir&gt;");
    expect(html).toContain("npx @colophon-claims/verify@0.2 &lt;bundle-dir&gt;");
    expect(share).toContain("@colophon-claims/verify@0.2.1");
    expect(html).not.toContain("npx @colophon-claims/verify@0.1.0");
  });

  test("the same pin on claim-package/2 is still a refusal, matching @0.1 vs prompted /4", () => {
    const promptedBinary = promptedPublicBundle2Claim(unpromptedBinaryClaim());
    expect(promptedBinary["claimSchema"]).toBe(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
    expect(ClaimPackageSchema.safeParse(promptedBinary).success).toBe(true);
    const wrongLine = {
      ...promptedBinary,
      verification: {
        ...(promptedBinary["verification"] as Record<string, unknown>),
        command: BINARY_QUALIFICATION_VERIFICATION_COMMAND,
      },
    };
    expect(ClaimPackageSchema.safeParse(wrongLine).success).toBe(false);
  });
});
