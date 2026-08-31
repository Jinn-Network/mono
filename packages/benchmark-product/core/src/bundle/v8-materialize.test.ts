// SPDX-License-Identifier: Apache-2.0

/**
 * The disclosed anchored binary-qualification closure, end to end (issue #2839;
 * disclosure-specification-record design §6, §7, and test matrix §11 T1, T11, T12, T14-T18, T22).
 *
 * `benchmark-product-public-bundle/8` is v7's member list plus one `records/<sha256>.bin` carrying
 * the sealed disclosure-specification record, and its claim is `benchmark-product.claim-package/6` —
 * claim-package/5 plus the `disclosure` section.
 *
 * **The departure from the design, stated where an implementer will meet it.** The design (§6.5,
 * §12.2, ruling Q5) reserved this closure for the UNANCHORED qualified branch, on the premise that
 * anchoring and qualification could never combine. Issue #3205 dissolved that premise: the published
 * official bundle IS anchored and qualified, on `/7`. Allocating disclosure on the unanchored branch
 * would have forced the flagship to choose between its anchor and its disclosure record, so the
 * allocation follows the real material. A second, unanchored disclosed cell is deliberately NOT
 * built — it would double the enumeration that issue #2889 exists to kill.
 *
 * Both halves are exercised against ONE real fixture run: what the producer emits, and what the
 * standalone reader accepts and refuses when handed the copied directory.
 *
 * Every declaration string is synthetic placeholder prose written for this fixture (design R7).
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DISCLOSURE_SPECIFICATION_EXTENSION,
  parseDisclosureSpecification,
} from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { verifyPublicBundle } from "@colophon-claims/verify";
import {
  ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  DISCLOSED_CLAIM_PACKAGE_SCHEMA_ID,
} from "../report/claim.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { BUNDLE_V7_FORMAT, BUNDLE_V8_FORMAT, buildBundleManifest } from "./manifest.js";
import { PUBLIC_BUNDLE_V4_FILES } from "./materialize.js";
import {
  createSyntheticV4BundleFixture,
  type SyntheticV4BundleFixture,
} from "./testing/v4-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let disclosedFixture: Promise<SyntheticV4BundleFixture> | undefined;

/** One real anchored, qualification-projecting, DISCLOSED run, built once: lock → anchor → launch →
 * collect → disclosure declare → report → materialize, all through the production operations. Tamper
 * tests copy the produced directory rather than mutating it. */
function disclosed(): Promise<SyntheticV4BundleFixture> {
  if (disclosedFixture === undefined) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "disclosed-v8-"));
    disclosedFixture = createSyntheticV4BundleFixture({
      workspaceDir,
      truthAdmission: "operator-only",
      anchorLock: true,
      declareDisclosure: true,
    });
  }
  return disclosedFixture;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

function copyBundle(bundleDir: string, label: string): string {
  const copy = mkdtempSync(join(tmpdir(), `disclosed-v8-tamper-${label}-`));
  roots.push(copy);
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

/** Re-signs the manifest over the tampered tree, so what the reader refuses is the semantic
 * inconsistency and not a stale digest it would have caught anyway. */
function rewriteManifest(
  bundleDir: string,
  format: typeof BUNDLE_V8_FORMAT | typeof BUNDLE_V7_FORMAT,
  paths?: readonly string[],
): void {
  const prior = json(bundleDir, "bundle.json");
  const files = paths ?? (prior.files as Array<{ path: string }>).map((entry) => entry.path);
  writeFileSync(join(bundleDir, "bundle.json"), buildBundleManifest(bundleDir, [...files], { format }).bytes);
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

function disclosureRecordPath(fixture: SyntheticV4BundleFixture): string {
  const extension = json(fixture.bundle.bundleDir, "report.json")[DISCLOSURE_SPECIFICATION_EXTENSION];
  return `records/${extension.digest.sha256 as string}.bin`;
}

describe("disclosed bundle v8 — producer (T1)", () => {
  test("a declared, anchored, qualification-projecting run publishes on v8 with a claim-package/6 claim", async () => {
    const built = await disclosed();

    expect(json(built.bundle.bundleDir, "bundle.json").format).toBe(BUNDLE_V8_FORMAT);
    // v7's complete member list survives: nothing is dropped, and no new MANDATORY member appears —
    // the record travels at the already-allowlisted `records/<sha256>.bin` path.
    for (const path of PUBLIC_BUNDLE_V4_FILES) expect(built.bundle.files).toContain(path);
    expect(built.bundle.files.filter((path) => path.startsWith("anchors/"))).toHaveLength(1);

    // The Report carries the extension, under the report author's own signature.
    const report = json(built.bundle.bundleDir, "report.json");
    const extension = report[DISCLOSURE_SPECIFICATION_EXTENSION];
    expect(extension.mediaType).toBe("application/vnd.jinn.disclosure-specification.v1+json");
    expect(extension.digest.sha256).toMatch(/^[a-f0-9]{64}$/u);

    // The record is carried, digest-addressed, and is exactly what the extension names.
    const recordBytes = new Uint8Array(readFileSync(join(built.bundle.bundleDir, disclosureRecordPath(built))));
    expect(sha256Hex(recordBytes)).toBe(extension.digest.sha256);
    const record = parseDisclosureSpecification(recordBytes);
    expect(record.author).toBe(report.author);
    expect(record.subject.digest.sha256).toBe(json(built.bundle.bundleDir, "claim-package.json").records.matrixSha256);

    // The evidence catalog declares exactly the one role, and no second.
    const catalogEntry = (json(built.bundle.bundleDir, "evidence.json").records as Array<{ sha256: string; roles: string[] }>)
      .find((entry) => entry.sha256 === extension.digest.sha256);
    expect(catalogEntry?.roles).toEqual(["disclosure-specification"]);

    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.claimSchema).toBe(DISCLOSED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.disclosure.recordSha256).toBe(extension.digest.sha256);
    expect(claim.disclosure.specification).toBe("https://spec.jinn.network/disclosure/six-variable/v1");
    // The SET, not the order: `claim-package.json` is canonical JSON, so its object keys are sorted
    // lexicographically on disk regardless of the order the projection built them in. The frozen
    // six-variable order is a property of `deriveDisclosureSpecification`'s output object and is
    // asserted there (`verify/src/profile/disclosure.test.ts`); what matters here is that all six
    // are present and no seventh is.
    expect(Object.keys(claim.disclosure.variables).sort()).toEqual([
      "answer-model", "answer-prompt", "ingestion-model", "judge-model", "judge-prompt", "retrieval-config",
    ]);
    // /6 is /5 plus a section: the qualification projection and the anchors section are unchanged.
    expect(claim.qualification).toEqual(claim.results.perSubject[0].results);
    expect(claim.anchors).toHaveLength(1);
    expect(claim.verification.checks).toEqual([
      "manifest", "evidence-closure", "trust", "matrix-rederivation",
      "report-verification", "claim-consistency", "integrity-anchors", "disclosure-specification",
    ]);

    // T22: `qualification.json` names the projection SHAPE, which is claim-package/2's on every
    // binary allocation, so the frozen literal does not move onto the new closure.
    expect(json(built.bundle.bundleDir, "qualification.json").claimSchema)
      .toBe(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
  }, 900_000);

  test("T16 — the same fixture with no declaration still emits v7, claim-package/5, and seven checks", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "undisclosed-v7-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV4BundleFixture({
      workspaceDir, truthAdmission: "operator-only", anchorLock: true,
    });

    expect(json(built.bundle.bundleDir, "bundle.json").format).toBe(BUNDLE_V7_FORMAT);
    const claim = json(built.bundle.bundleDir, "claim-package.json");
    expect(claim.claimSchema).toBe(ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim.disclosure).toBeUndefined();
    expect(claim.verification.checks).toHaveLength(7);
    expect(json(built.bundle.bundleDir, "report.json")[DISCLOSURE_SPECIFICATION_EXTENSION]).toBeUndefined();
    expect((json(built.bundle.bundleDir, "evidence.json").records as Array<{ roles: string[] }>)
      .some((entry) => entry.roles.includes("disclosure-specification"))).toBe(false);
    await expect(verifyPublicBundle(built.bundle.bundleDir)).resolves.toMatchObject({ format: BUNDLE_V7_FORMAT });
  }, 900_000);
});

describe("disclosed bundle v8 — the standalone reader (T1)", () => {
  test("verifies the copied bundle on all eight checks, disclosure-specification last", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "clean");

    const verified = await verifyPublicBundle(copy);
    expect(verified.format).toBe(BUNDLE_V8_FORMAT);
    expect(verified.checks).toEqual([
      "manifest", "evidence-closure", "trust", "matrix-rederivation",
      "report-verification", "claim-consistency", "integrity-anchors", "disclosure-specification",
    ]);
    // Statuses are DISCLOSED FACTS, never folded into a badge and never counted (design §8).
    const disclosure = (verified as { disclosure?: { statuses: Record<string, string> } }).disclosure;
    expect(disclosure?.statuses).toEqual({
      "ingestion-model": "undisclosed",
      "retrieval-config": "undisclosed",
      "answer-model": "disclosed-by-publisher",
      "answer-prompt": "disclosed-by-publisher",
      "judge-model": "measured-here",
      "judge-prompt": "measured-here",
    });
    // The qualification and anchor disclosures both survive onto the disclosed closure.
    expect(verified).toMatchObject({ qualification: { truthAdmission: "operator-only" } });
    expect((verified as { anchors?: { anchors: readonly unknown[] } }).anchors?.anchors).toHaveLength(1);
  }, 900_000);

  test("T15 — one edited byte in the record refuses at the manifest, before any semantic check", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "record-byte");
    const path = disclosureRecordPath(built);
    const record = JSON.parse(readFileSync(join(copy, path), "utf8")) as Record<string, unknown>;
    (record.variables as Record<string, { reason: string }>)["ingestion-model"].reason = "outside-this-experiment";
    writeFileSync(join(copy, path), canonicalJsonBytes(record));

    // The manifest authenticates every member's digest AND byte length before any semantic check
    // runs, so an edit that changes the record's size never reaches the disclosure check at all.
    expect((await refusal(copy)).message).toMatch(/byte length mismatch|digest mismatch/i);
  }, 900_000);

  test("an edited record whose manifest was re-signed refuses at the extension digest", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "record-resigned");
    const path = disclosureRecordPath(built);
    const record = JSON.parse(readFileSync(join(copy, path), "utf8")) as Record<string, unknown>;
    (record.variables as Record<string, { reason: string }>)["ingestion-model"].reason = "outside-this-experiment";
    writeFileSync(join(copy, path), canonicalJsonBytes(record));
    rewriteManifest(copy, BUNDLE_V8_FORMAT);

    // The record's own digest is its filename, so the evidence walk catches it before the check.
    expect((await refusal(copy)).path).toBe(path);
  }, 900_000);

  test("a stripped record — the bundle keeping the closure but dropping what it names — refuses", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "stripped");
    const path = disclosureRecordPath(built);
    const manifest = json(copy, "bundle.json");
    const remaining = (manifest.files as Array<{ path: string }>)
      .map((entry) => entry.path).filter((entry) => entry !== path);
    rmSync(join(copy, path), { force: true });
    rewriteManifest(copy, BUNDLE_V8_FORMAT, remaining);

    expect((await refusal(copy)).path).toBe(path);
  }, 900_000);

  test("T14 — one edited status in the claim's disclosure section refuses at claim-consistency", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "claim-status");
    const claim = json(copy, "claim-package.json");
    // The most dangerous single edit this record exists to prevent: an assertion promoted to a
    // measurement. It must not survive, and it must not survive quietly.
    claim.disclosure.variables["answer-model"] = {
      status: "measured-here",
      statement: "An assertion promoted to a measurement.",
      evidence: claim.disclosure.variables["judge-model"].evidence,
    };
    writeFileSync(join(copy, "claim-package.json"), canonicalJsonBytes(claim));
    rewriteManifest(copy, BUNDLE_V8_FORMAT);

    // `claim-consistency` rebuilds the whole claim from the RECORD's own bytes and byte-compares, so
    // the edit is caught by the projection equality the design's §7 step 10 asks for — no second
    // bespoke comparison exists, and the refusal names the field that differs.
    const refused = await refusal(copy);
    expect(refused.path).toBe("claim-consistency");
    expect(refused.message).toMatch(/disclosure/);
  }, 900_000);

  test("a claim whose disclosure section was removed entirely refuses", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "claim-stripped");
    const claim = json(copy, "claim-package.json");
    delete claim.disclosure;
    writeFileSync(join(copy, "claim-package.json"), canonicalJsonBytes(claim));
    rewriteManifest(copy, BUNDLE_V8_FORMAT);

    // Refused at the schema, before consistency: /6 has no legal section-omitted form.
    expect((await refusal(copy)).path).toBe("claim-package.json");
  }, 900_000);

  test("T22 — moving the frozen qualification literal onto the new closure refuses", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "qualification-literal");
    const qualification = json(copy, "qualification.json");
    qualification.claimSchema = DISCLOSED_CLAIM_PACKAGE_SCHEMA_ID;
    writeFileSync(join(copy, "qualification.json"), canonicalJsonBytes(qualification));
    rewriteManifest(copy, BUNDLE_V8_FORMAT);

    expect((await refusal(copy)).path).toBe("qualification.json");
  }, 900_000);

  test("T11b/T12 — a disclosure record smuggled into a v7 bundle refuses, extension or no extension", async () => {
    const built = await disclosed();

    // (a) The whole disclosed bundle re-labelled `/7`. The Report still carries the extension, which
    // G0 — the closure-independent guard — refuses before any format branch runs.
    const relabelled = copyBundle(built.bundle.bundleDir, "relabelled");
    rewriteManifest(relabelled, BUNDLE_V7_FORMAT);
    const relabelledRefusal = await refusal(relabelled);
    expect(relabelledRefusal.path).toBe("report.json");
    expect(relabelledRefusal.message).toMatch(/publishable only on benchmark-product-public-bundle\/8/);

    // (b) The record and its catalog entry carried into an UNDISCLOSED v7 bundle, whose Report has
    // no extension. Nothing derives the role there, so the evidence closure's own reachability guard
    // refuses it — no bespoke check involved.
    const workspaceDir = mkdtempSync(join(tmpdir(), "undisclosed-v7-smuggle-"));
    roots.push(workspaceDir);
    const plain = await createSyntheticV4BundleFixture({
      workspaceDir, truthAdmission: "operator-only", anchorLock: true,
    });
    const smuggled = copyBundle(plain.bundle.bundleDir, "smuggled");
    const recordPath = disclosureRecordPath(built);
    cpSync(join(built.bundle.bundleDir, recordPath), join(smuggled, recordPath));
    const catalog = json(smuggled, "evidence.json");
    (catalog.records as Array<{ sha256: string; roles: string[] }>).push({
      sha256: recordPath.slice("records/".length, -".bin".length),
      roles: ["disclosure-specification"],
    });
    (catalog.records as Array<{ sha256: string }>).sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
    writeFileSync(join(smuggled, "evidence.json"), canonicalJsonBytes(catalog));
    const manifest = json(smuggled, "bundle.json");
    rewriteManifest(
      smuggled,
      BUNDLE_V7_FORMAT,
      [...(manifest.files as Array<{ path: string }>).map((entry) => entry.path), recordPath],
    );

    expect((await refusal(smuggled)).path).toBe("evidence-closure");
  }, 900_000);

  test("T12b — the role appended to an EXISTING graph record's array on a v7 bundle refuses too", async () => {
    // T12a (above) and T12b are complements and both are required: they trip DIFFERENT refusals. A
    // standalone extra record makes `declaredRoles` exceed `expectedRoles` and fails the size
    // compare; a role appended to a record the graph already reaches leaves the sizes equal, so the
    // per-digest role compare is what fires. Neither is a bespoke guard added by this packet.
    const workspaceDir = mkdtempSync(join(tmpdir(), "undisclosed-v7-append-"));
    roots.push(workspaceDir);
    const plain = await createSyntheticV4BundleFixture({
      workspaceDir, truthAdmission: "operator-only", anchorLock: true,
    });
    const copy = copyBundle(plain.bundle.bundleDir, "appended-role");
    const catalog = json(copy, "evidence.json");
    const entries = catalog.records as Array<{ sha256: string; roles: string[] }>;
    const target = entries.find((entry) => entry.roles.includes("judge-instrument"))!;
    // Appended, not inserted: the catalog schema requires the frozen role order, and
    // `disclosure-specification` is last in it.
    target.roles = [...target.roles, "disclosure-specification"];
    writeFileSync(join(copy, "evidence.json"), canonicalJsonBytes(catalog));
    rewriteManifest(copy, BUNDLE_V7_FORMAT);

    const refused = await refusal(copy);
    expect(refused.path).toBe("evidence-closure");
    expect(refused.message).toMatch(/roles do not equal its derived graph roles/);
  }, 900_000);

  test("T11a — a v8 bundle whose Report lost its extension refuses at the check's first step", async () => {
    const built = await disclosed();
    const copy = copyBundle(built.bundle.bundleDir, "extension-absent");
    const report = json(copy, "report.json");
    delete report[DISCLOSURE_SPECIFICATION_EXTENSION];
    writeFileSync(join(copy, "report.json"), canonicalJsonBytes(report));
    rewriteManifest(copy, BUNDLE_V8_FORMAT);

    // §7 step 1's own refusal, and it fires FIRST: the extension is read where the anchors are, so
    // the disclosed closure refuses a Report that does not name its record before the rest of the
    // graph is walked. (Had it not, the Report's DSSE envelope still covers the original payload, so
    // `report-verification` would have caught the same edit one step later — removing a key that is
    // under the author's signature is forgery before it is a missing extension.)
    const refused = await refusal(copy);
    expect(refused.path).toBe("disclosure-specification");
    expect(refused.message).toMatch(/must carry https:\/\/spec\.jinn\.network\/extensions\/disclosure-specification\/v1/);
  }, 900_000);
});
