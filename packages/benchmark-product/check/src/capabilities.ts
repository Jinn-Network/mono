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
 * The reader releases a capability may name as its minimum, each with the exact and compatible
 * reader lines a claim pins for it, oldest first.
 *
 * Keyed by package name AND version, because both reader names carry a `0.2.1`: the `verify`
 * release that `/7` and `/8` pin, which predates the composed generation and refuses it at
 * manifest parse, and the first `check` release, which reads it (issue #4746). A version-only key
 * cannot hold both. Order is the table's, not the version's: each release reads every format the
 * one before it reads, so a later row is a later reader even where the versions tie. Within one
 * package the rows run oldest version first, which `capabilityRegistryViolations` enforces.
 *
 * The `verify` rows alias the frozen commands. The `check` row is spelled here, and this file is in
 * the publish guard's `CLAIM_PIN_SOURCES` (`.github/scripts/colophon-publish-manifest.mjs`), so
 * its lines are checked against npm like every other sealed pin: the `check` dispatch admits the
 * version it publishes, and `core` and `cli` refuse until npm serves it.
 */
export const READER_RELEASE_LINES = {
  "verify@0.1.0": {
    command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  },
  "verify@0.2.1": {
    command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  },
  "check@0.2.1": {
    command: "npx @colophon-claims/check@0.2.1 <bundle-dir>",
    compatibleCommand: "npx @colophon-claims/check@0.2 <bundle-dir>",
  },
} as const;

export type ReaderRelease = keyof typeof READER_RELEASE_LINES;

/**
 * The reader release the composed generation itself needs, whatever it declares: the base every
 * vector's minimum is taken against. The `verify` releases above predate the composed format and
 * refuse it at manifest parse, so a vector of capabilities one of them first implemented still
 * cannot name its line. The first `check` release is the first reader of `/10`, and `@0.2` under
 * the checker's name admits no release before it.
 */
export const COMPOSED_FORMAT_MINIMUM_READER_RELEASE: ReaderRelease = "check@0.2.1";

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
  /** The Report this bundle publishes is scored by `wilson@1`. */
  readonly wilsonReport: boolean;
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
  /**
   * The claim-package section this capability adds, present exactly when it is declared. Absent for
   * a capability the claim does not carry at all: a claim's check list and reader line are
   * re-derived from its SECTIONS (`profile/claim.ts`), so an entry without one can add no check and
   * cannot raise the reader line past the composed generation's base, which
   * `capabilityRegistryViolations` enforces. That is only sound for a capability the first `/10`
   * reader release already implements.
   */
  readonly claimSection?: string;
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
export const SLOT_DENOMINATORS_CAPABILITY = "slot-denominators" as const;

/**
 * Every capability this build implements, in `order`.
 *
 * Two kinds exist (design §5.1). `anchoring` and `disclosure-specification` are ADDITIVE: they
 * contribute members, a claim section, a check, and role derivations, and touch nothing that
 * already exists.
 * `binary-qualification` is REFINING: it replaces the grammar of two existing members and extends
 * the mandatory member list. Composition is free on the additive axis and gated on the refining
 * one, which `capabilityRegistryViolations` enforces. `slot-denominators` adds nothing the closure
 * examines: it selects which report page the presentation byte-compare expects.
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
    minimumReaderRelease: "verify@0.1.0",
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
    minimumReaderRelease: "verify@0.1.0",
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
    minimumReaderRelease: "verify@0.2.1",
    // A run publishes one bundle per analysis, and only the qualification analysis's Report names
    // the record, so a sibling headline or comparison analysis never carried the declaration.
    activation: (facts) => facts.declaresDisclosure && facts.projectsBinaryQualification,
  },
  {
    // Issue #3417. Additive: a mandatory marker member, a claim section, and a check. The
    // import-aware disclosure is not a member — both claim-consistency copies rebuild it from
    // the declared vector — so registering the token without implementing that rebuild cannot
    // pass the check-list equality below. New with the composed generation, so no `verify`
    // release implements it: its first reader is the first `check` release (issue #4746).
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
    minimumReaderRelease: "check@0.2.1",
    activation: (facts) => facts.importedRun,
  },
  {
    // Issue #3698. Presentation only: the wilson arm table on `index.html` renders the declared
    // denominator, the strict all-slots one, and the planned slots the declared one leaves out,
    // side by side (`assets.ts`). No member, no check, and no claim section: the page is already
    // byte-compared against the rebuild the declared vector selects, so a declaration without the
    // render, or the render without the declaration, is refused there. A wilson `/10` bundle that
    // does not declare it keeps the page it has (operator ruling, 2026-09-24).
    token: SLOT_DENOMINATORS_CAPABILITY,
    order: 5,
    requires: [],
    conflicts: [],
    mandatoryFiles: [],
    memberPatterns: [],
    refines: [],
    roleDerivations: [],
    checks: [],
    minimumReaderRelease: "check@0.2.1",
    activation: (facts) => facts.wilsonReport,
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

const READER_RELEASE_ORDER: readonly string[] = Object.keys(READER_RELEASE_LINES);

/** A release outside the table has no position, so it throws rather than sorting to either end. */
function readerReleasePosition(release: string): number {
  const position = READER_RELEASE_ORDER.indexOf(release);
  if (position < 0) throw new Error(`reader release "${release}" is not in READER_RELEASE_LINES`);
  return position;
}

/**
 * By position in `READER_RELEASE_LINES`, which lists releases oldest first. Not by version: the
 * `verify` and `check` releases share `0.2.1`, and only the second reads `/10`.
 */
export function compareReaderReleases(left: ReaderRelease, right: ReaderRelease): number {
  return readerReleasePosition(left) - readerReleasePosition(right);
}

const READER_RELEASE_KEY = /^([a-z][a-z0-9-]*)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Negative, zero, or positive as `left` is older than, the same as, or newer than `right`. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

/**
 * Every way a reader-release table breaks the ordering `compareReaderReleases` relies on. The
 * table ranks releases by position, and a position is only a version order within one package: a
 * `check@0.2.2` row written above `check@0.2.1` would rank the older release as the later reader
 * and silently mis-rank every minimum taken against it.
 */
function readerReleaseTableViolations(readerReleases: Readonly<Record<string, unknown>>): string[] {
  const violations: string[] = [];
  const latest = new Map<string, { readonly key: string; readonly version: readonly number[] }>();
  for (const key of Object.keys(readerReleases)) {
    const match = READER_RELEASE_KEY.exec(key);
    if (match === null) {
      violations.push(`reader release "${key}" is not <package>@<major>.<minor>.<patch>`);
      continue;
    }
    const version = match.slice(2).map(Number);
    const previous = latest.get(match[1]!);
    if (previous !== undefined && compareVersions(version, previous.version) <= 0) {
      violations.push(`reader release "${key}" is listed after "${previous.key}", a release of the same package that is not older`);
    }
    latest.set(match[1]!, { key, version });
  }
  if (!Object.hasOwn(readerReleases, COMPOSED_FORMAT_MINIMUM_READER_RELEASE)) {
    violations.push(`the composed generation's base reader release "${COMPOSED_FORMAT_MINIMUM_READER_RELEASE}" is not in the table`);
  }
  return violations;
}

/**
 * Every way `registry` breaks an invariant the derivations rely on (design §5.2, §9). Empty for a
 * sound registry. Run against `CAPABILITY_REGISTRY` on every build, so a second refiner of one
 * target is a design-time conflict rather than a runtime surprise discovered by a publisher.
 * `readerReleases` is the table minimums are ranked in; it defaults to the one this build ships.
 */
export function capabilityRegistryViolations(
  registry: readonly CapabilityEntry[],
  readerReleases: Readonly<Record<string, unknown>> = READER_RELEASE_LINES,
): string[] {
  const violations: string[] = readerReleaseTableViolations(readerReleases);
  const releaseOrder = Object.keys(readerReleases);
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
    if (entry.claimSection !== undefined) {
      const section = entry.claimSection;
      claimOnce(sections, section, entry.token, (owner) => `claim section "${section}" is added by both "${owner}" and ${quoted}`);
    }
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
    if (!Object.hasOwn(readerReleases, entry.minimumReaderRelease)) {
      violations.push(`${quoted} names unpublished reader release "${entry.minimumReaderRelease}"`);
    } else if (
      entry.claimSection === undefined
      && releaseOrder.includes(COMPOSED_FORMAT_MINIMUM_READER_RELEASE)
      && releaseOrder.indexOf(entry.minimumReaderRelease) > releaseOrder.indexOf(COMPOSED_FORMAT_MINIMUM_READER_RELEASE)
    ) {
      // A claim's reader line is re-derived from its sections, so a capability the claim cannot
      // see must not be the one that moves it.
      violations.push(`${quoted} has no claim section, so it cannot raise the reader line past "${COMPOSED_FORMAT_MINIMUM_READER_RELEASE}"`);
    }
    if (entry.claimSection === undefined && entry.checks.length > 0) {
      violations.push(`${quoted} has no claim section, so it cannot add a check`);
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
  /** The claim sections that must be present, by `order`. Every other capability's must be absent.
   * A declared capability without a section contributes none. */
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
    claimSections: declared.flatMap((entry) => entry.claimSection === undefined ? [] : [entry.claimSection]),
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
