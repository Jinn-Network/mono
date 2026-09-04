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
 *
 * Three widenings since (#3952, #3953, #3954) close the ways a site reached the face without the
 * scan seeing it, and one (#3955) stops it reading a file that cannot commit the offence:
 *
 * - An emitter is keyed by the module that declares it, not by its bare name, and each occurrence
 *   is resolved back to that module through the file's own imports. `buildLocalVenueHonesty` is not
 *   a unique name in this tree, and the unrelated one would otherwise be handed a constraint its
 *   callers cannot satisfy.
 * - `runBindingClass` is an emitter too: the label it writes is precisely the harm
 *   `core/src/binding/carriage.ts` names, so a site printing "proven-offline" from an unchecked
 *   binding commits the same offence as one printing the sentence.
 * - A bare value reference -- `bindings.map(runBindingSentence)`, `const emit = runBindingSentence`
 *   -- reaches the face without ever being a call. It cannot be checked for which argument carries
 *   the binding, so it is required to carry the marker unconditionally and be pinned.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every product member's source, read off the tree rather than listed here: the face is exported
 * from this package's public entry, so `cli` and `web` can reach it as readily as `core` can, and a
 * hard-coded pair would stop scanning the member a future caller lands in. `web` reaches it from
 * `.tsx` rather than `.ts` -- its results page already renders `venueHonesty.limits` as a list --
 * so both extensions are read (#3757).
 */
const productRoot = resolve(import.meta.dirname, "../../..");
const memberDirectories = readdirSync(productRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
  .map((entry) => entry.name);
const memberRoots = memberDirectories
  .map((name) => join(productRoot, name, "src"))
  .filter((directory) => existsSync(directory));

/**
 * Each member's package name, read off its own manifest, so a cross-member import
 * (`@colophon-claims/verify`) resolves to a module path the same way a relative one does. Read
 * rather than listed for the reason the roots are: a renamed or added member must not silently stop
 * resolving.
 */
const memberByPackageName = new Map<string, string>(
  memberDirectories.flatMap((name) => {
    const manifest = join(productRoot, name, "package.json");
    if (!existsSync(manifest)) return [];
    const packageName: unknown = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
    return typeof packageName === "string" ? [[packageName, name] as const] : [];
  }),
);

/**
 * The functions through which a binding becomes reader-visible prose, keyed by the module that
 * declares each one and the zero-based argument position that carries the binding:
 * `buildLocalVenueHonesty(cells, run, anchors, binding)`, `runBoundVenueLimits(limits, binding)`,
 * `runBindingSentence(binding)` and `runBindingClass(binding)`.
 *
 * `runBindingSentence` is the one that literally builds the face sentence; `runBoundVenueLimits` and
 * `buildLocalVenueHonesty` are wrappers over it, so a site writing
 * `limits.push(runBindingSentence(binding))` is the most direct form of the bypass this file exists
 * to make visible, and is covered here rather than assumed away (#3757). `runBindingClass` writes
 * the class label instead of the sentence, which is the same disclosure in one word (#3953).
 *
 * Keyed by module because the bare name is not unique in this tree (#3952):
 * `core/src/operations/run-results.ts` exports an unrelated three-parameter
 * `buildLocalVenueHonesty`, and its callers must not be handed a constraint about an argument they
 * do not pass. The failure direction was the safe one -- noise, not a hole -- but the noise landed
 * on someone editing a function with nothing to do with binding carriage.
 */
const EMITTERS: ReadonlyArray<readonly [string, string, number]> = [
  ["verify/src/profile/run-results.ts", "buildLocalVenueHonesty", 3],
  ["verify/src/binding/report-face.ts", "runBoundVenueLimits", 1],
  ["verify/src/binding/report-face.ts", "runBindingSentence", 0],
  ["verify/src/binding/report-face.ts", "runBindingClass", 0],
];

/**
 * The marker a site writes when it deliberately does supply a binding, followed inline by which
 * check makes that sound. One exact token rather than a pattern over prose, so `grep
 * "binding-carriage:"` finds every such decision at once.
 */
const JUSTIFICATION = /\bbinding-carriage:/u;

/**
 * What a site supplied, where an argument position cannot say it: a bare value reference hands the
 * whole function on and no position carries the binding, so the marker is required unconditionally
 * rather than conditioned on an argument that does not exist (#3954).
 */
const VALUE_REFERENCE = "(value reference)";

/**
 * The complete set of marker-bearing sites. A forward is not an origin: `buildLocalVenueHonesty`
 * passes its own optional parameter through, so the obligation belongs to whoever supplies it, and
 * no in-repo caller does. Any addition here is the change #3464 exists to make visible.
 *
 * The three `runBindingSentence` origins covered since #3757 are the wrapper inside `report-face.ts`
 * -- which states that it forwards rather than originates -- and the two `core` operations that
 * reach the sentence from a binding this run's own sealed identity vouches for. `run-status.ts`
 * appears twice since #3953: it writes the class label and the sentence from the same checked
 * binding, and each is its own emission.
 */
const EXPECTED_JUSTIFIED_SITES = [
  "core/src/operations/run-bind.ts:runBindingSentence",
  "core/src/operations/run-status.ts:runBindingClass",
  "core/src/operations/run-status.ts:runBindingSentence",
  "verify/src/binding/report-face.ts:runBindingSentence",
  "verify/src/profile/run-results.ts:runBoundVenueLimits",
];

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

/**
 * Import and re-export statements blanked the same way, so naming an emitter in one is not read as
 * using it (#3954). A module statement is where every legitimate mention of the name that is
 * neither a call nor a declaration lives -- `verify/src/index.ts` re-exports all three off the face
 * -- and counting those would make the reference scan report the export list rather than any site.
 * Blanked after comments, and only where the statement starts a line, so an `export const` or an
 * ordinary object literal is untouched.
 */
function blankModuleStatements(text: string): string {
  return text.replace(
    /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*(?:from\s*["'][^"']*["'])?\s*;?/gmu,
    (match) => match.replace(/[^\n]/gu, " "),
  );
}

/**
 * A file this scan reads. `.tsx` counts for the reason `.ts` does -- `web` is a product member and
 * writes its pages in `.tsx` -- and a test file is excluded under either extension, since a fixture
 * asserting the violating shape is not a site that commits it (#3757).
 *
 * A declaration file is excluded for the stronger reason that it cannot commit the offence at all:
 * it declares a signature and calls nothing (#3955). Left admitted it would be a false-positive
 * source rather than a hole, because the declaration-skip lookback below covers only the `function`
 * form -- an interface member `readonly runBindingSentence: (binding: VerifiedRunBinding) => string`
 * would read as a call supplying a binding.
 */
export function isScannedSource(name: string): boolean {
  return (name.endsWith(".ts") || name.endsWith(".tsx"))
    && !name.endsWith(".d.ts")
    && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx");
}

/**
 * String contents blanked the same way, for both scans: a help string, an error message or a log
 * line naming the emitter is prose about it, not a use of it, and reading one as a site would be
 * exactly the misdirected noise #3952 was filed to remove.
 *
 * Walked rather than matched, because the three string forms nest. A template literal's TEXT is
 * blanked but its `${...}` expressions are not -- `${runBindingSentence(binding)}` is code, and
 * blanking it would hide the shape this file exists to see -- and an apostrophe inside that text
 * ("it's") must not open a quoted run, which is what a regex over the three forms would do. The
 * quotes and backticks themselves survive, so `topLevelArguments` still reads its own depth, and
 * newlines survive so every offset and line number does.
 */
function blankStringLiterals(text: string): string {
  const out = text.split("");
  // Guarded on both ends: a newline keeps every line number, and an escape at the very end of
  // the text must not append a character the source never had.
  const blank = (index: number): void => { if (index < out.length && out[index] !== "\n") out[index] = " "; };
  // "`" marks template text; "{" marks a brace-delimited code region, including the one a `${`
  // opens, so a nested object literal inside an interpolation closes the right brace.
  const stack: string[] = [];
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== undefined) {
      // A quoted string cannot contain a raw newline, so one ends the run whether or not the
      // closing quote arrived. That bounds the damage of an unmatched quote -- an unterminated
      // literal, or one inside a regex literal such as `/['\"]/`, which is not parsed here -- to
      // its own line, rather than blanking the rest of the file and hiding every site in it.
      if (character === "\n") { quote = undefined; continue; }
      if (character === "\\") { blank(index); blank(index + 1); index += 1; continue; }
      if (character === quote) { quote = undefined; continue; }
      blank(index);
      continue;
    }
    if (stack.at(-1) === "`") {
      if (character === "\\") { blank(index); blank(index + 1); index += 1; continue; }
      if (character === "`") { stack.pop(); continue; }
      if (character === "$" && text[index + 1] === "{") { stack.push("{"); index += 1; continue; }
      blank(index);
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "`") { stack.push("`"); continue; }
    if (character === "{") { stack.push("{"); continue; }
    if (character === "}" && stack.at(-1) === "{") stack.pop();
  }
  return out.join("");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    // `testing/` is scanned like any other source: a fixture builder that assembles a bundle is
    // exactly where a binding record would first be added, so exempting it would exempt the case.
    if (["node_modules", "dist", ".next"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && isScannedSource(entry.name) ? [path] : [];
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

/**
 * The module specifier one file names `name` in, whether it imports it or re-exports it: the entry
 * a caller reaches the face through re-exports it, so following a hop reads the same statement
 * shape the caller wrote.
 *
 * An aliased binding (`import { runBindingSentence as emit }`) is not matched, and the scan then
 * sees neither the origin nor any occurrence of the name -- a bypass of the same family as #3954,
 * pre-existing for every emitter and not narrowed by it. Stated rather than left to be discovered.
 */
function importedFrom(source: string, name: string): string | undefined {
  for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gmu)) {
    const bound = match[1]!.split(",").map((entry) => entry.trim().split(/\s+as\s+/u).at(-1)!.trim());
    if (bound.includes(name)) return match[2]!;
  }
  return undefined;
}

/** The product-relative module a specifier names, for a relative path or a member package name. */
function moduleForSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(fromFile), specifier.replace(/\.js$/u, ".ts"));
    const module = relative(productRoot, target);
    // A specifier that climbs out of the product is not a module this scan can key on, and
    // following one would read a file the scan never walked.
    return existsSync(target) && !module.startsWith("..") ? module : undefined;
  }
  const member = memberByPackageName.get(specifier);
  if (member === undefined) return undefined;
  const entry = join(productRoot, member, "src", "index.ts");
  return existsSync(entry) ? relative(productRoot, entry) : undefined;
}

/**
 * The module that declares the `name` this file uses: followed from the statement that names it,
 * through re-exports (`@colophon-claims/verify` names the package entry, which re-exports the face
 * from `binding/report-face.ts`), until a module is reached that actually declares it.
 *
 * `undefined` means the origin could not be established, and the scan then treats the occurrence as
 * an emitter's -- the same loud direction the whole file takes. Incomplete resolution MUST return
 * `undefined` rather than the last module reached: a barrel (`export * from ...`, which this does
 * not follow) would otherwise resolve to the barrel, mismatch every emitter module, and silently
 * drop the file's real calls. Dropping is reserved for positive evidence -- the chain ended at a
 * declaration, and it was not the emitter's (#3952).
 */
export function resolveOrigin(source: string, filePath: string, name: string): string | undefined {
  const declared = new RegExp(
    String.raw`(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+${name}\b`,
    "u",
  );
  // Read through blanked comments, for the reason the scans do: a commented-out import naming the
  // emitter would otherwise resolve the origin to a module this file never reaches, and a wrong
  // origin drops the file's real calls -- the same silent-hole shape the barrel case had.
  const code = blankComments(source);
  const specifier = importedFrom(code, name);
  if (specifier === undefined) return declared.test(code) ? relative(productRoot, filePath) : undefined;
  let module = moduleForSpecifier(specifier, filePath);
  const seen = new Set<string>();
  while (module !== undefined && !seen.has(module)) {
    seen.add(module);
    const absolute = join(productRoot, module);
    if (!existsSync(absolute)) return undefined;
    const hopSource = blankComments(readFileSync(absolute, "utf8"));
    if (declared.test(hopSource)) return module;
    const hop = importedFrom(hopSource, name);
    module = hop === undefined ? undefined : moduleForSpecifier(hop, absolute);
  }
  return undefined;
}

interface CallSite {
  readonly site: string;
  readonly binding: string | undefined;
  readonly justified: boolean;
}

/**
 * Every emitter call in one file, with the binding argument it supplies and whether it is marked,
 * plus every bare value reference to an emitter, which supplies the face wholesale and so carries
 * the obligation unconditionally. A declaration (`function name(`) is not a call and is skipped.
 *
 * `origins` maps an emitter name to the module the file gets it from; a name absent from the map is
 * unresolved and counted, which is the behaviour this scan had before it could resolve anything.
 */
export function emitterCallSites(
  source: string,
  label: string,
  origins: ReadonlyMap<string, string | undefined> = new Map(),
): CallSite[] {
  const blanked = blankStringLiterals(blankComments(source));
  const references = blankModuleStatements(blanked);
  const rawLines = source.split("\n");
  // `import * as face from ...` binds the emitter behind a namespace, so `face.runBindingSentence`
  // IS the emitter rather than an unrelated object's property, and the member-access skip below
  // must not swallow it. Read off the statements before they are blanked.
  const namespaces = new Set(
    [...blanked.matchAll(/^[ \t]*import\s+\*\s+as\s+(\w+)\s+from/gmu)].map((match) => match[1]!),
  );
  const sites: CallSite[] = [];
  const marked = (index: number): boolean => {
    const line = blanked.slice(0, index).split("\n").length - 1;
    return JUSTIFICATION.test(rawLines.slice(Math.max(0, line - 8), line + 1).join("\n"));
  };
  for (const [module, name, position] of EMITTERS) {
    const origin = origins.get(name);
    if (origin !== undefined && origin !== module) continue;
    for (const match of blanked.matchAll(new RegExp(String.raw`\b${name}\s*\(`, "gu"))) {
      const index = match.index!;
      if (/\b(?:function|const|let|var)\s+$/u.test(blanked.slice(Math.max(0, index - 24), index))) continue;
      const args = topLevelArguments(blanked, index + match[0].length - 1);
      if (args === undefined) throw new Error(`${label}: unterminated call to ${name}`);
      sites.push({ site: `${label}:${name}`, binding: args[position], justified: marked(index) });
    }
    for (const match of references.matchAll(new RegExp(String.raw`\b${name}\b`, "gu"))) {
      const index = match.index!;
      const before = references.slice(Math.max(0, index - 24), index);
      const after = references.slice(index + name.length, index + name.length + 24);
      // A call is already counted above. A declaration introduces the emitter rather than passing
      // it on, and `typeof name` reads its type rather than the function.
      if (/^\s*\(/u.test(after)) continue;
      if (/\b(?:function|const|let|var|class)\s+$/u.test(before)) continue;
      if (/\btypeof\s+$/u.test(before)) continue;
      // A member access names someone else's property -- unless the object is a namespace import,
      // in which case it names this emitter.
      const member = /(\w+)\s*\??\s*\.\s*$/u.exec(before);
      if (member !== null && !namespaces.has(member[1]!)) continue;
      // A property KEY (`{ runBindingSentence: other }`) declares a name rather than reading one,
      // and is distinguished from a ternary branch (`flag ? runBindingSentence : other`, which IS
      // a reference) by what precedes it: a key opens its entry, a branch follows an operator.
      if (/^\s*:/u.test(after) && /(?:^|[{,\n])\s*$/u.test(before)) continue;
      sites.push({ site: `${label}:${name}`, binding: VALUE_REFERENCE, justified: marked(index) });
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
    // The sentence builder itself, whose only argument IS the binding: the shape a site takes to
    // push the face onto a list without going through either wrapper (#3757).
    expect(emitterCallSites("limits.push(runBindingSentence(forged));\n", "fixture.ts")[0]).toEqual({
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    });
    // The class label is the same disclosure in one word, and is detected the same way (#3953).
    expect(emitterCallSites("const label = runBindingClass(forged);\n", "fixture.ts")[0]).toEqual({
      site: "fixture.ts:runBindingClass",
      binding: "forged",
      justified: false,
    });
  });

  // A bare reference hands the face on without ever being a call, which is the shape the scan used
  // to pass over entirely (#3954).
  test("detects a value reference to an emitter, and does not read a module statement as one", () => {
    expect(emitterCallSites("const lines = bindings.map(runBindingSentence);\n", "fixture.ts")).toEqual([
      { site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false },
    ]);
    expect(emitterCallSites("const emit = runBindingSentence;\n", "fixture.ts")).toEqual([
      { site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false },
    ]);
    const marked = "// binding-carriage: checked by readRunBindingCarriage above.\nconst emit = runBindingSentence;\n";
    expect(emitterCallSites(marked, "fixture.ts")[0]?.justified).toBe(true);
    // The export list `verify/src/index.ts:206` writes, and the import a caller writes: naming the
    // face is how a module hands it over, not a site that emits it.
    expect(emitterCallSites('export { runBindingClass, runBindingSentence } from "./binding/report-face.js";\n', "fixture.ts"))
      .toEqual([]);
    expect(emitterCallSites('import {\n  runBindingSentence,\n} from "@colophon-claims/verify";\n', "fixture.ts"))
      .toEqual([]);
    // A declaration introduces the emitter rather than passing it on, in either form.
    expect(emitterCallSites("export function runBindingSentence(binding) {\n  return \"\";\n}\n", "fixture.ts"))
      .toEqual([]);
    // A property named after the emitter is a key, not a reference to the function -- but a
    // ternary branch is a reference, and both sit before a colon.
    expect(emitterCallSites("const table = { runBindingSentence: other };\n", "fixture.ts")).toEqual([]);
    expect(emitterCallSites("const emit = flag ? runBindingSentence : other;\n", "fixture.ts")).toEqual([
      { site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false },
    ]);
    // A member access names someone else's property, not the emitter this file imported -- but a
    // namespace import binds the emitter itself behind exactly that shape.
    expect(emitterCallSites("const emit = report.runBindingSentence;\n", "fixture.ts")).toEqual([]);
    const namespaced = 'import * as face from "@colophon-claims/verify";\nconst emit = face.runBindingSentence;\n';
    expect(emitterCallSites(namespaced, "fixture.ts")).toEqual([
      { site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false },
    ]);
    // Prose inside a string is not a reference, and a type position emits nothing at runtime.
    expect(emitterCallSites('const help = "the sentence comes from runBindingSentence";\n', "fixture.ts"))
      .toEqual([]);
    expect(emitterCallSites("type Emitter = typeof runBindingSentence;\n", "fixture.ts")).toEqual([]);
  });

  // All three string forms nest, and both scans read through the same blanking, so each form is
  // proven on both sides: prose naming an emitter is not a site, and code inside an interpolation
  // still is.
  test("reads through every string form: prose is not a site, an interpolation still is", () => {
    // Prose in each of the three forms, for the call shape and the reference shape.
    expect(emitterCallSites('const help = "call runBindingSentence(binding) to render";\n', "fixture.ts"))
      .toEqual([]);
    expect(emitterCallSites("const help = 'call runBindingSentence(binding) to render';\n", "fixture.ts"))
      .toEqual([]);
    expect(emitterCallSites("const help = `the sentence comes from runBindingSentence`;\n", "fixture.ts"))
      .toEqual([]);
    // An apostrophe inside template TEXT must not open a quoted run and hide the code between two
    // of them -- ordinary English prose around an interpolation is the shape that does it.
    expect(emitterCallSites("const line = `it's ${items.map(runBindingSentence)} — don't`;\n", "fixture.ts"))
      .toEqual([{ site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false }]);
    // And the interpolation's own code is read as code, in either shape.
    expect(emitterCallSites("const line = `bound: ${runBindingSentence(forged)}`;\n", "fixture.ts")[0])
      .toEqual({ site: "fixture.ts:runBindingSentence", binding: "forged", justified: false });
    // A nested object literal inside the interpolation closes the right brace, so the text after
    // it is still text.
    expect(emitterCallSites("const line = `${f({ a: 1 })} runBindingSentence`;\n", "fixture.ts")).toEqual([]);
    // An unmatched quote -- a regex literal the walker does not parse, or a genuinely unterminated
    // string -- ends at its own line rather than blanking every site below it.
    expect(emitterCallSites("const q = /['\"]/u;\nconst s = runBindingSentence(forged);\n", "fixture.ts")[0])
      .toEqual({ site: "fixture.ts:runBindingSentence", binding: "forged", justified: false });
  });

  // The marker lookback counts lines in the blanked text and reads them out of the raw source, so
  // every blanking step must preserve length and line count exactly. Asserted over the real tree
  // rather than a fixture, because the shapes that could break it -- an escape at end of file, a
  // line continuation, a nested template -- are what the tree contains and a fixture guesses at.
  test("blanking preserves every offset and line number across the scanned tree", () => {
    const files = memberRoots.flatMap((directory) => sourceFiles(directory));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const blanked = blankStringLiterals(blankComments(source));
      expect(blanked.length, file).toBe(source.length);
      expect(blanked.split("\n").length, file).toBe(source.split("\n").length);
    }
  });

  // The bare name is not unique in this tree, so the key is proven to discriminate before the scan
  // is pointed anywhere (#3952) -- and proven against the real modules rather than a fixture, since
  // the two same-named functions are the fact being relied on.
  test("keys an emitter by its declaring module, so a same-named function elsewhere is not one", () => {
    const emitterModule = "verify/src/profile/run-results.ts";
    const otherModule = "core/src/operations/run-results.ts";
    const read = (path: string): [string, string] => [readFileSync(join(productRoot, path), "utf8"), join(productRoot, path)];

    const [verifyCaller, verifyPath] = read("verify/src/profile/claim-consistency.ts");
    expect(resolveOrigin(verifyCaller, verifyPath, "buildLocalVenueHonesty")).toBe(emitterModule);
    const [coreCaller, corePath] = read("core/src/operations/report.ts");
    expect(resolveOrigin(coreCaller, corePath, "buildLocalVenueHonesty")).toBe(otherModule);
    // A package specifier resolves through the entry's re-export to the module that declares it.
    const [statusCaller, statusPath] = read("core/src/operations/run-status.ts");
    expect(resolveOrigin(statusCaller, statusPath, "runBindingClass")).toBe("verify/src/binding/report-face.ts");

    // A commented-out import is not where the name comes from: resolving to it would drop the
    // file's real calls, which is the barrel hole in a different shape.
    const commented = '// import { runBindingSentence } from "./bundle/schema.js";\n';
    expect(resolveOrigin(commented, join(productRoot, "core/src/plant.ts"), "runBindingSentence"))
      .toBeUndefined();

    // A barrel is not a declaration: `export * from` is not followed, so the chain ends unresolved
    // and the occurrence is counted rather than silently dropped against the barrel's own path.
    const barrel = 'import { runBindingSentence } from "./bundle/schema.js";\n';
    expect(resolveOrigin(barrel, join(productRoot, "core/src/plant.ts"), "runBindingSentence")).toBeUndefined();
    expect(emitterCallSites(`${barrel}export const s = runBindingSentence(forged);\n`, "plant.ts",
      new Map([["runBindingSentence", resolveOrigin(barrel, join(productRoot, "core/src/plant.ts"), "runBindingSentence")]]))[0]?.binding)
      .toBe("forged");

    // And the resolved origin is what decides: the same call text is counted under the emitter's
    // module and dropped under the other's.
    const call = "const honesty = buildLocalVenueHonesty(cells, run, anchors, forged);\n";
    expect(emitterCallSites(call, "fixture.ts", new Map([["buildLocalVenueHonesty", emitterModule]])))
      .toHaveLength(1);
    expect(emitterCallSites(call, "fixture.ts", new Map([["buildLocalVenueHonesty", otherModule]])))
      .toEqual([]);
  });

  // The tree walk is widened in the same act, and proven the same way: a predicate that silently
  // stopped admitting `.tsx` would leave the scan passing over the member it was widened for.
  test("reads both source extensions and neither test nor declaration extensions", () => {
    expect(["page.tsx", "report-face.ts"].filter((name) => isScannedSource(name)))
      .toEqual(["page.tsx", "report-face.ts"]);
    expect(["page.test.tsx", "report-face.test.ts"].filter((name) => isScannedSource(name))).toEqual([]);
    expect(["index.d.ts"].filter((name) => isScannedSource(name))).toEqual([]);
  });

  test("every in-repo emitter call either supplies no binding or names the check it satisfies", () => {
    const sites = memberRoots.flatMap((directory) =>
      sourceFiles(directory).flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const origins = new Map(
          EMITTERS.map(([, name]) => [name, resolveOrigin(source, file, name)] as const),
        );
        return emitterCallSites(source, relative(productRoot, file), origins);
      })
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
