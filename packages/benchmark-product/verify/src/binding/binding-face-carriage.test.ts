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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const STRING_OPENERS = new Set(["=", "(", ",", ":"]);

function sameLineStringCloser(text: string, opener: number): number | undefined {
  const quote = text[opener]!;
  for (let closer = opener + 1; closer < text.length && text[closer] !== "\n"; closer += 1) {
    const candidate = text[closer]!;
    if (candidate === "\\") {
      if (text[closer + 1] === ";" || text[closer + 1] === "\n") return undefined;
      closer += 1;
      continue;
    }
    if (candidate === ";") return undefined;
    if (candidate === quote) return closer;
  }
  return undefined;
}

/**
 * Comments blanked to same-length runs, so offsets and line numbers survive and prose about a
 * binding is not read as one.
 *
 * A `//` inside a string literal (`"https://example.com"`) is not a comment opener, so a call
 * sharing that line is still seen (#4020). That was the residue worth closing, because it HID a
 * site; the walker below is deliberately narrower than the one reverted here, which lexed all three
 * nesting forms and, on a stray backtick in a regex character class (the tree contains one, at
 * `core/src/run/publication-source.ts:476`), went into template mode to end of file and blanked a
 * whole tail silently. So: backticks are not parsed, quotes use the same narrow opener confidence as
 * `blankStringLiterals`, and quote state is dropped at every newline. A slash seen in ordinary code
 * makes later recognition ambiguous only through the end of that statement; a semicolon starts the
 * next statement cleanly. Once a backtick or rejected quote makes a line opaque, nothing later on
 * that line is blanked. A quote that never closes on its line therefore costs at most the comment
 * blanking on the rest of THAT line -- a comment read as code, which is the loud direction -- and
 * can never reach the next line, let alone the file's tail.
 */
function blankComments(text: string): string {
  // Split by UTF-16 unit, which is what `text[index]` reads: spreading would split by code
  // point and desync every offset after the first astral character.
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) if (out[index] !== "\n") out[index] = " ";
  };
  let mode: "code" | "line" | "block" | "opaque" = "code";
  let start = 0;
  let previousToken: string | undefined;
  let slashSeen = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (mode === "line") {
      if (character === "\n") {
        blank(start, index);
        mode = "code";
        previousToken = undefined;
        slashSeen = false;
      }
      continue;
    }
    if (mode === "block") {
      // An unterminated block comment is left as written, which is what the regex this replaced
      // did: only a closed comment is blanked.
      if (character === "*" && text[index + 1] === "/") { blank(start, index + 2); index += 1; mode = "code"; }
      else if (character === "\n") { previousToken = undefined; slashSeen = false; }
      continue;
    }
    if (mode === "opaque") {
      if (character === "\n") {
        mode = "code";
        previousToken = undefined;
        slashSeen = false;
      }
      continue;
    }
    if (character === "\n") { previousToken = undefined; slashSeen = false; }
    if (character === "/" && text[index + 1] === "/") {
      if (slashSeen) mode = "opaque";
      else { mode = "line"; start = index; index += 1; }
    } else if (character === "/" && text[index + 1] === "*") {
      if (slashSeen) mode = "opaque";
      else { mode = "block"; start = index; index += 1; }
    } else if (character === '"' || character === "'") {
      if (slashSeen || (previousToken !== undefined && !STRING_OPENERS.has(previousToken))) {
        mode = "opaque";
      } else {
        const closer = sameLineStringCloser(text, index);
        if (closer === undefined) {
          mode = "opaque";
        } else {
          previousToken = character;
          index = closer;
        }
      }
    } else if (character === "`") {
      mode = "opaque";
    } else {
      if (character === ";") slashSeen = false;
      else if (character === "/") slashSeen = true;
      if (!/\s/u.test(character)) previousToken = character;
    }
  }
  if (mode === "line") blank(start, text.length);
  return out.join("");
}

/**
 * The interiors of terminated same-line single- and double-quoted strings are blanked, so a call
 * written inside a string is not read as one (#4020). A quote opens a span only at line start or
 * after the preceding non-whitespace token =, (, comma, or colon, and only before an unblanked
 * slash has appeared on that line. After any quote candidate is rejected -- whether because of a
 * prior slash or an unsafe opener context -- blanking stops for the remainder of that line. Earlier
 * recognized strings stay blanked, while every character at and after the ambiguity stays visible
 * and fails loud. A slash inside a recognized string does not taint later code because the scan
 * advances over the whole string body.
 *
 * A would-be span containing a semicolon also stays visible because it may cross an executable
 * statement boundary. It stops blanking for the rest of the line instead of resuming at its closer,
 * and an unclosed eligible opener scans the rest of its line once, so total work is linear per line.
 * Run over comment-blanked text, so an apostrophe inside a comment cannot open a string here.
 *
 * Applied only inside `emitterCallSites`, never folded into `blankComments`: `resolveOrigin` reads
 * the import SPECIFIER off that function's output, and blanking interiors there would resolve every
 * file's origin to the empty specifier and silently drop its real calls -- the barrel hole in a
 * third shape. Same narrowness as above: a backtick stops the line instead of being parsed, and no
 * quote state crosses a newline.
 */
function blankStringLiterals(text: string): string {
  return text.split("\n").map((line) => {
    const out = line.split("");
    let previousToken: string | undefined;
    let slashSeen = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (character !== '"' && character !== "'") {
        if (character === "`") break;
        if (character === "/") slashSeen = true;
        if (!/\s/u.test(character)) previousToken = character;
        continue;
      }
      if (slashSeen || (previousToken !== undefined && !STRING_OPENERS.has(previousToken))) {
        break;
      }

      const closer = sameLineStringCloser(line, index);
      if (closer === undefined) break;
      for (let blank = index + 1; blank < closer; blank += 1) out[blank] = " ";
      previousToken = character;
      index = closer;
    }
    return out.join("");
  }).join("\n");
}

/**
 * Import and re-export statements blanked the same way, so naming an emitter in one is not read as
 * using it (#3954). A module statement is where every legitimate mention of the name that is
 * neither a call nor a declaration lives -- `verify/src/index.ts` re-exports all three off the face
 * -- and counting those would make the reference scan report the export list rather than any site.
 * Blanked after comments, and only where the statement starts a line, so an `export const` or an
 * ordinary object literal is untouched. A default clause before the brace
 * (`import defaultThing, { runBindingSentence } from ...`) is part of the same statement (#4017);
 * left unmatched, the statement itself read as a value reference.
 */
function blankModuleStatements(text: string): string {
  return text.replace(
    /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|(?:\w+\s*,\s*)?\{[^}]*\})\s*(?:from\s*["'][^"']*["'])?\s*;?/gmu,
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
 * source rather than a hole, and the shape that fires is an interface member such as `readonly
 * runBindingSentence: (binding: VerifiedRunBinding) => string`. Not as a call -- the call regex is
 * `\bname\s*\(`, and the member puts a `:` between the name and the paren, so no call matches and
 * the declaration-skip lookback never comes into it (#4019). It fires through the VALUE-REFERENCE
 * scan: the file's `declare function` form makes `bindsEmitter` true, which opens that scan, and the
 * member then escapes its property-key skip, because the skip requires nothing but whitespace before
 * the name since a `{`, `,` or newline, and `readonly ` is not nothing.
 */
export function isScannedSource(name: string): boolean {
  return (name.endsWith(".ts") || name.endsWith(".tsx"))
    && !name.endsWith(".d.ts")
    && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx");
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
 * The LOCAL name comes back with the specifier, because it is the name the file's own text uses:
 * `import { runBindingSentence as emit }` binds the emitter as `emit`, and a scan searching the
 * declared name sees neither the call nor the reference. A default clause before the brace is read
 * as part of the same statement for the same reason -- unmatched, it made `bindsEmitter` false and
 * skipped the value-reference scan for the whole file (#4017).
 *
 * Matched on either side of an `as`, since a re-export renames in the other direction.
 */
function importedFrom(source: string, name: string): { specifier: string; local: string } | undefined {
  for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gmu)) {
    for (const entry of match[1]!.split(",")) {
      const parts = entry.trim().split(/\s+as\s+/u).map((part) => part.trim());
      const local = parts.at(-1)!;
      if (parts[0] === name || local === name) return { specifier: match[2]!, local };
    }
  }
  return undefined;
}

/**
 * Whether this file has the emitter in hand at all: it imports the name, re-exports it, declares
 * it, or reaches it through a namespace import (`import * as face`, used as `face.name`).
 *
 * This is what gates the value-reference scan (#3954), and it is the whole reason that scan does
 * not need to lex string literals. A bare name match is only evidence of a reference in a file
 * that could reference it; anywhere else it is prose -- a help string, an error message, a log
 * line -- and reading one as a site would be exactly the misdirected noise #3952 removed. Unlike
 * the origin, this is deliberately NOT a resolution: a name imported through a barrel is in hand
 * even when the chain cannot be followed, so the reference is still counted.
 */
function bindsEmitter(code: string, name: string, declared: RegExp): boolean {
  if (importedFrom(code, name) !== undefined || declared.test(code)) return true;
  return [...code.matchAll(/^[ \t]*import\s+\*\s+as\s+(\w+)\s+from/gmu)]
    .some((match) => new RegExp(String.raw`\b${match[1]!}\s*\??\s*\.\s*${name}\b`, "u").test(code));
}

/** The declaration of `name` in the module that owns it, in either of the two forms it takes. */
function declarationPattern(name: string): RegExp {
  return new RegExp(
    String.raw`(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+${name}\b`,
    "u",
  );
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The product-relative module a specifier names, for a relative path or a member package name.
 *
 * A FILE, not merely something that exists: a directory-style specifier (`from "../binding"`) is not
 * valid NodeNext ESM, but it satisfied `existsSync`, and `resolveOrigin`'s hop loop then read the
 * directory and failed with `EISDIR` instead of the guard's own constraint message (#4018). It
 * belongs in the documented unresolved lane, alongside an extensionless specifier: return
 * `undefined`, and the occurrence is counted loudly.
 */
function moduleForSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(fromFile), specifier.replace(/\.js$/u, ".ts"));
    const module = relative(productRoot, target);
    // A specifier that climbs out of the product is not a module this scan can key on, and
    // following one would read a file the scan never walked.
    return isFile(target) && !module.startsWith("..") ? module : undefined;
  }
  const member = memberByPackageName.get(specifier);
  if (member === undefined) return undefined;
  const entry = join(productRoot, member, "src", "index.ts");
  return isFile(entry) ? relative(productRoot, entry) : undefined;
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
  const declared = declarationPattern(name);
  // Read through blanked comments, for the reason the scans do: a commented-out import naming the
  // emitter would otherwise resolve the origin to a module this file never reaches, and a wrong
  // origin drops the file's real calls -- the same silent-hole shape the barrel case had.
  const code = blankComments(source);
  const imported = importedFrom(code, name);
  if (imported === undefined) return declared.test(code) ? relative(productRoot, filePath) : undefined;
  let module = moduleForSpecifier(imported.specifier, filePath);
  const seen = new Set<string>();
  while (module !== undefined && !seen.has(module)) {
    seen.add(module);
    const absolute = join(productRoot, module);
    if (!existsSync(absolute)) return undefined;
    const hopSource = blankComments(readFileSync(absolute, "utf8"));
    if (declared.test(hopSource)) return module;
    const hop = importedFrom(hopSource, name);
    module = hop === undefined ? undefined : moduleForSpecifier(hop.specifier, absolute);
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
    // The names this FILE spells the emitter as: an alias binds it under another one, and
    // searching only the declared name finds neither the call nor the reference (#4017). Both are
    // searched rather than the alias alone, since a file may also reach the emitter under its own
    // name -- through a declaration or a namespace import -- in the same breath. The site is
    // reported under the declared name either way, which is what `EXPECTED_JUSTIFIED_SITES` keys
    // on: the alias is how this file spells the emitter, not a different one.
    const alias = importedFrom(blanked, name)?.local;
    const spelled = alias === undefined || alias === name ? name : `(?:${name}|${alias})`;
    for (const match of blanked.matchAll(new RegExp(String.raw`\b${spelled}\s*\(`, "gu"))) {
      const index = match.index!;
      if (/\b(?:function|const|let|var)\s+$/u.test(blanked.slice(Math.max(0, index - 24), index))) continue;
      const args = topLevelArguments(blanked, index + match[0].length - 1);
      if (args === undefined) throw new Error(`${label}: unterminated call to ${name}`);
      sites.push({ site: `${label}:${name}`, binding: args[position], justified: marked(index) });
    }
    // A value reference is counted only in a file that has the emitter in hand. Everywhere else a
    // bare name match is prose, and this gate is what lets the scan read strings as ordinary text.
    if (!bindsEmitter(blanked, name, declarationPattern(name))) continue;
    for (const match of references.matchAll(new RegExp(String.raw`\b${spelled}\b`, "gu"))) {
      const index = match.index!;
      const spelling = match[0].length;
      const before = references.slice(Math.max(0, index - 24), index);
      const after = references.slice(index + spelling, index + spelling + 24);
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
  // to pass over entirely (#3954). Every fixture below carries the import, because that is what
  // puts the emitter in the file's hands and so what the reference scan is gated on.
  test("detects a value reference to an emitter, and does not read a module statement as one", () => {
    // The specifier is shape, not resolution: no fixture here passes an `origins` map, so only the
    // statement's form is read. It is written relative so the file does not name its own package in
    // a code position, which the source-boundaries gate reads as `verify` importing itself.
    const IMPORTED = 'import { runBindingSentence } from "./report-face.js";\n';
    const reference = [{ site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false }];
    expect(emitterCallSites(`${IMPORTED}const lines = bindings.map(runBindingSentence);\n`, "fixture.ts"))
      .toEqual(reference);
    expect(emitterCallSites(`${IMPORTED}const emit = runBindingSentence;\n`, "fixture.ts")).toEqual(reference);
    const marked = `${IMPORTED}// binding-carriage: checked above.\nconst emit = runBindingSentence;\n`;
    expect(emitterCallSites(marked, "fixture.ts")[0]?.justified).toBe(true);
    // The export list `verify/src/index.ts:206` writes, and the import a caller writes: naming the
    // face is how a module hands it over, not a site that emits it.
    expect(emitterCallSites('export { runBindingClass, runBindingSentence } from "./binding/report-face.js";\n', "fixture.ts"))
      .toEqual([]);
    expect(emitterCallSites(IMPORTED, "fixture.ts")).toEqual([]);
    // A declaration introduces the emitter rather than passing it on, in either form.
    expect(emitterCallSites("export function runBindingSentence(binding) {\n  return \"\";\n}\n", "fixture.ts"))
      .toEqual([]);
    // A property named after the emitter is a key, not a reference to the function -- but a
    // ternary branch is a reference, and both sit before a colon.
    expect(emitterCallSites(`${IMPORTED}const table = { runBindingSentence: other };\n`, "fixture.ts")).toEqual([]);
    expect(emitterCallSites(`${IMPORTED}const emit = flag ? runBindingSentence : other;\n`, "fixture.ts"))
      .toEqual(reference);
    // A member access names someone else's property, not the emitter this file imported -- but a
    // namespace import binds the emitter itself behind exactly that shape.
    expect(emitterCallSites(`${IMPORTED}const emit = report.runBindingSentence;\n`, "fixture.ts")).toEqual([]);
    const namespaced = 'import * as face from "./report-face.js";\nconst emit = face.runBindingSentence;\n';
    expect(emitterCallSites(namespaced, "fixture.ts")).toEqual(reference);
    // A type position emits nothing at runtime.
    expect(emitterCallSites(`${IMPORTED}type Emitter = typeof runBindingSentence;\n`, "fixture.ts")).toEqual([]);
  });

  // The scan searches the name the FILE uses, not the name the emitter was declared under: an
  // aliased import and a default clause are ordinary import shapes, and reading only
  // `import { name }` let either hand the face on unseen (#4017).
  test("follows an aliased import, and reads a default clause as part of the same statement", () => {
    const aliased = 'import { runBindingSentence as emit } from "./report-face.js";\n';
    // The site is still reported under the emitter's declared name -- the alias is how this file
    // spells it, not a different emitter.
    expect(emitterCallSites(`${aliased}const s = emit(forged);\n`, "fixture.ts")[0]).toEqual({
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    });
    expect(emitterCallSites(`${aliased}export const send = emit;\n`, "fixture.ts")[0])
      .toEqual({ site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false });
    // The import statement itself is still a module statement, under either shape.
    expect(emitterCallSites(aliased, "fixture.ts")).toEqual([]);
    const withDefault = 'import defaultThing, { runBindingSentence } from "./report-face.js";\n';
    expect(emitterCallSites(withDefault, "fixture.ts")).toEqual([]);
    expect(emitterCallSites(`${withDefault}export const emit = runBindingSentence;\n`, "fixture.ts")[0])
      .toEqual({ site: "fixture.ts:runBindingSentence", binding: VALUE_REFERENCE, justified: false });
    // And the origin is resolved off the same statement, so the emitter is keyed by its module.
    expect(importedFrom(aliased, "runBindingSentence")).toEqual({ specifier: "./report-face.js", local: "emit" });
    expect(importedFrom(withDefault, "runBindingSentence"))
      .toEqual({ specifier: "./report-face.js", local: "runBindingSentence" });
  });

  // Prose is read as prose without lexing it, because a file that never took the emitter in hand
  // cannot be referencing it. This is what a string walker was doing before, at the cost of a
  // stray backtick in a regex literal blanking a whole file's tail.
  test("prose naming an emitter is not a reference, in a file that never imported it", () => {
    for (const form of ['"..."', "'...'", "`...`"]) {
      const quote = form[0]!;
      expect(emitterCallSites(`const help = ${quote}the face comes from runBindingSentence${quote};\n`, "fixture.ts"))
        .toEqual([]);
    }
    // And a regex literal carrying a quote or a backtick is inert: the scan reads the text after
    // it exactly as it reads the text before it.
    const afterRegex = 'import { runBindingSentence } from "./report-face.js";\n'
      + "const media = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;\n"
      + "const s = runBindingSentence(forged);\n";
    expect(emitterCallSites(afterRegex, "fixture.ts")[0])
      .toEqual({ site: "fixture.ts:runBindingSentence", binding: "forged", justified: false });
  });

  // The two residues #4020 names, closed in the direction each one runs. A `//` inside a string was
  // blanking the rest of its line, which HID a call; a call inside a string was read as one, which
  // forged a site. The fix stays narrower than the character walker that was reverted here: no
  // backtick tracking, and string state resets at every newline, so nothing can run past a line.
  test("a recognized same-line string literal neither hides a call nor forges one", () => {
    const IMPORTED = 'import { runBindingSentence } from "./report-face.js";\n';
    const url = `${IMPORTED}const u = "https://example.com"; const s = runBindingSentence(forged);\n`;
    expect(emitterCallSites(url, "fixture.ts")[0]).toEqual({
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    });
    const slashInString = `${IMPORTED}const u = "https://example.com"; const help = "call runBindingSentence(fake)";\n`;
    expect(emitterCallSites(slashInString, "fixture.ts")).toEqual([]);
    expect(emitterCallSites(`${IMPORTED}const help = "call runBindingSentence(binding) to render";\n`, "fixture.ts"))
      .toEqual([]);
    const dangerous = `${IMPORTED}const media = /[']/u; const help = "call runBindingSentence(fake)"; const s = runBindingSentence(forged); const empty = '';\n`;
    // Once the regex's slash makes the line ambiguous, later strings stay visible. The fake site
    // is accepted noise; critically, the real site after it cannot be blanked.
    expect(emitterCallSites(dangerous, "fixture.ts")).toEqual([
      { site: "fixture.ts:runBindingSentence", binding: "fake", justified: false },
      { site: "fixture.ts:runBindingSentence", binding: "forged", justified: false },
    ]);
    const mixed = `${IMPORTED}const media = /['"']/u; const s = runBindingSentence(forged); const other = /["]/u;\n`;
    expect(emitterCallSites(mixed, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
    for (const regex of ["/[']/u", "/['\"]/u", "/[\"']/u"]) {
      const repeated = `${IMPORTED}const left = ${regex}; const s = runBindingSentence(forged); const right = ${regex};\n`;
      expect(emitterCallSites(repeated, "fixture.ts")).toEqual([{
        site: "fixture.ts:runBindingSentence",
        binding: "forged",
        justified: false,
      }]);
    }
    expect(emitterCallSites(`${IMPORTED}const help = 'don\\'t call runBindingSentence(fake)';\n`, "fixture.ts"))
      .toEqual([]);
    // A real comment is still blanked, including one carrying an apostrophe of its own.
    expect(emitterCallSites("// don't call runBindingSentence(forged) from here\n", "fixture.ts")).toEqual([]);
    expect(emitterCallSites("/* don't call\n   runBindingSentence(forged) */\n", "fixture.ts")).toEqual([]);
    expect(emitterCallSites("const value = 1; // don't call runBindingSentence(forged)\n", "fixture.ts"))
      .toEqual([]);
    expect(emitterCallSites("const value = 1; /* don't call runBindingSentence(forged) */\n", "fixture.ts"))
      .toEqual([]);
    // When it cannot tell -- a quote that never closes, as a regex character class writes one -- it
    // blanks nothing further on that line and starts the next line clean. The cost is a comment read
    // as code, which is loud; the tail of the file is never silently blanked.
    const stray = `${IMPORTED}const media = /^[!#$%&'*+.^_\`|~0-9A-Za-z-]+$/u;\nconst s = runBindingSentence(forged);\n`;
    expect(emitterCallSites(stray, "fixture.ts")[0]?.binding).toBe("forged");
  });

  test("a quote in a regex character class cannot hide a comma-separated call", () => {
    const source = 'const values = [/["]/u, runBindingSentence(forged), ""];\n';
    expect(emitterCallSites(source, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("a regex quote cannot make a later URL hide a call", () => {
    const source = 'const media = /["]/u; const url = "https://example.com"; const s = runBindingSentence(forged);';
    expect(emitterCallSites(source, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("a semicolon-crossing comment-string candidate cannot hide a later URL and call", () => {
    const source = 'const template = `= "unterminated`; const url = "https://example.com"; const s = runBindingSentence(forged);';
    expect(emitterCallSites(source, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("a template quote cannot hide a comma-separated URL and call", () => {
    const source = 'const values = [`= "unterminated`, "https://example.com", runBindingSentence(forged)];';
    expect(emitterCallSites(source, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("a semicolon-rejected string cannot let a template quote hide a call", () => {
    const source = 'const first = "contains;semicolon"; const rendered = `, "${runBindingSentence(forged)}"`;';
    expect(emitterCallSites(source, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("a rejected quote cannot let a later quote hide a call", () => {
    const source = `const values = ['x="', runBindingSentence(forged), ""];\n`;
    expect(emitterCallSites(source, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("a quote after an opener inside a regex cannot hide a later call", () => {
    for (const source of [
      'const values = [/(")/u, runBindingSentence(forged), ""];\n',
      'const values = [/(?:")/u, runBindingSentence(forged), ""];\n',
      'const values = [/,"/u, runBindingSentence(forged), ""];\n',
    ]) {
      expect(emitterCallSites(source, "fixture.ts")).toEqual([{
        site: "fixture.ts:runBindingSentence",
        binding: "forged",
        justified: false,
      }]);
    }
  });

  test("a comment-shaped slash after regex ambiguity cannot hide a later call", () => {
    const division = "const left = <any>/x// 1; const hidden = runBindingSentence(forged);";
    expect(emitterCallSites(division, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);

    const multiplication = `const result = <any>/x/*
  runBindingSentence(forged)
*/x/.test("x");`;
    expect(emitterCallSites(multiplication, "fixture.ts")).toEqual([{
      site: "fixture.ts:runBindingSentence",
      binding: "forged",
      justified: false,
    }]);
  });

  test("only narrow string-introducing contexts may open a blanked span", () => {
    const call = "runBindingSentence(forged)";
    for (const quote of ['"', "'"]) {
      for (const prefix of ["", "= ", "( ", ", ", ": "]) {
        expect(blankStringLiterals(prefix + quote + call + quote)).not.toContain(call);
      }
      for (const prefix of ["[ ", "\\", quote, "identifier ", "`template` "]) {
        const source = prefix + quote + call + quote;
        expect(blankStringLiterals(source)).toBe(source);
      }
    }
  });

  test("the first rejected quote stops the line without suffix retries", { timeout: 1_000 }, () => {
    const source = "const value = " + '\\";'.repeat(20_000) + "end";
    expect(blankStringLiterals(source)).toBe(source);
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

    // A directory is not a module: a specifier naming one lands in the same unresolved lane an
    // extensionless specifier does, rather than walking the hop loop onto a directory read (#4018).
    expect(moduleForSpecifier("../binding", join(productRoot, "verify/src/binding/report-face.ts")))
      .toBeUndefined();
    const directoryImport = 'import { runBindingSentence } from "../binding";\n';
    const directoryPlant = join(productRoot, "verify/src/binding/plant.ts");
    expect(resolveOrigin(directoryImport, directoryPlant, "runBindingSentence")).toBeUndefined();
    expect(emitterCallSites(`${directoryImport}export const s = runBindingSentence(forged);\n`, "plant.ts",
      new Map([["runBindingSentence", resolveOrigin(directoryImport, directoryPlant, "runBindingSentence")]]))[0]?.binding)
      .toBe("forged");

    // And the resolved origin is what decides: the same call text is counted under the emitter's
    // module and dropped under the other's.
    const call = "const honesty = buildLocalVenueHonesty(cells, run, anchors, forged);\n";
    expect(emitterCallSites(call, "fixture.ts", new Map([["buildLocalVenueHonesty", emitterModule]])))
      .toHaveLength(1);
    expect(emitterCallSites(call, "fixture.ts", new Map([["buildLocalVenueHonesty", otherModule]])))
      .toEqual([]);
  });

  test("a completed division statement cannot expose a commented-out same-named import", () => {
    const emitterModule = "verify/src/profile/run-results.ts";
    const source = `const ratio = 1 / 2; /*
import { buildLocalVenueHonesty } from "../../core/src/operations/run-results.js";
*/
import { buildLocalVenueHonesty } from "./profile/run-results.js";
const honesty = buildLocalVenueHonesty(cells, run, anchors, forged);
`;
    const filePath = join(productRoot, "verify/src/fixture.ts");
    const origin = resolveOrigin(source, filePath, "buildLocalVenueHonesty");

    expect(origin).toBe(emitterModule);
    expect(emitterCallSites(source, "fixture.ts", new Map([["buildLocalVenueHonesty", origin]])))
      .toEqual([{
        site: "fixture.ts:buildLocalVenueHonesty",
        binding: "forged",
        justified: false,
      }]);
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
