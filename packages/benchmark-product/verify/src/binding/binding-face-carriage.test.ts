// SPDX-License-Identifier: Apache-2.0

/**
 * The face is never emitted from a binding nobody cross-checked against the sealed Run (#3464).
 *
 * `verifyRunBinding` proves a binding record is internally consistent: that its order derives from
 * the `sealDigest` it carries, that its beacon postdates the `sealedAt` it carries, and -- under
 * `sourceBasis: "seal-declared"` -- that `declaredSource` agrees with the beacon the record itself
 * names. It never sees the Run. That the record restates the SEALED Run's own fields is a separate
 * check, made by `core/src/binding/carriage.ts` workspace-side and by step 2c of
 * `EXTERNAL-VERIFICATION.md` for an external reader.
 *
 * Today the gap is closed by an accident nothing states: `buildLocalVenueHonesty`'s `binding`
 * parameter is optional and no in-repo caller supplies it, so the public bundle carries no binding
 * record and the face never reaches a reader. A future change that adds the record to the bundle
 * would look like passing an argument that was already there, and a hand-written binding could then
 * print "the sealed record names the beacon this run binds to" over a beacon the seal never named.
 *
 * So this is a source scan, in the shape `core/src/runtime/child-temp-env.test.ts` uses for the
 * same class of per-site obligation: a call site that supplies the binding argument must carry an
 * inline `binding-carriage:` marker saying which check it satisfies, and the exact set of
 * marker-bearing sites is pinned below. Adding one is then a visible, reviewed act -- the test
 * fails and names the constraint -- rather than a silent bypass.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every product member's source, read off the tree rather than listed here: the face is exported
 * from this package's public entry, so `cli` and `web` can reach it as readily as `core` can, and a
 * hard-coded pair would stop scanning the member a future caller lands in.
 */
const productRoot = resolve(import.meta.dirname, "../../..");
const memberRoots = readdirSync(productRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
  .map((entry) => join(productRoot, entry.name, "src"))
  .filter((directory) => existsSync(directory));

/**
 * The two functions through which a binding becomes reader-visible prose, and the zero-based
 * argument position that carries it: `buildLocalVenueHonesty(cells, run, anchors, binding)` and
 * `runBoundVenueLimits(limits, binding)`.
 */
const EMITTERS: ReadonlyArray<readonly [string, number]> = [
  ["buildLocalVenueHonesty", 3],
  ["runBoundVenueLimits", 1],
];

/**
 * The marker a site writes when it deliberately does supply a binding, followed inline by which
 * check makes that sound. One exact token rather than a pattern over prose, so `grep
 * "binding-carriage:"` finds every such decision at once.
 */
const JUSTIFICATION = /\bbinding-carriage:/u;

/**
 * The complete set of marker-bearing sites. A forward is not an origin: `buildLocalVenueHonesty`
 * passes its own optional parameter through, so the obligation belongs to whoever supplies it, and
 * no in-repo caller does. Any addition here is the change #3464 exists to make visible.
 */
const EXPECTED_JUSTIFIED_SITES = ["verify/src/profile/run-results.ts:runBoundVenueLimits"];

const CONSTRAINT = [
  "A binding may be turned into reader-facing prose only after it has been cross-checked against",
  "the sealed Run: `readRunBindingCarriage` (core/src/binding/carriage.ts) workspace-side, or step",
  "2c of EXTERNAL-VERIFICATION.md for an external reader. `verifyRunBinding` alone does NOT",
  "establish this -- it never sees the Run. If this site is sound, write an inline",
  "`binding-carriage:` comment above it naming the check it satisfies, and add it to",
  "EXPECTED_JUSTIFIED_SITES in this file so the addition is reviewed rather than assumed.",
].join(" ");

/** Comments blanked to same-length runs, so offsets and line numbers survive and prose about a
 * binding is not read as one. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, (match) => match.replace(/[^\n]/gu, " "));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    // `testing/` is scanned like any other source: a fixture builder that assembles a bundle is
    // exactly where a binding record would first be added, so exempting it would exempt the case.
    if (["node_modules", "dist", ".next"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * The top-level arguments of one call, read off the text. Depth is tracked across every bracket
 * pair and both quote forms so a nested call, an object literal, or a comma inside a string is
 * never mistaken for an argument separator.
 */
function topLevelArguments(text: string, openParen: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = openParen + 1;
  let quote: string | undefined;
  for (let index = openParen; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) {
        // A trailing comma is punctuation, not an argument: `f(a, b, c,)` passes three. Dropping
        // the empty tail is what keeps a multi-line call from reading as one that supplies a
        // binding it never wrote.
        const tail = text.slice(start, index).trim();
        if (tail !== "") args.push(tail);
        return args;
      }
    } else if (character === "," && depth === 1) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return undefined;
}

interface CallSite {
  readonly site: string;
  readonly binding: string | undefined;
  readonly justified: boolean;
}

/** Every emitter call in one file, with the binding argument it supplies and whether it is marked.
 * A declaration (`function name(`) is not a call and is skipped. */
export function emitterCallSites(source: string, label: string): CallSite[] {
  const blanked = blankComments(source);
  const rawLines = source.split("\n");
  const sites: CallSite[] = [];
  for (const [name, position] of EMITTERS) {
    for (const match of blanked.matchAll(new RegExp(String.raw`\b${name}\s*\(`, "gu"))) {
      const index = match.index!;
      if (/\b(?:function|const|let|var)\s+$/u.test(blanked.slice(Math.max(0, index - 24), index))) continue;
      const args = topLevelArguments(blanked, index + match[0].length - 1);
      if (args === undefined) throw new Error(`${label}: unterminated call to ${name}`);
      const line = blanked.slice(0, index).split("\n").length - 1;
      const window = rawLines.slice(Math.max(0, line - 8), line + 1).join("\n");
      sites.push({
        site: `${label}:${name}`,
        binding: args[position],
        justified: JUSTIFICATION.test(window),
      });
    }
  }
  return sites;
}

describe("the binding face is never emitted from an unchecked binding", () => {
  // The detector is proven to detect before it is pointed at the tree: a scan that silently found
  // nothing would pass exactly as loudly as one that found nothing because there is nothing.
  test("detects a site that supplies a binding, and clears one that marks or omits it", () => {
    const violating = "const honesty = buildLocalVenueHonesty(cells, run, anchors, forged);\n";
    expect(emitterCallSites(violating, "fixture.ts")[0]).toEqual({
      site: "fixture.ts:buildLocalVenueHonesty",
      binding: "forged",
      justified: false,
    });
    const marked = `// binding-carriage: checked by readRunBindingCarriage above.\n${violating}`;
    expect(emitterCallSites(marked, "fixture.ts")[0]?.justified).toBe(true);
    // Prose is not a call: a comment naming the emitter must not be read as one.
    expect(emitterCallSites("// see runBoundVenueLimits(limits, binding)\n", "fixture.ts")).toEqual([]);
    // Omitting the argument is the compliant shape, and a nested call is one argument, not two.
    expect(emitterCallSites("runBoundVenueLimits(anchoredVenueLimits(limits, anchors));\n", "fixture.ts")[0])
      .toEqual({ site: "fixture.ts:runBoundVenueLimits", binding: undefined, justified: false });
    // A trailing comma is not a fourth argument. The multi-line shape `core` writes is otherwise
    // indistinguishable from one that supplies an empty binding.
    expect(emitterCallSites("buildLocalVenueHonesty(\n  cells,\n  run,\n  anchors,\n);\n", "fixture.ts")[0]?.binding)
      .toBeUndefined();
  });

  test("every in-repo emitter call either supplies no binding or names the check it satisfies", () => {
    const sites = memberRoots.flatMap((directory) =>
      sourceFiles(directory).flatMap((file) =>
        emitterCallSites(readFileSync(file, "utf8"), relative(productRoot, file))
      )
    );
    // A vacuous pass is a failed scan: the emitters are called somewhere, or the names moved, and
    // the member roots are read off a tree that must contain more than this package.
    expect(memberRoots.length).toBeGreaterThan(1);
    expect(sites.length).toBeGreaterThan(0);
    const unjustified = sites
      .filter((entry) => entry.binding !== undefined && entry.binding !== "undefined" && !entry.justified)
      .map((entry) => `${entry.site}(binding: ${entry.binding})`);
    expect(unjustified, `emits the binding face from an unchecked binding. ${CONSTRAINT}`).toEqual([]);
    expect(
      sites.filter((entry) => entry.binding !== undefined && entry.justified).map((entry) => entry.site).sort(),
      `a new site now supplies the binding face a binding. ${CONSTRAINT}`,
    ).toEqual([...EXPECTED_JUSTIFIED_SITES].sort());
  });
});
