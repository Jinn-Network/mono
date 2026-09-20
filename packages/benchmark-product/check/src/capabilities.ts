// SPDX-License-Identifier: Apache-2.0

/**
 * The capability registry: what a composed public bundle may declare, and everything a reader or
 * producer derives from the declaration (bundle-capability-composition design §3-§5, §7; issue
 * #3403).
 *
 * The pre-composition closures said what a bundle is by picking a format number, and each number
 * carried its own hand-written member list, check array, claim-package id, and reader row. The
 * composed generation states capability in the bundle instead: `bundle.json` carries an explicit,
 * canonically ordered, must-understand capability vector, and members, grammars, checks, claim
 * sections, and the minimum reader release are DERIVED from it here. This is the one module the
 * producer, the verifier, the claim builder, and every reader surface share, so no site re-spells
 * a member list or a check name.
 *
 * A registry entry states a capability's CARRIAGE. Its semantics -- what `integrity-anchors`
 * examines, what the qualification grammar admits -- stay where they already live. Registering a
 * token here without implementing it there cannot pass: the verifier compares the checks it ran
 * against `expectedChecks(vector)` for exact equality.
 *
 * **Not a plug-in surface** (design §12). The registry is compiled in. A bundle cannot introduce a
 * capability this build does not implement; that is the must-understand rule, and it is the point.
 */

import { z } from "zod";
import { DISCLOSURE_SPECIFICATION_EXTENSION, compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import {
  LEGACY_ANCHOR_MEMBER_PATTERN,
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_FILES,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
} from "./legacy-closures.js";
import { DISCLOSURE_SPECIFICATION_BUNDLE_ROLE } from "./profile/disclosure.js";
import { refuse } from "./profile/errors.js";
import type { PublicBundleVerificationCheck } from "./verify.js";

/**
 * The published reader releases a capability may name as its minimum, each with
 * the exact and compatible reader lines a claim pins for it. Aliases of the frozen commands rather
 * than fresh literals: those constants are what the publish guard checks against npm, so a release
 * cannot appear here without having been published.
 */
export const READER_RELEASE_LINES = {
  "0.1.0": {
    command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  },
  "0.2.1": {
    command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  },
} as const;

export type ReaderRelease = keyof typeof READER_RELEASE_LINES;

/**
 * The reader release the composed generation itself needs, whatever it declares: the base every
 * vector's minimum is taken against. No `0.1` reader understands the format, so a vector of
 * capabilities that `0.1.0` first implemented still cannot name that line.
 *
 * **Leftover (issue #3405):** `0.2.1` is the latest published reader and predates the composed
 * format, so it refuses one at manifest parse. The in-tree checker reads `/10`. A published npm
 * pin that serves `/10` does not exist yet; this packet does not publish one. The producer
 * default is `/10` anyway (D1). The cutover that publishes a release reading the format
 * repoints this.
 */
export const COMPOSED_FORMAT_MINIMUM_READER_RELEASE: ReaderRelease = "0.2.1";

/** A path shape a capability allowlists, e.g. `anchors/<sha256>.bin`. */
export interface CapabilityMemberPattern {
  readonly pattern: RegExp;
  /** Whether a bundle declaring the capability may carry no member of this shape. The one explicit
   * exception to "declared means present", opted into here rather than in the verifier. */
  readonly mayBeEmpty: boolean;
}

/**
 * An evidence-catalog role-derivation contribution (design §4, §5.1). `evidence-closure` is a
 * closed-world compare: a cataloged record must carry exactly the roles the graph derives for it.
 * A contribution widens the set of authenticated facts that can confer a role, and it is applied
 * only when its capability is declared -- so a record whose role only an UNDECLARED capability
 * could derive is refused as unreachable. Additive, never a refinement: it replaces no grammar.
 */
export interface CapabilityRoleDerivation {
  /** The evidence-catalog role this contribution confers on a record. */
  readonly role: string;
  /** The authenticated fact that derives the role for a record. The derivation itself runs inside
   * `evidence-closure`, where the capability's semantics live; this names what it reads. */
  readonly derivedFrom: string;
}

/** The run facts the producer-side activation predicates read. */
export interface CapabilityActivationFacts {
  /** The sealed Run carries at least one AnchorEvidence record, or declares anchoring intent. */
  readonly anchoredClosure: boolean;
  /** The analysis this bundle publishes projects a binary qualification. */
  readonly projectsBinaryQualification: boolean;
  /** The run carries a sealed disclosure-specification declaration. */
  readonly declaresDisclosure: boolean;
  /** The run's evidence was imported (`run import`) rather than dispatched on a venue. */
  readonly importedRun: boolean;
}

/** The uniform per-entry contract (design §4). */
export interface CapabilityEntry {
  /** Stable wire string. Never reused, never renamed. */
  readonly token: string;
  /** This capability's position in derived check lists and claim sections. Total across the
   * registry, and independent of the wire vector's code-unit order. */
  readonly order: number;
  /** Tokens that must / must not be declared alongside this one. */
  readonly requires: readonly string[];
  readonly conflicts: readonly string[];
  /** Exact member paths this capability adds. */
  readonly mandatoryFiles: readonly string[];
  /** Path shapes this capability allowlists. */
  readonly memberPatterns: readonly CapabilityMemberPattern[];
  /** Members whose grammar this capability replaces with a narrower one: a set of refinement
   * targets, possibly empty. At most one registered capability may refine a given target (design
   * §5.2), so the invariant is keyed per target, not per capability. */
  readonly refines: readonly string[];
  /** The evidence-catalog role derivations this capability contributes, possibly none. */
  readonly roleDerivations: readonly CapabilityRoleDerivation[];
  /** The claim-package section this capability adds, present exactly when it is declared. */
  readonly claimSection: string;
  /** Check names this capability appends, in order. */
  readonly checks: readonly PublicBundleVerificationCheck[];
  /** First published reader release implementing this capability. */
  readonly minimumReaderRelease: ReaderRelease;
  /** The producer-side predicate on run state that turns this capability on. */
  readonly activation: (facts: CapabilityActivationFacts) => boolean;
}

export const BINARY_QUALIFICATION_CAPABILITY = "binary-qualification" as const;
export const ANCHORING_CAPABILITY = "anchoring" as const;
export const DISCLOSURE_SPECIFICATION_CAPABILITY = "disclosure-specification" as const;
export const EXTERNAL_IMPORT_CAPABILITY = "external-import" as const;

/**
 * Every capability this build implements, in `order`.
 *
 * Two kinds exist (design §5.1). `anchoring` and `disclosure-specification` are ADDITIVE: they
 * contribute members, a claim section, a check, and role derivations, and touch nothing that
 * already exists.
 * `binary-qualification` is REFINING: it replaces the grammar of two existing members and extends
 * the mandatory member list. Composition is free on the additive axis and gated on the refining
 * one, which `capabilityRegistryViolations` enforces.
 */
export const CAPABILITY_REGISTRY = [
  {
    // From `/4`. "v4 expands those checks internally rather than adding a seventh top-level
    // result" (`PUBLIC-BUNDLE.md`), so it appends no check.
    token: BINARY_QUALIFICATION_CAPABILITY,
    order: 1,
    requires: [],
    conflicts: [],
    mandatoryFiles: ["qualification.json"],
    memberPatterns: [],
    refines: ["evidence.json", "trust/public-keys.json"],
    roleDerivations: [],
    claimSection: "qualification",
    checks: [],
    minimumReaderRelease: "0.1.0",
    activation: (facts) => facts.projectsBinaryQualification,
  },
  {
    // From `/6`. `mayBeEmpty` preserves the declared-but-absent rule verbatim: a Run that declared
    // anchoring intent no carried anchor satisfies still declares the capability, so the check
    // that reports the absence runs and stripping the anchors cannot produce a quieter bundle.
    token: ANCHORING_CAPABILITY,
    order: 2,
    requires: [],
    conflicts: [],
    mandatoryFiles: [],
    memberPatterns: [{ pattern: LEGACY_ANCHOR_MEMBER_PATTERN, mayBeEmpty: true }],
    refines: [],
    roleDerivations: [],
    claimSection: "anchors",
    checks: ["integrity-anchors"],
    minimumReaderRelease: "0.1.0",
    activation: (facts) => facts.anchoredClosure,
  },
  {
    // From `/8` (issue #2839). It adds no member of its own: the sealed record travels at the
    // already-allowlisted `records/<sha256>.bin` path, named by the Report's extension, under an
    // evidence role that exists only in the grammar `binary-qualification` refines to -- hence the
    // requirement. It does NOT require `anchoring`; `/8` stacked on the anchored branch to spare a
    // second hand allocation, not because the record needs an anchor.
    token: DISCLOSURE_SPECIFICATION_CAPABILITY,
    order: 3,
    requires: [BINARY_QUALIFICATION_CAPABILITY],
    conflicts: [],
    mandatoryFiles: [],
    memberPatterns: [],
    refines: [],
    // The Report extension is the one edge that reaches the record: it puts the record's digest
    // under the report author's signature, and nothing else derives the role for any record.
    roleDerivations: [{ role: DISCLOSURE_SPECIFICATION_BUNDLE_ROLE, derivedFrom: DISCLOSURE_SPECIFICATION_EXTENSION }],
    claimSection: "disclosure",
    checks: ["disclosure-specification"],
    minimumReaderRelease: "0.2.1",
    // A run publishes one bundle per analysis, and only the qualification analysis's Report names
    // the record, so a sibling headline or comparison analysis never carried the declaration.
    activation: (facts) => facts.declaresDisclosure && facts.projectsBinaryQualification,
  },
  {
    // Issue #3417. Additive: a mandatory marker member, a claim section, and a check. The
    // import-aware disclosure is not a member — both claim-consistency copies rebuild it from
    // the declared vector — so registering the token without implementing that rebuild cannot
    // pass the check-list equality below.
    token: EXTERNAL_IMPORT_CAPABILITY,
    order: 4,
    requires: [],
    conflicts: [],
    mandatoryFiles: ["external-import.json"],
    memberPatterns: [],
    refines: [],
    roleDerivations: [],
    claimSection: "externalImport",
    checks: ["external-import"],
    minimumReaderRelease: "0.2.1",
    activation: (facts) => facts.importedRun,
  },
] as const satisfies readonly CapabilityEntry[];

export type CapabilityToken = (typeof CAPABILITY_REGISTRY)[number]["token"];

const TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const VECTOR_PATH = "bundle.manifest.capabilities";

/**
 * The wire grammar of `bundle.json`'s `capabilities` member (design §3.2): lower-kebab tokens,
 * unique, sorted by code unit. Possibly empty -- the empty vector is the plain base graph, spelled
 * rather than omitted. Canonical JSON does not order arrays, so the order is enforced here; a
 * differently ordered or duplicated vector is refused before any capability logic runs.
 *
 * Grammar only. Whether this build implements each token is `composeClosure`'s question, so that
 * an unknown token is refused by name rather than as a schema mismatch.
 */
export const CapabilityVectorSchema = z.array(z.string().regex(TOKEN_PATTERN)).superRefine((vector, ctx) => {
  for (let index = 1; index < vector.length; index += 1) {
    if (compareCodeUnitStrings(vector[index - 1]!, vector[index]!) >= 0) {
      ctx.addIssue({ code: "custom", path: [index], message: "capabilities must be unique and sorted by code unit" });
    }
  }
});

/** Numeric, component by component: `0.10.0` is later than `0.9.0`. */
export function compareReaderReleases(left: string, right: string): number {
  const [leftParts, rightParts] = [left, right].map((release) => release.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts![index] ?? 0) - (rightParts![index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Every way `registry` breaks an invariant the derivations rely on (design §5.2, §9). Empty for a
 * sound registry. Run against `CAPABILITY_REGISTRY` on every build, so a second refiner of one
 * target is a design-time conflict rather than a runtime surprise discovered by a publisher.
 */
export function capabilityRegistryViolations(registry: readonly CapabilityEntry[]): string[] {
  const violations: string[] = [];
  const tokens = new Set(registry.map((entry) => entry.token));
  /** Reports the second claimant of anything only one entry may claim. */
  const claimOnce = (claimed: Map<string, string>, key: string, token: string, describe: (owner: string) => string) => {
    const owner = claimed.get(key);
    if (owner !== undefined) violations.push(describe(owner));
    else claimed.set(key, token);
  };
  const seenTokens = new Map<string, string>();
  const orders = new Map<string, string>();
  const refiners = new Map<string, string>();
  const sections = new Map<string, string>();
  const checks = new Map<string, string>(PUBLIC_BUNDLE_VERIFICATION_CHECKS.map((check) => [check, "the base graph"]));
  for (const entry of registry) {
    const quoted = `"${entry.token}"`;
    if (!TOKEN_PATTERN.test(entry.token)) violations.push(`token ${quoted} is not lower-kebab`);
    claimOnce(seenTokens, entry.token, entry.token, () => `token ${quoted} is registered more than once`);
    claimOnce(orders, String(entry.order), entry.token, (owner) => `order ${entry.order} is shared by "${owner}" and ${quoted}`);
    for (const member of entry.refines) {
      claimOnce(refiners, member, entry.token, (owner) => `"${member}" is refined by both "${owner}" and ${quoted}`);
    }
    claimOnce(sections, entry.claimSection, entry.token, (owner) => `claim section "${entry.claimSection}" is added by both "${owner}" and ${quoted}`);
    for (const check of entry.checks) {
      claimOnce(checks, check, entry.token, (owner) =>
        `check "${check}" is added by both ${owner === "the base graph" ? owner : `"${owner}"`} and ${quoted}`);
    }
    for (const required of entry.requires) {
      if (!tokens.has(required)) violations.push(`${quoted} requires unregistered token "${required}"`);
    }
    for (const conflicting of entry.conflicts) {
      if (!tokens.has(conflicting)) violations.push(`${quoted} conflicts with unregistered token "${conflicting}"`);
    }
    if (!Object.hasOwn(READER_RELEASE_LINES, entry.minimumReaderRelease)) {
      violations.push(`${quoted} names unpublished reader release "${entry.minimumReaderRelease}"`);
    }
  }
  const requiresOf = new Map(registry.map((entry) => [entry.token, entry.requires] as const));
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean =>
    (requiresOf.get(from) ?? []).some((next) => next === target
      || (!visited.has(next) && reaches(next, target, visited.add(next))));
  for (const entry of registry) {
    if (reaches(entry.token, entry.token)) violations.push(`the requires closure of "${entry.token}" is cyclic`);
  }
  return violations;
}

/** Everything a declared vector derives (design §6 step 2, §7, §8). */
export interface ComposedClosure {
  /** The declared vector, in wire order. */
  readonly capabilities: readonly string[];
  /** The base graph's members, then each declared capability's, by `order`. */
  readonly mandatoryFiles: readonly string[];
  /** The path shapes the declared capabilities allowlist. An undeclared capability's shape is
   * absent, so a member matching it is a non-allowlisted file (P3). */
  readonly memberPatterns: readonly CapabilityMemberPattern[];
  /** Each refined member, keyed to the one declared capability whose grammar replaces the base's. */
  readonly refinedMembers: ReadonlyMap<string, string>;
  /** The role derivations the declared capabilities contribute, beyond the base graph's own. An
   * undeclared capability's is absent, so a record only it could reach is unreachable. */
  readonly roleDerivations: readonly CapabilityRoleDerivation[];
  /** The base checks, then each declared capability's, by `order`. */
  readonly checks: readonly PublicBundleVerificationCheck[];
  /** The claim sections that must be present, by `order`. Every other capability's must be absent. */
  readonly claimSections: readonly string[];
  readonly minimumReaderRelease: ReaderRelease;
}

/**
 * Resolves a declared vector against `registry`, or refuses (design §6 step 1, property P1). Every
 * token is critical: there is no "ignore what you don't know" tier and none is reserved.
 */
function resolveCapabilityVector(vector: readonly string[], registry: readonly CapabilityEntry[]): CapabilityEntry[] {
  if (!CapabilityVectorSchema.safeParse(vector).success) {
    refuse("record-integrity", VECTOR_PATH, "the capability vector must be lower-kebab tokens, unique and sorted by code unit");
  }
  const declared = vector.map((token) => {
    // Matched by value, never looked up as an object key: the token is an untyped wire string, and
    // `constructor` or `__proto__` must refuse like any other unknown token.
    const entry = registry.find((candidate) => candidate.token === token);
    if (entry === undefined) {
      refuse("record-integrity", VECTOR_PATH, `this verifier does not implement capability "${token}", so the bundle is refused whole`);
    }
    return entry;
  });
  for (const entry of declared) {
    for (const required of entry.requires) {
      if (!vector.includes(required)) {
        refuse("record-integrity", VECTOR_PATH, `capability "${entry.token}" requires "${required}", which this bundle does not declare`);
      }
    }
    for (const conflicting of entry.conflicts) {
      if (vector.includes(conflicting)) {
        refuse("record-integrity", VECTOR_PATH, `capability "${entry.token}" conflicts with "${conflicting}", and this bundle declares both`);
      }
    }
  }
  return declared.sort((left, right) => left.order - right.order);
}

/** Composes the closure a declared vector promises, refusing a vector this build cannot honor. */
export function composeClosure(
  vector: readonly string[],
  registry: readonly CapabilityEntry[] = CAPABILITY_REGISTRY,
): ComposedClosure {
  const declared = resolveCapabilityVector(vector, registry);
  return {
    capabilities: [...vector],
    mandatoryFiles: [...PUBLIC_BUNDLE_FILES, ...declared.flatMap((entry) => entry.mandatoryFiles)],
    memberPatterns: declared.flatMap((entry) => entry.memberPatterns),
    refinedMembers: new Map(declared.flatMap((entry) => entry.refines.map((member) => [member, entry.token] as const))),
    roleDerivations: declared.flatMap((entry) => entry.roleDerivations),
    checks: [...PUBLIC_BUNDLE_VERIFICATION_CHECKS, ...declared.flatMap((entry) => entry.checks)],
    claimSections: declared.map((entry) => entry.claimSection),
    minimumReaderRelease: declared
      .map((entry) => entry.minimumReaderRelease)
      .reduce(
        (latest, release) => compareReaderReleases(release, latest) > 0 ? release : latest,
        COMPOSED_FORMAT_MINIMUM_READER_RELEASE,
      ),
  };
}

/** What the two-way member closure is computed over: a composed closure, or a frozen legacy cell
 * stated in the same two terms. */
export interface MemberClosure {
  readonly mandatoryFiles: readonly string[];
  readonly memberPatterns: readonly CapabilityMemberPattern[];
}

/**
 * The two-way member closure (design §6 step 3): every expected path is present, and every
 * manifest path is expected. The mechanism the pre-composition closures always ran, computed over
 * whichever sets the bundle's declared shape derives rather than over a per-format constant.
 *
 * `graphPaths` are the members the base graph derives from the bundle's own content -- the
 * `records/<sha256>.bin` its evidence catalog names, the cancel marker, native Inspect logs.
 *
 * Because the allowlist is built only from DECLARED shapes, an `anchors/...` member in a bundle
 * that did not declare `anchoring` is a non-allowlisted file (P3). Because the mandatory list is
 * built from declared capabilities, a declared capability whose members were stripped fails as a
 * missing member (P2), with `mayBeEmpty` the one explicit exception.
 */
export function assertMemberClosure(
  closure: MemberClosure,
  manifestPaths: ReadonlySet<string>,
  graphPaths: Iterable<string>,
): void {
  const expectedPaths = new Set<string>([...closure.mandatoryFiles, ...graphPaths]);
  for (const { pattern, mayBeEmpty } of closure.memberPatterns) {
    const members = [...manifestPaths].filter((path) => pattern.test(path));
    if (members.length === 0 && !mayBeEmpty) {
      refuse("record-integrity", "bundle.manifest.files", `public bundle closure is missing every member of the shape ${String(pattern)}`);
    }
    for (const path of members) expectedPaths.add(path);
  }
  for (const path of manifestPaths) if (!expectedPaths.has(path)) refuse("record-integrity", path, `public bundle contains non-allowlisted file "${path}"`);
  for (const path of expectedPaths) if (!manifestPaths.has(path)) refuse("record-integrity", path, `public bundle closure is missing "${path}"`);
}

/** The check list a bundle declaring `vector` runs, in order. The one denominator every reader
 * surface shows, and the list a claim pins. */
export function expectedChecks(vector: readonly string[]): readonly PublicBundleVerificationCheck[] {
  return composeClosure(vector).checks;
}

/** The exact and compatible reader lines a claim for a bundle declaring `vector` pins. */
export function readerInstructions(vector: readonly string[]): (typeof READER_RELEASE_LINES)[ReaderRelease] {
  return READER_RELEASE_LINES[composeClosure(vector).minimumReaderRelease];
}

/** The vector a run's facts turn on, in canonical wire order. Two producers on the same registry
 * emit the same vector for the same run (design §5.4). */
export function activeCapabilityVector(facts: CapabilityActivationFacts): CapabilityToken[] {
  return CAPABILITY_REGISTRY
    .filter((entry) => entry.activation(facts))
    .map((entry) => entry.token)
    .sort(compareCodeUnitStrings);
}
