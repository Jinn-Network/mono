// SPDX-License-Identifier: MIT

/**
 * The held-out boundary, and the two exclusion procedures it drives (product design §6.3;
 * program ruling R5).
 *
 * > **R5:** proposer-side evidence access is exclusion-filtered at the query layer
 * > (`excludeHeldOutSlate` on instance + repo, lexical scan on outputs); C7c wires the filter into
 * > bundle assembly — a passthrough is a blocker by definition.
 *
 * ## FINDING F-C7c-1 — the semantics are mirrored, the boundary is a port
 *
 * The shipped exclusion machinery lives in `operator/`: `excludeHeldOutSlate`
 * (`operator/src/solver-types/_swe-rebench-v2-held-out-slate.ts`, instance-id exclusion) and
 * `loadCapabilitySlateRepos` (`operator/src/eval/capability-slate.ts`, repo exclusion). This package
 * is tier 4 like `operator/`, but a *different* product, and the source-boundary guard denies
 * `operator/` outright. Three options were available:
 *
 * 1. Import it. Refused — the guard denies it, and lifting a `operator/` module into a product's
 *    dependency graph is exactly the tier-4-to-tier-4 edge the guard exists to make deliberate.
 * 2. Port the whole thing: the host supplies a `heldOut(record) => boolean` predicate. Refused —
 *    it makes the *rule* the host's, so a host that supplies a permissive predicate satisfies R5
 *    on paper while admitting the slate. R5 says a passthrough is a blocker; a predicate port is a
 *    passthrough with extra steps.
 * 3. **Chosen: mirror the semantics, port the boundary.** The comparison rules (instance-id
 *    equality, repo equality, the lexical scan) live here as pure code this package's tests pin.
 *    The *content* of the boundary — which instance ids, which repos, which identifiers — arrives
 *    as a `HeldOutBoundary` value, so nothing is hardcoded and the committed Benchmark's items are
 *    a legal source alongside a slate artifact (§6.3: "The committed Benchmark record is the
 *    **single go-forward representation** of a held-out boundary").
 *
 * **Drift note.** Two mirrored rules, and what would signal a drift:
 *
 * - Instance exclusion mirrors `excludeHeldOutSlate`: exact `instance_id` set membership. The
 *   upstream is a `Set<string>` lookup with no normalization; so is this.
 * - Repo exclusion mirrors `loadCapabilitySlateRepos` + the capability slate's `disjointness.repo`
 *   axis: exact repo-string set membership. The upstream reads `instances[].repo` verbatim; so
 *   does this.
 *
 * Neither upstream lowercases, trims, or canonicalizes, and neither does this. If either grows a
 * normalization step, this module is where the two surfaces diverge — the fixtures below pin the
 * exact-match semantics so the divergence is a test failure rather than a silent gap in a
 * promotion gate.
 *
 * The lexical scan has **no** upstream implementation to mirror: the capability slate's `lexical`
 * axis is `attestation: "self-attested"` — a human's claim, not code. What is here is therefore a
 * new, deliberately over-matching scan, described at `scanLexical`.
 */

import { canonicalJsonBytes, prefixedDigest } from "@jinn-network/policy-identity";
import { issue, refuse, type PolicyOptimizationIssue } from "../errors.js";
import type { JsonValue } from "../types.js";

/**
 * The exclusion boundary a bundle is assembled against.
 *
 * `source` names where the boundary came from so a journal entry and a post-reveal third-party
 * re-run (§6.3's named check) can address the same thing. It is a reference, never the items: the
 * boundary's *content* here is already the sensitive part, and a bundle manifest that inlined the
 * committed Benchmark's items would publish the gate it protects.
 */
export interface HeldOutBoundary {
  readonly source: {
    /** `benchmark` — a committed Benchmark record's revealed items. `slate` — a slate artifact. */
    readonly kind: "benchmark" | "slate";
    /** The Benchmark record digest, or the slate artifact's content hash. */
    readonly ref: string;
  };
  /** swe-rebench `instance_id`s. Compared by exact equality (drift note above). */
  readonly instanceIds: readonly string[];
  /** Repository identifiers. Compared by exact equality. */
  readonly repos: readonly string[];
  /**
   * Identifiers the lexical scan looks for in candidate policy bodies and evidence text. Normally
   * the union of `instanceIds` and `repos`, but kept separate because a boundary may legitimately
   * want to scan for a term it does not exclude records on (a package name, a fixture path).
   */
  readonly lexicalIdentifiers: readonly string[];
}

/**
 * One evidence record, described by the members the exclusion joins on and nothing else.
 *
 * `instanceId` and `repo` are optional in the *type* and required in *practice* whenever the
 * boundary is non-empty — see `partitionHeldOut`'s `unattributable` axis. Making them optional
 * here is what lets an empty boundary carry records that legitimately have neither.
 */
export interface EvidenceRecordRef {
  /** `sha256:<64 lowercase hex>` — the record's own digest. */
  readonly record: string;
  readonly instanceId?: string;
  readonly repo?: string;
}

/** Why one record is outside the bundle. */
export interface HeldOutHit {
  readonly record: string;
  /**
   * `instance` / `repo` — the record joins the boundary on that axis. `unattributable` — the
   * record carries neither an instance id nor a repo, so **nothing establishes that it is outside
   * the boundary**. Treating that as a pass is the failure mode R5 exists to prevent: an unlabelled
   * record is precisely how a slate item re-enters a bundle, and "we could not check" is not
   * "we checked and it was clean".
   */
  readonly axis: "instance" | "repo" | "unattributable";
  /** The boundary value that matched, or `""` for `unattributable`. */
  readonly value: string;
}

export interface HeldOutPartition {
  readonly kept: readonly EvidenceRecordRef[];
  readonly excluded: readonly HeldOutHit[];
}

const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

/**
 * `sha256:` over the boundary's canonical bytes.
 *
 * Journaled with every admission and carried on every bundle, so "which boundary was this filtered
 * against" is answerable after the fact. A campaign that widened its boundary mid-flight produces
 * bundles whose digests differ, which is the only way a reader could ever notice.
 */
export function heldOutBoundaryDigest(boundary: HeldOutBoundary): string {
  return prefixedDigest(canonicalJsonBytes(normalizeBoundary(boundary) as unknown as JsonValue));
}

/**
 * Sorted, de-duplicated members — so two spellings of one boundary produce one digest.
 *
 * Sorting is safe here and is *not* safe for a record list (see `bundle.ts`): a boundary is a set,
 * and a record list is an order the proposer actually consumed.
 */
function normalizeBoundary(boundary: HeldOutBoundary): {
  source: HeldOutBoundary["source"];
  instanceIds: string[];
  repos: string[];
  lexicalIdentifiers: string[];
} {
  const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();
  return {
    source: { kind: boundary.source.kind, ref: boundary.source.ref },
    instanceIds: unique(boundary.instanceIds),
    repos: unique(boundary.repos),
    lexicalIdentifiers: unique(boundary.lexicalIdentifiers),
  };
}

/** Fail-closed shape check. A malformed boundary is refused rather than silently narrowed. */
export function assertValidBoundary(boundary: unknown, path: string): asserts boundary is HeldOutBoundary {
  const errors = boundaryIssues(boundary, path);
  const [first] = errors;
  if (first !== undefined) refuse(first.code, first.path, first.message);
}

function boundaryIssues(boundary: unknown, path: string): readonly PolicyOptimizationIssue[] {
  const errors: PolicyOptimizationIssue[] = [];
  if (typeof boundary !== "object" || boundary === null || Array.isArray(boundary)) {
    return [issue("held-out-boundary", path, "a held-out boundary must be a JSON object")];
  }
  const value = boundary as Record<string, unknown>;
  const source = value["source"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    errors.push(issue("held-out-boundary", `${path}.source`, "a boundary must name its source"));
  } else {
    const kind = (source as Record<string, unknown>)["kind"];
    const ref = (source as Record<string, unknown>)["ref"];
    if (kind !== "benchmark" && kind !== "slate") {
      errors.push(issue("held-out-boundary", `${path}.source.kind`,
        'a boundary source kind must be "benchmark" or "slate"'));
    }
    if (typeof ref !== "string" || ref === "") {
      errors.push(issue("held-out-boundary", `${path}.source.ref`,
        "a boundary source must carry the reference it was read from"));
    }
  }
  for (const member of ["instanceIds", "repos", "lexicalIdentifiers"] as const) {
    const list = value[member];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || entry === "")) {
      errors.push(issue("held-out-boundary", `${path}.${member}`,
        `${member} must be an array of non-empty strings`));
    }
  }
  return errors;
}

/** Is this boundary empty on both record-joining axes? */
export function boundaryIsEmpty(boundary: HeldOutBoundary): boolean {
  return boundary.instanceIds.length === 0 && boundary.repos.length === 0;
}

/**
 * The query-layer filter (R5): split a record list into what may be consumed and what may not.
 *
 * Instance is checked before repo, so a record matching both is reported on the more specific
 * axis. `unattributable` applies only when the boundary is non-empty — an empty boundary excludes
 * nothing and has nothing to be unattributable *against*.
 *
 * Order is preserved in `kept`. A caller that filters and then assembles gets the same ordered
 * list it would have got from the query, minus the excluded records.
 */
export function partitionHeldOut(
  records: readonly EvidenceRecordRef[],
  boundary: HeldOutBoundary,
): HeldOutPartition {
  const instanceIds = new Set(boundary.instanceIds);
  const repos = new Set(boundary.repos);
  const empty = boundaryIsEmpty(boundary);
  const kept: EvidenceRecordRef[] = [];
  const excluded: HeldOutHit[] = [];

  for (const record of records) {
    if (record.instanceId !== undefined && instanceIds.has(record.instanceId)) {
      excluded.push({ record: record.record, axis: "instance", value: record.instanceId });
      continue;
    }
    if (record.repo !== undefined && repos.has(record.repo)) {
      excluded.push({ record: record.record, axis: "repo", value: record.repo });
      continue;
    }
    if (!empty && record.instanceId === undefined && record.repo === undefined) {
      excluded.push({ record: record.record, axis: "unattributable", value: "" });
      continue;
    }
    kept.push(record);
  }
  return { kept, excluded };
}

/** Fail-closed record-shape check, shared by the filter's callers and by bundle assembly. */
export function assertValidRecordRefs(
  records: readonly EvidenceRecordRef[],
  path: string,
): void {
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const at = `${path}.${index}`;
    if (typeof record?.record !== "string" || !SHA256_PREFIXED.test(record.record)) {
      refuse("invalid-document", `${at}.record`, "a record reference must be sha256:<64 lowercase hex>");
    }
    if (seen.has(record.record)) {
      // A repeated record is not a longer bundle; it is one record counted twice, and
      // `recordListDigest` would name a list that misrepresents what was consumed.
      refuse("invalid-document", at, `duplicate record reference ${record.record}`);
    }
    seen.add(record.record);
    for (const member of ["instanceId", "repo"] as const) {
      const value = record[member];
      if (value !== undefined && (typeof value !== "string" || value === "")) {
        refuse("invalid-document", `${at}.${member}`, `${member} must be a non-empty string when present`);
      }
    }
  });
}

/**
 * The lexical scan (§6.3): which of the boundary's identifiers appear in this text?
 *
 * There is no upstream implementation to mirror — the capability slate's lexical axis is a
 * self-attestation — so the rule is stated here in full and pinned by fixtures.
 *
 * - **Case-insensitive.** A candidate skill that writes `Astropy__Astropy-12907` has leaked the
 *   same identifier.
 * - **Left-boundary only.** A match must not be preceded by an identifier character
 *   (`[A-Za-z0-9_]`), so `xastropy` does not match `astropy`; but nothing is required to the
 *   *right*, so `astropy__astropy-12907.patch` does match `astropy__astropy-12907`.
 *
 * The asymmetry is deliberate and is the fail-closed direction: the scan over-matches rather than
 * under-matches. A false positive costs one candidate a re-word; a false negative admits a
 * contaminated policy body into a promotion gate, and §6.3's residual already concedes that no
 * mechanism catches an owner who wants past it. Over-matching is the only side of this trade the
 * product gets to choose.
 *
 * Returns the matched identifiers, sorted and de-duplicated — a report, not a boolean, so a
 * refusal can name what it found.
 */
export function scanLexical(text: string, boundary: HeldOutBoundary): readonly string[] {
  if (boundary.lexicalIdentifiers.length === 0 || text === "") return [];
  const haystack = text.toLowerCase();
  const matched = new Set<string>();
  for (const identifier of boundary.lexicalIdentifiers) {
    const needle = identifier.toLowerCase();
    if (needle === "") continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? "" : haystack[at - 1]!;
      if (before === "" || !/[a-z0-9_]/.test(before)) {
        matched.add(identifier);
        break;
      }
      from = at + 1;
    }
  }
  return [...matched].sort();
}
