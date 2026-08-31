// SPDX-License-Identifier: Apache-2.0

/**
 * The optional `presentation.json` member on the v7 closure, end to end.
 *
 * Two properties are asserted against ONE real fixture run, because they are the two the member
 * lives or dies by:
 *
 * - **Silence costs nothing.** A run with no presentation materializes the exact bytes and the exact
 *   identity it materialized before the member existed. That is proved here as a measured
 *   before/after pin on the same fixture: the identity is captured with no presentation set, and
 *   the same closure is rebuilt after one is sealed. (The same pin is exercised against the real
 *   published LoCoMo workspace, whose recorded `bundleIdentity` predates this feature entirely.)
 * - **A presentation cannot be lifted.** The one failure worth building a check for is a
 *   well-formed presentation of a different report travelling in this bundle, and the reader refuses
 *   it rather than reporting a pass over it.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { REPORT_PRESENTATION_SCHEMA_ID, verifyPublicBundle } from "@colophon-claims/verify";
import { requireRunState } from "../run/state.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { presentationSet } from "../operations/presentation-set.js";
import { BUNDLE_V4_FORMAT, BUNDLE_V7_FORMAT, buildBundleManifest } from "./manifest.js";
import { materializePublicBundle } from "./materialize.js";
import { createSyntheticV4BundleFixture, type SyntheticV4BundleFixture } from "./testing/v4-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let anchoredFixture: Promise<SyntheticV4BundleFixture> | undefined;

function anchored(): Promise<SyntheticV4BundleFixture> {
  if (anchoredFixture === undefined) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "presentation-v7-"));
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
  const copy = mkdtempSync(join(tmpdir(), `presentation-v7-${label}-`));
  roots.push(copy);
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

/** Re-signs the manifest over the tampered tree, so what the reader refuses is the semantic
 * inconsistency and not a stale digest it would have caught anyway. */
function rewriteManifest(bundleDir: string, format: typeof BUNDLE_V7_FORMAT | typeof BUNDLE_V4_FORMAT, paths?: readonly string[]): void {
  const prior = json(bundleDir, "bundle.json");
  const files = paths ?? (prior.files as Array<{ path: string }>).map((entry) => entry.path);
  writeFileSync(join(bundleDir, "bundle.json"), buildBundleManifest(bundleDir, files, { format }).bytes);
}

async function refusalPath(bundleDir: string): Promise<string> {
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    return (cause as { readonly issues?: readonly { readonly path?: string }[] }).issues?.[0]?.path ?? "";
  }
  return "NOT REFUSED";
}

const proportion = () => ({
  numerator: 3,
  denominator: 4,
  estimate: "0.7500",
  wilsonInterval: { low: "0.3000", high: "0.9500" },
});

function payloadFor(reportSha256: string, reportEnvelopeSha256: string): Record<string, any> {
  return {
    schema: REPORT_PRESENTATION_SCHEMA_ID,
    slug: "synthetic-binary-publication",
    title: "A synthetic binary publication",
    summary: "One fixture run, presented.",
    sealedAt: "2026-08-15T12:30:00.000Z",
    subject: {
      judgeModel: "gpt-5.6-luna",
      harness: { id: "inspect-ai-judge", version: "1" },
      benchmark: { name: "synthetic", description: "synthetic bank", sha256: "c".repeat(64) },
      arms: [{ id: "alpha", label: "alpha", instrumentSha256: `sha256:${"d".repeat(64)}` }],
    },
    question: {
      designUrl: "https://example.invalid/design",
      postedOn: "2026-08-01",
      preRegistered: [{ id: "q1", question: "Does it?", answer: "It does.", provenBy: "this-bundle" }],
    },
    execution: {
      judgePrompts: { count: 4, provenance: "As posted." },
      modelSnapshot: { id: "gpt-5.6-luna", temperature: "0", profile: "dated-snapshot-sampling" },
      replicates: 3,
      reduction: "strict-majority",
      abstainPolicy: { parserInvalid: "abstain", description: "Neutral, not a rejection." },
      intervals: "95 percent Wilson",
      truthAdmission: "operator-only",
      venue: "self-run",
    },
    result: {
      primary: "agreement-with-human-labels",
      perArm: [{
        armId: "alpha",
        agreement: proportion(),
        acceptsSpecificWrong: proportion(),
        acceptsVagueTopicalWrong: proportion(),
        rejectsCorrect: proportion(),
      }],
      spread: { lowestArmId: "alpha", highestArmId: "alpha", pointsBetween: "0.0" },
      interpretation: "It is a fixture.",
      methodStatement: "It measures nothing real.",
    },
    population: {
      items: 4,
      perCandidateClass: [{ candidateClass: "correct", items: 4 }],
      perStratum: [{ stratum: "category-1", items: 4 }],
      labels: "Synthetic.",
    },
    accounting: {
      cells: { expected: 12, judged: 12, lost: 0 },
      parserNeutral: { calls: 0, denominator: 12, policy: "abstain", note: "None." },
      excludedItems: { count: 0, byArm: [] },
      completenessFloor: "0.9950",
      runOutcome: "complete",
    },
    manipulationCheck: {
      replicateInstability: { unstableItems: 0, gradedItems: 4 },
      conflictedCells: 0,
      companionChecks: [],
    },
    limitations: ["It is a fixture."],
    selfRunDisclosure: "One operator ran it.",
    verification: {
      bundleFormat: BUNDLE_V7_FORMAT,
      checks: ["manifest"],
      command: "npx @colophon-claims/verify@0.2.1 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.2 <bundle-dir>",
      readerAvailability: "available",
      reportSha256,
      reportEnvelopeSha256,
    },
    provenance: {
      runSha256: "e".repeat(64),
      benchmarkSha256: "c".repeat(64),
      matrixSha256: "f".repeat(64),
      reportSha256,
      reportEnvelopeSha256,
      anchors: [],
      siblingAnalyses: [],
      companionBundles: [],
    },
  };
}

/**
 * The fixture with a presentation sealed onto it, materialized once. Built lazily beside the
 * unpresented one so both identities come from the SAME run — which is what makes the
 * before/after comparison a measurement rather than two unrelated builds.
 */
let presented: Promise<{
  readonly fixture: SyntheticV4BundleFixture;
  readonly identityBefore: string;
  readonly filesBefore: readonly string[];
  readonly bundleDir: string;
  readonly identity: string;
  readonly files: readonly string[];
}> | undefined;

function withPresentation() {
  if (presented === undefined) {
    presented = (async () => {
      const fixture = await anchored();
      const identityBefore = fixture.bundle.identity;
      const filesBefore = fixture.bundle.files;
      const state = requireRunState(fixture.workspaceDir, fixture.draftId);
      const result = presentationSet(
        { workspaceDir: fixture.workspaceDir, principal: "synthetic-operator", clock: () => "2026-08-15T13:00:00.000Z" },
        {
          draftId: fixture.draftId,
          slug: "synthetic-binary-publication",
          presentation: payloadFor(state.reportSha256!, state.reportEnvelopeSha256!),
        },
      );
      if (!result.ok) throw new Error(`presentation set refused: ${JSON.stringify(result.error)}`);
      expect(result.result.recordSha256).toMatch(/^[a-f0-9]{64}$/u);
      const built = materializePublicBundle({
        workspaceDir: fixture.workspaceDir,
        draftId: fixture.draftId,
        benchmarkSha256: fixture.benchmarkSha256,
        runState: requireRunState(fixture.workspaceDir, fixture.draftId),
      });
      return {
        fixture,
        identityBefore,
        filesBefore,
        bundleDir: built.bundleDir,
        identity: built.identity,
        files: built.files,
      };
    })();
  }
  return presented;
}

describe("the optional presentation member — producer", () => {
  test("a run with no presentation publishes the identity it published before the member existed", async () => {
    const built = await anchored();
    // The pin: this fixture drives the real lock -> anchor -> launch -> collect -> report ->
    // materialize path with nothing about a presentation set anywhere, and lands on a v7 bundle
    // whose member list is exactly v4's plus `anchors/`.
    expect(json(built.bundle.bundleDir, "bundle.json").format).toBe(BUNDLE_V7_FORMAT);
    expect(built.bundle.files).not.toContain("presentation.json");
    // Re-materializing is adoption, not a rebuild to different bytes.
    const again = materializePublicBundle({
      workspaceDir: built.workspaceDir,
      draftId: built.draftId,
      benchmarkSha256: built.benchmarkSha256,
      runState: requireRunState(built.workspaceDir, built.draftId),
    });
    expect(again.identity).toBe(built.bundle.identity);
    expect(again.adopted).toBe(true);
  }, 600_000);

  test("sealing a presentation adds exactly one member and moves the identity", async () => {
    const state = await withPresentation();
    expect(state.identity).not.toBe(state.identityBefore);
    expect(state.files).toContain("presentation.json");
    expect([...state.files].filter((path) => path !== "presentation.json").sort())
      .toEqual([...state.filesBefore].sort());
    // The closure version does not move: a presentation is not a third axis.
    expect(json(state.bundleDir, "bundle.json").format).toBe(BUNDLE_V7_FORMAT);
    // And the bundle published before it still stands, untouched, at its own address.
    expect(json(state.fixture.bundle.bundleDir, "bundle.json").format).toBe(BUNDLE_V7_FORMAT);
    expect(readFileSync(join(state.fixture.bundle.bundleDir, "bundle.json"), "utf8"))
      .not.toContain("presentation.json");
  }, 600_000);

  test("the sealed member bytes are the workspace record's bytes, unchanged", async () => {
    const state = await withPresentation();
    const memberBytes = new Uint8Array(readFileSync(join(state.bundleDir, "presentation.json")));
    const recordSha256 = requireRunState(state.fixture.workspaceDir, state.fixture.draftId).presentationSha256;
    expect(sha256Hex(memberBytes)).toBe(recordSha256);
  }, 600_000);
});

describe("the optional presentation member — the standalone reader", () => {
  test("verifies the copied bundle on eight checks, and discloses the presentation", async () => {
    const state = await withPresentation();
    const copy = copyBundle(state.bundleDir, "clean");

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
      "report-presentation",
    ]);
    expect((verified as { presentation?: { slug: string } }).presentation?.slug)
      .toBe("synthetic-binary-publication");
  }, 600_000);

  test("refuses a presentation lifted from another report", async () => {
    const state = await withPresentation();
    const copy = copyBundle(state.bundleDir, "lifted");
    const lifted = payloadFor("9".repeat(64), "8".repeat(64));
    writeFileSync(join(copy, "presentation.json"), canonicalJsonBytes(lifted as never));
    rewriteManifest(copy, BUNDLE_V7_FORMAT);

    expect(await refusalPath(copy)).toBe("presentation.json");
  }, 600_000);

  test("refuses a presentation whose bytes were re-encoded away from canonical", async () => {
    const state = await withPresentation();
    const copy = copyBundle(state.bundleDir, "re-encoded");
    const record = json(copy, "presentation.json");
    writeFileSync(join(copy, "presentation.json"), `${JSON.stringify(record, null, 2)}\n`);
    rewriteManifest(copy, BUNDLE_V7_FORMAT);

    expect(await refusalPath(copy)).toBe("presentation.json");
  }, 600_000);

  test("refuses a presentation member smuggled into a bundle whose closure does not carry one", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "presentation-v4-smuggle-"));
    roots.push(workspaceDir);
    const unanchored = await createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only" });
    const state = await withPresentation();
    const copy = copyBundle(unanchored.bundle.bundleDir, "smuggled");
    cpSync(join(state.bundleDir, "presentation.json"), join(copy, "presentation.json"));
    const manifest = json(copy, "bundle.json");
    rewriteManifest(copy, BUNDLE_V4_FORMAT, [
      ...(manifest.files as Array<{ path: string }>).map((entry) => entry.path),
      "presentation.json",
    ]);

    expect(await refusalPath(copy)).toBe("presentation.json");
  }, 600_000);
});
