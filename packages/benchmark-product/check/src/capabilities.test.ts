// SPDX-License-Identifier: Apache-2.0

/**
 * The capability registry and its derivations (bundle-capability-composition design §3-§5, §7, §9;
 * issue #3403, packet C1).
 *
 * Three things are pinned here, and none of them touches the wire:
 *
 * - **The registry's invariants**, each one also run against a deliberately broken registry. An
 *   invariant that has never been seen to fail is a comment, not a check.
 * - **The derivations reproduce every pre-composition cell exactly.** `/2`, `/4`, `/6`, `/7`, and
 *   `/8` were hand-enumerated; their frozen check arrays, member lists, and claim sections are the
 *   expected outputs of the function that replaces the enumeration. Check lists are compared in
 *   order. Member lists are compared as sets, which is what the design's equivalence step asks for
 *   (§10 step 3): `bundle.json` sorts its members by path, so no reader observes any other order.
 * - **Resolution is must-understand.** One unknown token refuses the vector whole, with the token
 *   named, and an unsatisfiable vector refuses before any closure is composed.
 */

import { describe, expect, test } from "vitest";
import {
  LEGACY_ANCHOR_MEMBER_PATTERN,
  PUBLIC_BUNDLE_FILES,
  PUBLIC_BUNDLE_V4_FILES,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
} from "./legacy-closures.js";
import { PUBLIC_BUNDLE_V8_CHECKS } from "./reader-instructions.js";
import { expectRefusal } from "./testing/expect-refusal.js";
import {
  CAPABILITY_REGISTRY,
  COMPOSED_FORMAT_MINIMUM_READER_RELEASE,
  CapabilityVectorSchema,
  READER_RELEASE_LINES,
  activeCapabilityVector,
  capabilityRegistryViolations,
  compareReaderReleases,
  composeClosure,
  expectedChecks,
  readerInstructions,
  type CapabilityEntry,
} from "./capabilities.js";

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** A registry entry that contributes nothing, for the broken-registry probes below. */
function entry(token: string, order: number, overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    token,
    order,
    requires: [],
    conflicts: [],
    mandatoryFiles: [],
    memberPatterns: [],
    refines: [],
    roleDerivations: [],
    claimSection: token,
    checks: [],
    minimumReaderRelease: "verify@0.2.1",
    activation: () => false,
    ...overrides,
  };
}

/** `entry` with no claim section at all, the shape `slot-denominators` registers. */
function sectionless(token: string, order: number, overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  const { claimSection: _omitted, ...rest } = entry(token, order, overrides);
  return rest;
}

describe("the registered capabilities", () => {
  test("exactly five, under their stable wire tokens", () => {
    expect(CAPABILITY_REGISTRY.map((capability) => capability.token)).toEqual([
      "binary-qualification",
      "anchoring",
      "disclosure-specification",
      "external-import",
      "slot-denominators",
    ]);
  });

  test("the registry satisfies every invariant", () => {
    expect(capabilityRegistryViolations(CAPABILITY_REGISTRY)).toEqual([]);
  });

  test("binary-qualification refines two grammars, adds one member, and adds no check", () => {
    const [qualification] = CAPABILITY_REGISTRY;
    expect(qualification!.mandatoryFiles).toEqual(["qualification.json"]);
    expect(qualification!.refines).toEqual(["evidence.json", "trust/public-keys.json"]);
    expect(qualification!.checks).toEqual([]);
    expect(qualification!.claimSection).toBe("qualification");
  });

  test("anchoring allowlists the frozen anchor member shape, and may carry none", () => {
    const anchoring = CAPABILITY_REGISTRY[1]!;
    // The same RegExp object, not a respelling: a second copy of the shape is a second place for
    // it to drift from the one the four anchored legacy closures admit.
    expect(anchoring.memberPatterns).toEqual([{ pattern: LEGACY_ANCHOR_MEMBER_PATTERN, mayBeEmpty: true }]);
    expect(anchoring.memberPatterns[0]!.pattern).toBe(LEGACY_ANCHOR_MEMBER_PATTERN);
    expect(anchoring.checks).toEqual(["integrity-anchors"]);
    expect(anchoring.claimSection).toBe("anchors");
  });

  test("disclosure-specification adds no member of its own and requires the qualification grammar", () => {
    const disclosure = CAPABILITY_REGISTRY[2]!;
    // The sealed record travels at the already-allowlisted `records/<sha256>.bin` path, under an
    // evidence role that exists only in the grammar `binary-qualification` refines to.
    expect(disclosure.mandatoryFiles).toEqual([]);
    expect(disclosure.memberPatterns).toEqual([]);
    expect(disclosure.requires).toEqual(["binary-qualification"]);
    expect(disclosure.checks).toEqual(["disclosure-specification"]);
    expect(disclosure.claimSection).toBe("disclosure");
  });

  test("disclosure-specification alone contributes a role derivation, and it refines nothing", () => {
    // The role name is the one the evidence catalog spells, and the deriving fact is the Report
    // extension: the only edge that reaches the record. A derivation is additive, never a
    // refinement target, so contributing one does not make the capability a refiner.
    const [qualification, anchoring, disclosure, imported, slots] = CAPABILITY_REGISTRY;
    expect(disclosure!.roleDerivations).toEqual([{
      role: "disclosure-specification",
      derivedFrom: "https://spec.jinn.network/extensions/disclosure-specification/v1",
    }]);
    expect(disclosure!.refines).toEqual([]);
    expect(qualification!.roleDerivations).toEqual([]);
    expect(anchoring!.roleDerivations).toEqual([]);
    expect(imported!.roleDerivations).toEqual([]);
    expect(slots!.roleDerivations).toEqual([]);
  });

  test("external-import adds a mandatory marker member, a check, and no grammar", () => {
    const imported = CAPABILITY_REGISTRY[3]!;
    expect(imported.mandatoryFiles).toEqual(["external-import.json"]);
    expect(imported.memberPatterns).toEqual([]);
    expect(imported.requires).toEqual([]);
    expect(imported.conflicts).toEqual([]);
    expect(imported.refines).toEqual([]);
    expect(imported.checks).toEqual(["external-import"]);
    expect(imported.claimSection).toBe("externalImport");
  });

  test("slot-denominators adds no member, no check, and no claim section (issue #3698)", () => {
    const slots: CapabilityEntry = CAPABILITY_REGISTRY[4]!;
    expect(slots.mandatoryFiles).toEqual([]);
    expect(slots.memberPatterns).toEqual([]);
    expect(slots.requires).toEqual([]);
    expect(slots.conflicts).toEqual([]);
    expect(slots.refines).toEqual([]);
    expect(slots.checks).toEqual([]);
    expect("claimSection" in slots).toBe(false);
    // Declaring it alone derives the plain base graph's closure: what it changes is which report
    // page the presentation byte-compare expects, and nothing the claim pins.
    const closure = composeClosure(["slot-denominators"]);
    expect(closure.mandatoryFiles).toEqual(PUBLIC_BUNDLE_FILES);
    expect(closure.checks).toEqual(PUBLIC_BUNDLE_VERIFICATION_CHECKS);
    expect(closure.claimSections).toEqual([]);
    expect(readerInstructions(["slot-denominators"])).toEqual(readerInstructions([]));
  });
});

describe("the registry invariants have teeth", () => {
  test("a duplicate token", () => {
    expect(capabilityRegistryViolations([entry("alpha", 1), entry("alpha", 2, { claimSection: "other" })]))
      .toContain('token "alpha" is registered more than once');
  });

  test("a token outside the lower-kebab wire grammar", () => {
    expect(capabilityRegistryViolations([entry("Alpha_One", 1)]))
      .toContain('token "Alpha_One" is not lower-kebab');
  });

  test("an order that is not total", () => {
    expect(capabilityRegistryViolations([entry("alpha", 1), entry("beta", 1)]))
      .toContain('order 1 is shared by "alpha" and "beta"');
  });

  test("two refiners of one target", () => {
    expect(capabilityRegistryViolations([
      entry("alpha", 1, { refines: ["evidence.json"] }),
      entry("beta", 2, { refines: ["evidence.json"] }),
    ])).toContain('"evidence.json" is refined by both "alpha" and "beta"');
  });

  test("a requirement or conflict naming an unregistered token", () => {
    expect(capabilityRegistryViolations([entry("alpha", 1, { requires: ["ghost"] })]))
      .toContain('"alpha" requires unregistered token "ghost"');
    expect(capabilityRegistryViolations([entry("alpha", 1, { conflicts: ["ghost"] })]))
      .toContain('"alpha" conflicts with unregistered token "ghost"');
  });

  test("a cyclic requires closure", () => {
    expect(capabilityRegistryViolations([
      entry("alpha", 1, { requires: ["beta"] }),
      entry("beta", 2, { requires: ["alpha"] }),
    ])).toContain('the requires closure of "alpha" is cyclic');
  });

  test("a minimum reader release that was never published", () => {
    expect(capabilityRegistryViolations([entry("alpha", 1, { minimumReaderRelease: "9.9.9" as never })]))
      .toContain('"alpha" names unpublished reader release "9.9.9"');
  });

  test("a capability without a claim section that adds a check or raises the reader line", () => {
    // A claim's check list and reader line are re-derived from its sections, so a capability the
    // claim cannot see must move neither.
    const later = { ...READER_RELEASE_LINES, "check@0.2.2": READER_RELEASE_LINES["check@0.2.1"] };
    expect(capabilityRegistryViolations([sectionless("alpha", 1, { checks: ["integrity-anchors"] })]))
      .toContain('"alpha" has no claim section, so it cannot add a check');
    expect(capabilityRegistryViolations([sectionless("alpha", 1, { minimumReaderRelease: "check@0.2.2" as never })], later))
      .toContain('"alpha" has no claim section, so it cannot raise the reader line past "check@0.2.1"');
    // The same release is sound for an entry the claim can see, and at or below the composed
    // generation's own base line it is sound without a section.
    expect(capabilityRegistryViolations([entry("alpha", 1, { minimumReaderRelease: "check@0.2.2" as never })], later))
      .toEqual([]);
    for (const release of ["verify@0.1.0", "verify@0.2.1", "check@0.2.1"] as const) {
      expect(capabilityRegistryViolations([sectionless("alpha", 1, { minimumReaderRelease: release })]), release)
        .toEqual([]);
    }
  });

  test("reader releases of one package out of version order (issue #4767 review)", () => {
    const row = READER_RELEASE_LINES["check@0.2.1"];
    expect(capabilityRegistryViolations([], { "verify@0.1.0": row, "check@0.2.2": row, "check@0.2.1": row }))
      .toContain('reader release "check@0.2.1" is listed after "check@0.2.2", a release of the same package that is not older');
    expect(capabilityRegistryViolations([], { "check@0.10.0": row, "check@0.9.0": row }))
      .toContain('reader release "check@0.9.0" is listed after "check@0.10.0", a release of the same package that is not older');
    expect(capabilityRegistryViolations([], { "0.2.1": row }))
      .toContain('reader release "0.2.1" is not <package>@<major>.<minor>.<patch>');
    // A table without the base cannot rank a section-less entry against it, so it says so once
    // rather than reporting every such entry as raising the line.
    expect(capabilityRegistryViolations([sectionless("alpha", 1)], { "verify@0.2.1": row }))
      .toEqual(['the composed generation\'s base reader release "check@0.2.1" is not in the table']);
    // Across packages a tie is not an ordering claim: the table's own `verify@0.2.1` then
    // `check@0.2.1` is sound, and so is a later row of either package.
    expect(capabilityRegistryViolations([], { ...READER_RELEASE_LINES, "verify@0.2.2": row, "check@0.3.0": row }))
      .toEqual([]);
  });

  test("a claim section or a check two capabilities both add", () => {
    expect(capabilityRegistryViolations([entry("alpha", 1), entry("beta", 2, { claimSection: "alpha" })]))
      .toContain('claim section "alpha" is added by both "alpha" and "beta"');
    expect(capabilityRegistryViolations([
      entry("alpha", 1, { checks: ["integrity-anchors"] }),
      entry("beta", 2, { checks: ["integrity-anchors"] }),
    ])).toContain('check "integrity-anchors" is added by both "alpha" and "beta"');
    // A capability re-adding a base check would double it in every derived list.
    expect(capabilityRegistryViolations([entry("alpha", 1, { checks: ["manifest"] })]))
      .toContain('check "manifest" is added by both the base graph and "alpha"');
  });
});

describe("the wire vector grammar", () => {
  test("admits the empty vector and every canonically ordered one", () => {
    for (const vector of [
      [],
      ["anchoring"],
      ["anchoring", "binary-qualification", "disclosure-specification"],
      // Grammar only: an unknown token is well-formed here and refused, by name, at resolution.
      ["zz-unknown"],
    ]) {
      expect(CapabilityVectorSchema.safeParse(vector).success, JSON.stringify(vector)).toBe(true);
    }
  });

  test("refuses a duplicated, misordered, or non-kebab vector before any capability logic runs", () => {
    for (const vector of [
      ["anchoring", "anchoring"],
      ["binary-qualification", "anchoring"],
      ["Anchoring"],
      ["anchoring "],
      [""],
      ["-anchoring"],
      "anchoring",
      undefined,
      null,
    ]) {
      expect(CapabilityVectorSchema.safeParse(vector).success, JSON.stringify(vector)).toBe(false);
    }
  });
});

describe("the derivations reproduce every pre-composition cell", () => {
  const CELLS = [
    {
      cell: "/2",
      vector: [],
      checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      files: PUBLIC_BUNDLE_FILES,
      claimSections: [],
      anchors: false,
      refined: [],
    },
    {
      cell: "/4",
      vector: ["binary-qualification"],
      checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
      files: PUBLIC_BUNDLE_V4_FILES,
      claimSections: ["qualification"],
      anchors: false,
      refined: ["evidence.json", "trust/public-keys.json"],
    },
    {
      cell: "/6",
      vector: ["anchoring"],
      checks: PUBLIC_BUNDLE_V6_CHECKS,
      files: PUBLIC_BUNDLE_FILES,
      claimSections: ["anchors"],
      anchors: true,
      refined: [],
    },
    {
      cell: "/7",
      vector: ["anchoring", "binary-qualification"],
      checks: PUBLIC_BUNDLE_V7_CHECKS,
      files: PUBLIC_BUNDLE_V4_FILES,
      claimSections: ["qualification", "anchors"],
      anchors: true,
      refined: ["evidence.json", "trust/public-keys.json"],
    },
    {
      // Hand-allocated after the design was written (issue #2839): v7's member list, and v7's
      // checks plus `disclosure-specification`, last.
      cell: "/8",
      vector: ["anchoring", "binary-qualification", "disclosure-specification"],
      checks: PUBLIC_BUNDLE_V8_CHECKS,
      files: PUBLIC_BUNDLE_V4_FILES,
      claimSections: ["qualification", "anchors", "disclosure"],
      anchors: true,
      refined: ["evidence.json", "trust/public-keys.json"],
    },
  ] as const;

  for (const expected of CELLS) {
    test(`${expected.cell} is the vector ${JSON.stringify(expected.vector)}`, () => {
      const closure = composeClosure(expected.vector);
      expect(closure.capabilities).toEqual(expected.vector);
      // In order, and against the frozen array itself rather than a respelling of it.
      expect(closure.checks).toEqual(expected.checks);
      expect(expectedChecks(expected.vector)).toEqual(expected.checks);
      expect(sorted(closure.mandatoryFiles)).toEqual(sorted(expected.files));
      expect(closure.claimSections).toEqual(expected.claimSections);
      expect(closure.memberPatterns.map(({ pattern }) => pattern))
        .toEqual(expected.anchors ? [LEGACY_ANCHOR_MEMBER_PATTERN] : []);
      expect(sorted(closure.refinedMembers.keys())).toEqual(sorted(expected.refined));
      // Only `/8` reaches a record through a capability's own derivation: its disclosure record.
      expect(closure.roleDerivations.map((derivation) => derivation.role))
        .toEqual(expected.claimSections.includes("disclosure" as never) ? ["disclosure-specification"] : []);
    });
  }

  test("the base graph leads every derived member list, unchanged and in its frozen order", () => {
    for (const { vector } of CELLS) {
      expect(composeClosure(vector).mandatoryFiles.slice(0, PUBLIC_BUNDLE_FILES.length))
        .toEqual(PUBLIC_BUNDLE_FILES);
    }
  });

  test("derived lists follow registry order, never the wire vector's code-unit order", () => {
    // On the wire `anchoring` sorts before `binary-qualification`; in derived lists the
    // qualification section leads, because its `order` is lower (design §5.4).
    expect(composeClosure(["anchoring", "binary-qualification"]).claimSections)
      .toEqual(["qualification", "anchors"]);
  });
});

describe("must-understand resolution", () => {
  test("one unknown token refuses the vector whole, with the token named", () => {
    const refusal = expectRefusal(() => composeClosure(["anchoring", "zz-unknown"]));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
    expect(refusal.issues[0]!.message).toContain('"zz-unknown"');
  });

  test("an inherited Object member is not a registered token", () => {
    // The registry is looked up by an untyped wire string, so `constructor` must refuse exactly as
    // any other unknown token does, never resolve to an inherited member. It is the one such name
    // the wire grammar admits; `toString` and `__proto__` are refused a step earlier, as grammar.
    expect(() => composeClosure(["constructor"])).toThrow(/does not implement capability "constructor"/u);
    for (const token of ["toString", "__proto__"]) {
      expect(() => composeClosure([token]), token).toThrow(/lower-kebab/u);
    }
  });

  test("a vector outside the wire grammar is refused, not normalized", () => {
    for (const vector of [["binary-qualification", "anchoring"], ["anchoring", "anchoring"]]) {
      const refusal = expectRefusal(() => composeClosure(vector));
      expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
    }
  });

  test("a declared capability whose requirement is undeclared is refused, naming both", () => {
    for (const vector of [["disclosure-specification"], ["anchoring", "disclosure-specification"]]) {
      const refusal = expectRefusal(() => composeClosure(vector));
      expect(refusal.issues[0]!.message).toContain('"disclosure-specification"');
      expect(refusal.issues[0]!.message).toContain('"binary-qualification"');
    }
  });

  test("two declared capabilities that conflict are refused, naming both", () => {
    const registry = [entry("alpha", 1, { conflicts: ["beta"] }), entry("beta", 2)];
    const refusal = expectRefusal(() => composeClosure(["alpha", "beta"], registry));
    expect(refusal.issues[0]!.message).toContain('"alpha"');
    expect(refusal.issues[0]!.message).toContain('"beta"');
  });
});

describe("reader instructions", () => {
  test("releases compare by their place in the table, not by version (issue #4746)", () => {
    expect(Object.keys(READER_RELEASE_LINES)).toEqual(["verify@0.1.0", "verify@0.2.1", "check@0.2.1"]);
    expect(compareReaderReleases("verify@0.1.0", "verify@0.2.1")).toBeLessThan(0);
    expect(compareReaderReleases("verify@0.2.1", "verify@0.2.1")).toBe(0);
    // The two 0.2.1 releases share a version and are still two readers: only the checker reads /10.
    expect(compareReaderReleases("check@0.2.1", "verify@0.2.1")).toBeGreaterThan(0);
    expect(() => compareReaderReleases("0.2.1" as never, "check@0.2.1"))
      .toThrow(/reader release "0\.2\.1" is not in READER_RELEASE_LINES/u);
  });

  test("the verify lines alias the frozen commands; the checker's 0.2.1 is its own entry (issue #4746)", () => {
    // `.github/scripts/colophon-publish-manifest.test.mjs` pins exactly which files may quote a
    // reader specifier, so the verify rows name the frozen constants instead of respelling them,
    // and this file is on that list for the checker row it spells.
    expect(READER_RELEASE_LINES["verify@0.2.1"]).toEqual({
      command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
    });
    expect(READER_RELEASE_LINES["verify@0.1.0"]).toEqual({
      command: "npx @colophon-claims/verify@0.1.0 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.1 <bundle-dir>",
    });
    expect(READER_RELEASE_LINES["check@0.2.1"]).toEqual({
      command: "npx @colophon-claims/check@0.2.1 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/check@0.2 <bundle-dir>",
    });
  });

  test("no vector names a reader older than the composed generation's own base line", () => {
    // `binary-qualification` and `anchoring` were first implemented by verify 0.1.0 and
    // `disclosure-specification` by verify 0.2.1, but no verify release understands the composed
    // format, so the maximum is taken against the generation's base: the first checker release.
    expect(COMPOSED_FORMAT_MINIMUM_READER_RELEASE).toBe("check@0.2.1");
    for (const vector of [[], ["anchoring"], ["binary-qualification"], ["binary-qualification", "disclosure-specification"]]) {
      expect(composeClosure(vector).minimumReaderRelease).toBe("check@0.2.1");
      expect(readerInstructions(vector)).toEqual(READER_RELEASE_LINES["check@0.2.1"]);
    }
  });

  test("each capability names the first release implementing it (issue #4746)", () => {
    expect(Object.fromEntries(CAPABILITY_REGISTRY.map((entry) => [entry.token, entry.minimumReaderRelease]))).toEqual({
      "binary-qualification": "verify@0.1.0",
      anchoring: "verify@0.1.0",
      "disclosure-specification": "verify@0.2.1",
      // New with the composed generation: no verify release implements it.
      "external-import": "check@0.2.1",
      "slot-denominators": "check@0.2.1",
    });
  });

  test("the derivation is a maximum over the declared capabilities and the base", () => {
    const later = entry("later", 1, { minimumReaderRelease: "check@0.2.1" });
    const earlier = entry("earlier", 2, { minimumReaderRelease: "verify@0.1.0" });
    expect(composeClosure(["earlier", "later"], [later, earlier]).minimumReaderRelease).toBe("check@0.2.1");
    expect(composeClosure(["earlier"], [earlier]).minimumReaderRelease).toBe("check@0.2.1");
  });
});

describe("producer-side activation", () => {
  const NONE = {
    anchoredClosure: false,
    projectsBinaryQualification: false,
    declaresDisclosure: false,
    importedRun: false,
    wilsonReport: false,
  };

  test("each predicate turns on exactly its own token, in canonical wire order", () => {
    expect(activeCapabilityVector(NONE)).toEqual([]);
    expect(activeCapabilityVector({ ...NONE, anchoredClosure: true })).toEqual(["anchoring"]);
    expect(activeCapabilityVector({ ...NONE, projectsBinaryQualification: true }))
      .toEqual(["binary-qualification"]);
    expect(activeCapabilityVector({ ...NONE, importedRun: true })).toEqual(["external-import"]);
    expect(activeCapabilityVector({ ...NONE, wilsonReport: true })).toEqual(["slot-denominators"]);
    expect(activeCapabilityVector({
      anchoredClosure: true,
      projectsBinaryQualification: true,
      declaresDisclosure: true,
      importedRun: false,
      wilsonReport: false,
    })).toEqual(["anchoring", "binary-qualification", "disclosure-specification"]);
    expect(activeCapabilityVector({
      anchoredClosure: true,
      projectsBinaryQualification: true,
      declaresDisclosure: true,
      importedRun: true,
      wilsonReport: false,
    })).toEqual(["anchoring", "binary-qualification", "disclosure-specification", "external-import"]);
    expect(activeCapabilityVector({ ...NONE, anchoredClosure: true, importedRun: true, wilsonReport: true }))
      .toEqual(["anchoring", "external-import", "slot-denominators"]);
  });

  test("a declaration rides the qualification analysis alone, and needs no anchor", () => {
    // A run publishes one bundle per analysis. The record is named by the qualification Report's
    // own extension, so a sibling headline or comparison analysis never carried it (issue #2839).
    expect(activeCapabilityVector({ ...NONE, declaresDisclosure: true })).toEqual([]);
    expect(activeCapabilityVector({ ...NONE, anchoredClosure: true, declaresDisclosure: true }))
      .toEqual(["anchoring"]);
    // The cell the closure model never allocated: disclosed and qualified, unanchored.
    expect(activeCapabilityVector({ ...NONE, projectsBinaryQualification: true, declaresDisclosure: true }))
      .toEqual(["binary-qualification", "disclosure-specification"]);
  });

  test("every activated vector resolves", () => {
    for (const anchoredClosure of [false, true]) {
      for (const projectsBinaryQualification of [false, true]) {
        for (const declaresDisclosure of [false, true]) {
          for (const importedRun of [false, true]) {
            for (const wilsonReport of [false, true]) {
              const facts = { anchoredClosure, projectsBinaryQualification, declaresDisclosure, importedRun, wilsonReport };
              expect(() => composeClosure(activeCapabilityVector(facts)), JSON.stringify(facts)).not.toThrow();
            }
          }
        }
      }
    }
  });
});
