// SPDX-License-Identifier: MIT

/**
 * The admission gate (product design §7.3).
 *
 * > A candidate enters the population when: manifest validates (substrate §5.3); the policy
 * > materializes digest-correct through the provisioner; the tuple byte-shares the campaign's
 * > `frozenAxes` and mutates only within `mutationSurface`; the held-out lexical scan passes; an
 * > optional smoke canary (small dev subset) completes. **Admission asserts *usable*, never
 * > *better*.**
 *
 * Nothing here scores, ranks, or estimates. Every branch is a yes/no about a document or a package.
 *
 * ## Shape
 *
 * `admitCandidate` **returns** a result; it does not throw on rejection. A rejection is a product
 * decision the campaign journals (§5.2's `candidate-rejected`) and continues past — a proposer
 * emitting eight variants of which six are junk is the normal case, not an exception. Malformed
 * *inputs* (a campaign document that is not a campaign) still throw, because those are programming
 * errors rather than candidate defects.
 *
 * ## Order
 *
 * Cheap and local first, expensive and world-touching last: manifest → signature → evidence bundle
 * → axes → materialize → paths → lexical scan → consent → canary → population. Two reasons, both
 * stated because the order is a security property rather than a performance one.
 *
 * - The canary **runs the candidate's code** (§7.4). It must sit behind the consent gate, so an
 *   unconsented hostile payload is never executed to find out whether it works.
 * - The lexical scan sits behind materialization because it scans the *materialized bodies*, not
 *   the manifest's prose. A scan of `declaredChanges.summary` alone would be a scan of the one
 *   string a contaminated proposer controls entirely.
 *
 * Every check that ran is reported whatever the outcome; checks after the first failure are
 * reported `skipped` rather than omitted, so the report's shape does not depend on where it failed.
 */

import {
  assertMaterializable,
  canonicalJsonText,
  hashTreeLearnerPublicV1,
  parseExactCandidateManifest,
  PolicyIdentityError,
  prefixedDigest,
  tupleDigest,
  type CandidateManifest,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import { checkCandidateAgainstCampaign } from "../arms.js";
import { issue, type PolicyOptimizationIssue } from "../errors.js";
import { provenanceMatchesBundle } from "../evidence-bundle/bundle.js";
import { assertValidBoundary, scanLexical } from "../evidence-bundle/held-out.js";
import { CORE_AXES } from "../tokens.js";
import type { JsonValue } from "../types.js";
import { classifyPayload } from "./payload-class.js";
import { admitToPopulation, armIdForTuple } from "./population.js";
import type {
  AdmissionCheck,
  AdmissionCheckName,
  AdmissionRequest,
  AdmissionResult,
} from "./types.js";

/** The order the report lists checks in, and the order they run in. */
const CHECK_ORDER: readonly AdmissionCheckName[] = [
  "manifest",
  "signature",
  "evidence-bundle",
  "frozen-axes",
  "mutation-surface",
  "materialization",
  "mutable-paths",
  "lexical-scan",
  "payload-consent",
  "smoke-canary",
  "population",
];

class Report {
  private readonly results = new Map<AdmissionCheckName, AdmissionCheck>();

  pass(name: AdmissionCheckName, detail: string): void {
    this.results.set(name, { name, status: "pass", detail });
  }

  skip(name: AdmissionCheckName, detail: string): void {
    this.results.set(name, { name, status: "skipped", detail });
  }

  fail(
    name: AdmissionCheckName,
    detail: string,
    issues: readonly PolicyOptimizationIssue[],
  ): AdmissionCheck {
    const check: AdmissionCheck = { name, status: "fail", detail, issues };
    this.results.set(name, check);
    return check;
  }

  /** Every check in `CHECK_ORDER`; anything never reached is `skipped` with a stated reason. */
  finish(skippedReason: string): readonly AdmissionCheck[] {
    return CHECK_ORDER.map((name) => this.results.get(name)
      ?? { name, status: "skipped" as const, detail: skippedReason });
  }
}

function loadoutOf(manifest: CandidateManifest): Record<string, unknown> {
  const loadout = manifest.policy.loadout;
  return typeof loadout === "object" && loadout !== null && !Array.isArray(loadout)
    ? (loadout as unknown as Record<string, unknown>)
    : {};
}

/** Every text byte a candidate's bodies carry, joined for one scan pass. */
function scannableText(entries: readonly TreeEntry[], manifest: CandidateManifest): string {
  return [
    ...entries.map((entry) => `${entry.path}\n${entry.content ?? ""}`),
    manifest.declaredChanges.summary,
    ...manifest.declaredChanges.touchedComponents,
  ].join("\n");
}

/**
 * Ruling R2's additive per-file check.
 *
 * Axis-level `mutationSurface` says a candidate may vary its loadout; it says nothing about *which
 * files inside* the loadout. This closes that when a caller declares prefixes — a candidate that
 * repinned its loadout by rewriting `hooks/` while declaring it only touched `skills/` passes the
 * axis check and fails here.
 *
 * Byte comparison, not digest comparison: `learner-public.v1` is blind to four roots, so a
 * digest-level diff cannot see a change under `.git/`. (Such a package is refused at materialization
 * anyway; the two checks agreeing is the point.)
 */
function mutablePathIssues(
  parent: readonly TreeEntry[],
  candidate: readonly TreeEntry[],
  prefixes: readonly string[],
): readonly PolicyOptimizationIssue[] {
  const before = new Map(parent.map((entry) => [entry.path, entry.content ?? ""]));
  const after = new Map(candidate.map((entry) => [entry.path, entry.content ?? ""]));
  const changed = new Set<string>();
  for (const [path, content] of after) {
    if (before.get(path) !== content) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  const allowed = (path: string): boolean => prefixes.some((prefix) =>
    path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  return [...changed].sort().filter((path) => !allowed(path)).map((path) => issue(
    "mutation-surface",
    `policy.loadout.${path}`,
    `candidate changed ${path}, which is outside the declared mutable paths`,
  ));
}

export async function admitCandidate(request: AdmissionRequest): Promise<AdmissionResult> {
  assertValidBoundary(request.boundary, "boundary");
  const report = new Report();
  const reject = (
    name: AdmissionCheckName,
    detail: string,
    issues: readonly PolicyOptimizationIssue[],
  ): AdmissionResult => {
    report.fail(name, detail, issues);
    return {
      ok: false,
      checks: report.finish(`not reached: ${name} failed`),
      reason: issues[0]?.code ?? "invalid-document",
      errors: issues,
    };
  };

  // --- 1. manifest (substrate §5.3) ------------------------------------------------------------
  let manifest: CandidateManifest;
  try {
    manifest = parseExactCandidateManifest(request.manifestBytes);
  } catch (cause) {
    const errors = cause instanceof PolicyIdentityError
      ? cause.errors.map((e) => issue("manifest-invalid", e.path, `${e.code}: ${e.message}`))
      : [issue("manifest-invalid", "", String(cause))];
    return reject("manifest", "the sealed manifest did not validate", errors);
  }
  const manifestDigest = prefixedDigest(request.manifestBytes);
  report.pass("manifest", `manifest ${manifestDigest} validates and is its own sealed form`);

  // --- 2. signature (substrate §5.2; product §7.4) ----------------------------------------------
  const crossOperator = request.consent?.crossOperator ?? false;
  if (!crossOperator) {
    report.skip("signature", "same-operator candidate; unsigned manifests are valid for local use");
  } else if (request.signature === undefined) {
    return reject("signature", "a cross-operator candidate requires a verified DSSE signature", [
      issue("manifest-invalid", "signature",
        "cross-operator exchange and any adoption decision require the DSSE signature (substrate §5.2)"),
    ]);
  } else {
    const outcome = await request.signature.verify({
      manifestDigest, manifestBytes: request.manifestBytes, proposer: manifest.proposer,
    });
    if (!outcome.verified) {
      return reject("signature", "the proposer's signature did not verify", [
        issue("manifest-invalid", "signature", outcome.detail ?? "signature verification failed"),
      ]);
    }
    report.pass("signature", `signature binds to ${manifest.proposer}`);
  }

  // --- 3. evidence bundle (ruling R5) -----------------------------------------------------------
  const matched = request.issuedBundles.find(
    (bundle) => provenanceMatchesBundle(manifest.evidenceProvenance, bundle),
  );
  if (matched === undefined) {
    return reject("evidence-bundle",
      "the manifest's evidenceProvenance is not one this campaign issued", [
        issue("evidence-bundle-mismatch", "evidenceProvenance",
          "a candidate is admitted only against a bundle assembled under a declared held-out boundary (ruling R5); "
          + `this manifest names saved query ${manifest.evidenceProvenance.savedQueryDigest} and record list `
          + `${manifest.evidenceProvenance.recordListDigest}, which no issued bundle matches`),
      ]);
  }
  report.pass("evidence-bundle",
    `provenance matches the bundle filtered against boundary ${matched.heldOutBoundary.digest}`);

  // --- 4/5. frozen axes and mutation surface (§5.1, §7.3) ---------------------------------------
  // Re-uses the wave engine's own check so the population and the arms cannot disagree about what
  // the campaign requires: one rule, one implementation, checked at both boundaries.
  const armTupleDigest = tupleDigest(manifest.policy);
  const axisIssues = checkCandidateAgainstCampaign(request.campaign, {
    armId: armIdForTuple(armTupleDigest),
    tupleDigest: armTupleDigest,
    tuple: manifest.policy,
    source: { kind: "candidate", digest: manifestDigest },
  }, "policy");
  const frozenIssues = axisIssues.filter((entry) => entry.code === "frozen-axis-disagreement");
  if (frozenIssues.length > 0) {
    return reject("frozen-axes", "the tuple does not byte-share the campaign's frozen axes", frozenIssues);
  }
  report.pass("frozen-axes",
    `byte-shares ${Object.keys(request.campaign.frozenAxes).sort().join(", ") || "no frozen axes"}`);

  const surfaceIssues = [...axisIssues.filter((entry) => entry.code !== "frozen-axis-disagreement")];
  const frozen = new Set(Object.keys(request.campaign.frozenAxes));
  const mutable = new Set(request.campaign.mutationSurface);
  for (const axis of Object.keys(manifest.policy)) {
    if (axis === "formatToken" || frozen.has(axis) || mutable.has(axis)) continue;
    // A core axis the campaign neither froze nor opened is unchecked by construction: nothing
    // compares it across arms, so a difference on it is a confound the Run cannot see. `null` is
    // exempt — an unconstrained axis varies nothing.
    if (manifest.policy[axis] === null) continue;
    surfaceIssues.push(issue("unclassified-axis", `policy.${axis}`,
      (CORE_AXES as readonly string[]).includes(axis)
        ? `core axis ${axis} is neither frozen nor mutable; nothing would compare it across arms`
        : `profile axis ${axis} is neither frozen nor mutable; nothing would compare it across arms`));
  }
  if (surfaceIssues.length > 0) {
    return reject("mutation-surface", "the tuple mutates outside the campaign's mutation surface",
      surfaceIssues);
  }
  report.pass("mutation-surface", `mutates only ${[...mutable].sort().join(", ")}`);

  // --- 6. digest-correct materialization (§7.3; substrate §4.2) ---------------------------------
  const loadout = loadoutOf(manifest);
  const pinnedDigest = loadout["digest"];
  let entries: readonly TreeEntry[];
  try {
    entries = await request.materializer.materialize({ loadout, manifestDigest });
  } catch (cause) {
    return reject("materialization", "the provisioner refused the candidate package", [
      issue("materialization-mismatch", "policy.loadout",
        cause instanceof Error ? cause.message : String(cause)),
    ]);
  }
  let materializedDigest: string;
  try {
    // Both substrate §4.2 controls, run HERE and not delegated to the port.
    //
    // `assertMaterializable` refuses a package carrying a profile-ignored root; `hashTreeLearnerPublicV1`
    // refuses an unclassified root, a symlink, and a special file. A conforming provisioner runs the
    // first one too, and running it again is not redundancy: the digest is *blind* to `.git/`, so a
    // smuggled `.git/hooks/post-checkout` produces a package that digest-verifies perfectly (the test
    // asserts exactly that byte-equality). If the only refusal lived behind the port, an admission
    // gate holding a non-conforming or hostile materializer would admit the package and the canary
    // would fire the hook. The refusal is the control (F-C7c-5).
    assertMaterializable(entries);
    materializedDigest = `sha256:${hashTreeLearnerPublicV1(entries)}`;
  } catch (cause) {
    const errors = cause instanceof PolicyIdentityError
      ? cause.errors.map((e) => issue("materialization-mismatch", `policy.loadout.${e.path}`,
        `${e.code}: ${e.message}`))
      : [issue("materialization-mismatch", "policy.loadout", String(cause))];
    return reject("materialization", "the materialized package is not a valid harness-state tree", errors);
  }
  if (materializedDigest !== pinnedDigest) {
    return reject("materialization", "the materialized package is not the one the tuple pins", [
      issue("materialization-mismatch", "policy.loadout.digest",
        `the tuple pins ${String(pinnedDigest)}; the package materializes to ${materializedDigest}`),
    ]);
  }
  report.pass("materialization", `materializes digest-correct to ${materializedDigest}`);

  // --- 7. ruling R2's additive path-granular check ----------------------------------------------
  if (request.mutablePaths === undefined) {
    report.skip("mutable-paths", "axis-level mutation surface only; no path prefixes declared (ruling R2)");
  } else {
    const pathIssues = mutablePathIssues(
      request.mutablePaths.parentTree, entries, request.mutablePaths.prefixes,
    );
    if (pathIssues.length > 0) {
      return reject("mutable-paths", "the candidate changed paths outside the declared mutable set",
        pathIssues);
    }
    report.pass("mutable-paths",
      `changes confined to ${[...request.mutablePaths.prefixes].sort().join(", ")}`);
  }

  // --- 8. the held-out lexical scan (§6.3) ------------------------------------------------------
  const hits = scanLexical(scannableText(entries, manifest), request.boundary);
  if (hits.length > 0) {
    return reject("lexical-scan", "the candidate's bodies name held-out identifiers", [
      issue("held-out-contamination", "policy.loadout",
        `candidate bodies name held-out identifiers: ${hits.join(", ")}`),
    ]);
  }
  report.pass("lexical-scan",
    `no held-out identifier appears in ${entries.length} materialized file(s) or the declared changes`);

  // --- 9. payload class and code-execution consent (§7.3, §7.4) ---------------------------------
  const payload = classifyPayload(entries, String(loadout["kind"] ?? ""));
  const approved = new Set(request.consent?.approvedPayloadClasses ?? []);
  const unapproved = payload.hostile.filter((entry) => !approved.has(entry));
  if ((crossOperator || request.consent?.requireExecutableChangeConsent === true)
    && unapproved.length > 0) {
    return reject("payload-consent",
      "the candidate carries executable payload classes the owner has not approved", [
        issue("payload-consent-required", "policy.loadout",
          `admitting this candidate runs its payload with the owner's privileges (§7.4); `
          + `unapproved class(es) ${unapproved.join(", ")} at ${payload.hostilePaths.join(", ")}`),
      ]);
  }
  report.pass("payload-consent", crossOperator
    ? `cross-operator candidate; highest class ${payload.highest} is approved`
    : request.consent?.requireExecutableChangeConsent === true
      ? `live local candidate; executable classes through ${payload.highest} are explicitly approved`
      : `same-operator candidate; highest class ${payload.highest}`
        + (payload.hostile.length > 0
          ? " runs with the owner's privileges (§7.4 — isolation is vacuous)"
          : ""));

  // --- 10. the optional smoke canary (§7.3) -----------------------------------------------------
  if (request.smokeCanary === undefined) {
    report.skip("smoke-canary", "no canary configured; admission asserts usable, never better");
  } else {
    const outcome = await request.smokeCanary.run({ tupleDigest: armTupleDigest, manifestDigest });
    if (!outcome.completed) {
      return reject("smoke-canary", "the smoke canary did not complete", [
        issue("smoke-canary-failed", "smokeCanary", outcome.detail ?? "the canary did not complete"),
      ]);
    }
    report.pass("smoke-canary", outcome.detail ?? "canary completed");
  }

  // --- 11. the population, keyed by tupleDigest (§7.3) ------------------------------------------
  const admission = admitToPopulation(request.population, {
    tupleDigest: armTupleDigest, manifestDigest,
  });
  report.pass("population", admission.joinedExisting
    ? `joins existing arm ${admission.entry.armId}; attribution stays with ${admission.entry.attribution.digest}`
    : `mints arm ${admission.entry.armId}`);

  return {
    ok: true,
    checks: report.finish("not reached"),
    candidate: {
      armId: admission.entry.armId,
      tupleDigest: armTupleDigest,
      tuple: manifest.policy,
      // §7.3: "execution attribution goes to the first-admitted manifest". A second manifest for an
      // already-admitted tuple is journaled against the arm; it does not become the arm's source.
      source: admission.entry.attribution,
    },
    manifestDigest,
    payload,
    population: admission.population,
    entry: admission.entry,
    joinedExisting: admission.joinedExisting,
  };
}

/** The canonical text of a tuple — used by callers that journal what was admitted. */
export function admittedTupleText(manifest: CandidateManifest): string {
  return canonicalJsonText(manifest.policy as unknown as JsonValue);
}
