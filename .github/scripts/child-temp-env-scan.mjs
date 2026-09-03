// The spawn-site temp-directory scan, shared by every source root `child-temp-env-scan.test.mjs`
// governs. A child handed an explicit `env:` allowlist that names no temp directory falls back to
// the platform default and writes outside the root its parent was confined to; this reads every
// `env:` site in a tree and fails the ones that neither carry a temp directory nor say why not.
//
// It is a text scan, not a type-aware one, so every heuristic below is deliberately conservative in
// the same direction: a site is accounted for only on evidence the file itself can show.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The marker a site writes when it deliberately names no temp directory — because the child must
 * not inherit one, or because the allowlist is the caller's to build. One exact token rather than a
 * pattern over prose, so the scan cannot be satisfied by an unrelated sentence that happens to use
 * the right words, and `grep "temp-env:"` finds every such decision at once. The reason follows the
 * marker inline, because a deliberate omission and an oversight are otherwise indistinguishable.
 */
const JUSTIFICATION = /\btemp-env:/u;

/**
 * Accepted ways an `env:` allowlist can carry the caller's, or a pinned, temp directory.
 *
 * A spread counts only when it is `...process.env` — the one spread expression whose contents the
 * scan can read off the text itself. A bare `\.\.\.` used to be accepted here, which made every
 * spread proof of carriage whatever it spread: `env: { ...process.env }` does carry the temp
 * variables, `env: { ...env }` carries only what its own allowlist named, and the scan could not
 * tell them apart. Any other spread is resolved through `carriesTemp` instead. The optional
 * parenthesis admits the cast form `...(process.env as Record<string, string>)`, which is how
 * TypeScript that types the result spells the same spread.
 */
const CARRIES_TEMP = /inheritedTempEnv\(|scopedTempEnv\(|TMPDIR|\.\.\.\(?\s*process\.env\b/u;

/** Declarations and schemas that name a field called `env`; they spawn nothing. */
const NOT_A_SPAWN_SITE = /env:\s*(?:z\.|Readonly<|NodeJS\.ProcessEnv|dict\[)/u;

/** The head of a declaration, minus its name: what starts a definition and what ends the one above. */
const DECLARATION = '(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function|class)\\s+';

/** Source text with its comments removed, so prose about a temp variable is not read as one. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, ' ');
}

/**
 * The names an environment expression delegates to: what it passes instead of a literal
 * (`env: closedHarborEnv(paths)`, `env: dockerEnvironment`), what it spreads (`...env`), and what
 * a delegate's own body then calls (`loginEnvironment` calls `scopedTempEnv`). Without this, a
 * site that builds its allowlist in one well-documented place reads to the scan as an omission,
 * and the only way to satisfy it would be to inline the literal at every call — which is what
 * produced the gap in the first place.
 */
function delegatedNames(expression, calls) {
  const names = new Set();
  const patterns = [/env:\s*([A-Za-z_$][\w$]*)/gu, /\.\.\.([A-Za-z_$][\w$]*)/gu];
  // Calls only once inside a delegate's own body, never at the site. At the site every call in the
  // literal would count, so an unrelated `KEY: tokenFor(k)` next to an allowlist naming no temp
  // directory would supply the proof; inside a body the call IS how the delegation continues
  // (`loginEnvironment` reaches `scopedTempEnv` no other way).
  if (calls) patterns.push(/([A-Za-z_$][\w$]*)\s*\(/gu);
  for (const pattern of patterns) {
    for (const match of expression.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

/**
 * The definition of a delegated name, as text — bounded at the next declaration written at the same
 * indentation or shallower, with a byte cap for the last definition in a file. Not a brace walk: a
 * walk would have to understand template literals, which several of these definitions are written
 * inside. Not a fixed window either, which was the first attempt here — it spills into whatever is
 * defined next, so a helper that pins no temp directory reads as carrying one because a helper that
 * does sits below it.
 *
 * The boundary used to match only at column zero (#3097). A nested `const` is indented, so nothing
 * inside its enclosing function terminated its window and it ran to the next top-level declaration:
 * every unrelated call in that whole span then supplied the carriage, including — at the
 * `const env = loginEnvironment(root)` shape this scan exists to protect — the entire `try` block
 * holding both spawn sites. Matching a declaration at the definition's own indentation or shallower
 * bounds a nested definition at its own statement, and admits `class` as a boundary too: a class
 * between two helpers used to let the earlier one's window spill into a method that does carry.
 *
 * `from` is the position the name was referenced from. The declaration nearest at or above it wins,
 * falling back to the first one below — before this the first match in the whole file won, so a
 * later same-named local borrowed an earlier one's proof.
 */
function definitionWindow(source, name, from) {
  let chosen;
  for (const match of source.matchAll(new RegExp(`^([ \\t]*)${DECLARATION}${name}\\b`, 'gmu'))) {
    if (match.index <= from) chosen = match;
    else {
      if (chosen === undefined) chosen = match;
      break;
    }
  }
  if (chosen === undefined) return undefined;
  const body = source.slice(chosen.index, chosen.index + 2_000);
  const next = new RegExp(`\\n[ \\t]{0,${chosen[1].length}}${DECLARATION}`, 'u').exec(body.slice(1));
  return { index: chosen.index, text: next === null ? body : body.slice(0, next.index + 1) };
}

/**
 * The file a name is imported from, when it is imported over a relative specifier. A launcher builds
 * its allowlist in one documented helper in a sibling module; without following that edge the only
 * way to satisfy the scan would be to inline the literal at every call site, or to write a marker
 * asserting in prose what the helper does — which is the borrowed proof the scan refuses everywhere
 * else. A package specifier is out of reach and resolves to nothing, so such a site must carry or
 * justify itself.
 */
function importedFrom(source, name, file) {
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu)) {
    const bound = match[1].split(',').map((entry) => entry.trim().split(/\s+as\s+/u).pop().trim());
    if (!bound.includes(name)) continue;
    if (!match[2].startsWith('.')) return undefined;
    const base = resolve(dirname(file), match[2]).replace(/\.(?:js|mjs)$/u, '');
    return [`${base}.ts`, `${base}.mts`, `${base}.mjs`, join(base, 'index.ts')].find((path) => existsSync(path));
  }
  return undefined;
}

/**
 * Whether an environment expression carries a temp directory, following delegation as far as the
 * source can show it. Bounded by `seen`, which both terminates cycles and keeps a name that several
 * expressions reach from being walked twice; it is keyed by file so the same name in two modules
 * stays two names.
 */
function carriesTemp(file, source, expression, from, seen) {
  // Comments stripped first: carriage is a property of the code, and every one of these helpers is
  // documented in prose that names the variables it pins. Reading the prose as proof made the check
  // survive deleting the call — `readinessEnvironment` in `venue/demo1-claude.ts` stayed green on
  // the words in its own doc comment. The deliberate-omission marker is not read here; it is
  // checked against the site itself, comments and all, before this function is ever called.
  const code = withoutComments(expression);
  if (CARRIES_TEMP.test(code)) return true;
  // A non-empty `seen` means this expression is a delegate's body rather than the site itself,
  // which is the only place a bare call counts as delegation.
  for (const name of delegatedNames(code, seen.size > 0)) {
    const key = `${file}#${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const local = definitionWindow(source, name, from);
    if (local !== undefined) {
      if (carriesTemp(file, source, local.text, local.index, seen)) return true;
      continue;
    }
    const imported = importedFrom(source, name, file);
    if (imported === undefined) continue;
    const importedSource = readFileSync(imported, 'utf8');
    // Referenced from the end of the imported module: a module-scope declaration may sit either
    // side of the export the site reached, and there is no reference position to be nearest to.
    const remote = definitionWindow(importedSource, name, importedSource.length);
    if (remote !== undefined && carriesTemp(imported, importedSource, remote.text, remote.index, seen)) return true;
  }
  return false;
}

/**
 * The `env:` value expression at `index`, plus the comment lines directly above it — an object
 * literal is read to its matching brace, anything else to the end of its line.
 *
 * The comment block must be contiguous with the site (#3099). It used to be every comment-shaped
 * line within 8 lines above, contiguous with nothing, so a `temp-env:` marker written about one
 * thing exempted whatever happened to follow it. The marker is the scan's escape hatch; it belongs
 * to the site whose author wrote it and to no other.
 */
function envSite(source, index) {
  const valueStart = source.indexOf(':', index) + 1;
  let end = source.indexOf('\n', valueStart);
  const brace = source.slice(valueStart, end === -1 ? undefined : end).indexOf('{');
  if (brace !== -1) {
    let depth = 0;
    for (let cursor = valueStart + brace; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}' && (depth -= 1) === 0) {
        end = cursor + 1;
        break;
      }
    }
  }
  const lineStart = source.lastIndexOf('\n', index) + 1;
  // `slice(0, -1)` drops the empty element the trailing newline leaves; it is not a comment line and
  // would end the walk before it started.
  const preceding = source.slice(0, lineStart).split('\n').slice(0, -1).slice(-8);
  const comments = [];
  for (let cursor = preceding.length - 1; cursor >= 0; cursor -= 1) {
    if (!/^\s*(?:\/\/|\*|\/\*)/u.test(preceding[cursor])) break;
    comments.unshift(preceding[cursor]);
  }
  return `${comments.join('\n')}\n${source.slice(index, end === -1 ? undefined : end)}`;
}

/** The `env:` sites in one file's source text that the scan cannot account for. */
export function unhandledSites(source, file = '<memory>') {
  const unhandled = [];
  // `(?<![\w-])` and not `\b`: the justification marker is spelled `temp-env:`, and a word
  // boundary matches after its hyphen — so every marker would be scanned as a site of its own.
  for (const match of source.matchAll(/(?<![\w-])env:/gu)) {
    const site = envSite(source, match.index);
    if (NOT_A_SPAWN_SITE.test(site)) continue;
    // The marker is checked here and nowhere deeper: it exempts the site whose author wrote it,
    // not every site that happens to mention a name defined near one.
    if (JUSTIFICATION.test(site) || carriesTemp(file, source, site, match.index, new Set())) continue;
    const line = source.slice(0, match.index).split('\n').length;
    unhandled.push(`${line}: ${site.slice(site.indexOf('env:')).split('\n')[0].trim()}`);
  }
  return unhandled;
}

/** Every first-party source file under a root. Test files are excluded; they spawn no children. */
export function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:ts|mjs)$/u.test(entry.name) || entry.name.endsWith('.test.ts')) return [];
    return [path];
  });
}

/** Every unaccounted-for site under every root, as `<file>: <line>: <expression>`. */
export function scanRoots(roots) {
  return roots.flatMap((directory) =>
    sourceFiles(directory).flatMap((file) =>
      unhandledSites(readFileSync(file, 'utf8'), file).map((site) => `${file}: ${site}`)));
}
