import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const scriptsDir = resolve(root, '.github/scripts');
const workflowsDir = resolve(root, '.github/workflows');

/** @type {Record<string, string>} */
const SUGGESTED_OWNER_BY_TEST = {
  'build-platform-public-surface.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'build-prepublication-bundle.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'fixture-immutability.test.mjs': 'stack-fixture-immutability.yml',
  'fixture-manifest.test.mjs': 'stack-fixture-immutability.yml',
  'indexer-probe.test.mjs': 'indexer-monitor.yml',
  'jinn-plugin-split.test.mjs': 'jinn-plugin-split.yml',
  'platform-publisher-surface.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'prepublication-external-consumer.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'publish-stack-run.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'publish-stack.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'publish-verified-platform.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'published-artifacts-smoke-workflow.test.mjs': 'published-artifacts-smoke.yml',
  'stack-external-acceptance.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'stack-package-graph.test.mjs': 'platform-architecture-control.yml (platform-architecture-control job)',
  'stack-publish-manifest.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
};

export function listScriptTests(scriptsRoot = scriptsDir) {
  return readdirSync(scriptsRoot)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
}

export function collectReferencedScriptTests(workflowsRoot = workflowsDir) {
  const referenced = new Set();
  for (const fileName of readdirSync(workflowsRoot).filter((name) => name.endsWith('.yml'))) {
    // Whole-line comments are dropped first: a suite named only in prose is not wired (#4400).
    const source = readFileSync(join(workflowsRoot, fileName), 'utf8').split('\n').map(withoutCommentLine).join('\n');
    for (const match of source.matchAll(/\.github\/scripts\/([A-Za-z0-9_.-]+\.test\.mjs)/gu)) {
      referenced.add(match[1]);
    }
    for (const match of source.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+\.test\.mjs)(?:\s|$)/gmu)) {
      if (match[1].startsWith('.')) continue;
      referenced.add(match[1]);
    }
  }
  return referenced;
}

// Suites that patch files in the checked-out tree while they run. `node --test`
// schedules the files it is given in parallel, so any suite sharing an invocation
// with one of these reads manifests mid-rewrite and fails on truncated or
// canary-versioned JSON. Each must own its invocation.
const LIVE_TREE_MUTATING_TESTS = new Set(['build-prepublication-bundle.test.mjs']);

// Fixture directories a suite creates *inside the checked-out tree* rather than in the OS
// tmpdir. `node --test` runs a batch in parallel, so while one of these exists a sibling suite
// walking the checkout sees a path that `git ls-files --cached --others --exclude-standard`
// can never return. That race has fired twice: run 32982011618 (evidence-package-inventory)
// and issue #3148 (fixed by PR #3175). Both were repaired reader-side, and both repairs only
// worked because the transient directory happened to be dot-prefixed and gitignored.
//
// The invariant is therefore enforced here rather than left to luck. A suite that creates a
// directory under the repo root must declare it below, and every declared prefix must be both
// dot-prefixed (so dot-skipping walkers never descend into it) and matched by .gitignore (so
// the git-inventory comparison never sees it). A suite that cannot satisfy both must instead
// own its `node --test` invocation via LIVE_TREE_MUTATING_TESTS above.
//
// Paths are repo-root-relative prefixes; mkdtemp's random suffix is appended by the sample.
/** @type {Record<string, string[]>} */
const LIVE_TREE_FIXTURES = {
  'evidence-source-boundaries.test.mjs': ['packages/evidence/repository-ipfs/.jinn-ipfs-production-boundary-'],
  'observation-reader-gate-boundary.test.mjs': ['.github/scripts/.tmp-observation-reader-guard-'],
};
// Calls that materialize a path on disk, mapped to the index of the argument naming the path
// being *created*. Sync and async spellings create the same path. A single in-checkout *file* is
// just as invisible to `git ls-files --cached --others --exclude-standard` as a directory is, and
// so is one that a copy, append, rename, or link lands. The two-path calls (`cpSync(from, to)`,
// `copyFile`, `rename`, `symlink(target, path)`, `link`) read or point at their first argument, so
// only the second says where anything lands. A match counts only when that argument references a
// checkout binding, which bounds the false positives a common name like `link(` could raise.
const FIXTURE_CREATING_CALLS = new Map([
  ['mkdtempSync', 0], ['mkdtemp', 0], ['mkdirSync', 0], ['mkdir', 0],
  ['writeFileSync', 0], ['writeFile', 0], ['appendFileSync', 0], ['appendFile', 0],
  ['cpSync', 1], ['cp', 1], ['copyFileSync', 1], ['copyFile', 1],
  ['renameSync', 1], ['rename', 1], ['symlinkSync', 1], ['symlink', 1], ['linkSync', 1], ['link', 1],
]);

/** Splits a call's argument text on its top-level commas. */
function argumentBoundaries(masked) {
  const boundaries = [];
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) boundaries.push(index);
  }
  return boundaries;
}

/**
 * The `index`-th argument of a call, read from both the masked and the raw text. Boundaries come
 * from the masked copy only: a comma inside a string literal is a separator in the raw text but
 * not in the masked one, and splitting each independently would misalign the two.
 */
function argumentAt(masked, raw, index) {
  const boundaries = [-1, ...argumentBoundaries(masked), masked.length];
  if (index + 1 >= boundaries.length) return { masked: '', raw: '' };
  const from = boundaries[index] + 1;
  const to = boundaries[index + 1];
  return { masked: masked.slice(from, to), raw: raw.slice(from, to) };
}

/**
 * A copy of `source` with the interior of every string literal, regex literal, and comment
 * replaced by a neutral filler of the same length. Offsets are preserved, so a match found here
 * indexes the original text. Scanning the raw source instead makes `\broot\b` fire inside
 * unrelated content such as `'jinn-information-world-root-closure-'`, and leaving regex literals
 * unmasked lets a quote inside a character class (this file has one) open a phantom string that
 * silently blanks every later call — a false negative in a gate.
 */
export function maskLiterals(source) {
  const out = [...source];
  const blank = (from, to, filler) => {
    for (let cursor = from; cursor < to; cursor += 1) if (out[cursor] !== '\n') out[cursor] = filler;
  };
  // What precedes a `/` decides regex-vs-division. After a value — an identifier, a literal, a
  // closing bracket — a slash divides. After an operator, or after a keyword that can be followed
  // by an expression, it opens a regex. Testing only the previous *character* reads `return /x/`
  // as division (`n` looks like an identifier), so the keyword set is checked too; the same
  // predicate shape is used by policy-optimization-source-boundaries.test.mjs.
  const EXPRESSION_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/u;
  const opensRegex = (index, previous) => !/[A-Za-z0-9_$)\]]/u.test(previous)
    || EXPRESSION_KEYWORDS.test(source.slice(Math.max(0, index - 12), index).trimEnd());
  let previous = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && (next === '/' || next === '*')) {
      const terminator = next === '/' ? '\n' : '*/';
      const found = source.indexOf(terminator, index + 2);
      const end = found === -1 ? source.length : found + (next === '/' ? 0 : 2);
      blank(index, end, ' ');
      index = end - 1;
      continue;
    }
    if (char === '/' && opensRegex(index, previous)) {
      let cursor = index + 1;
      let inClass = false;
      for (; cursor < source.length && source[cursor] !== '\n'; cursor += 1) {
        if (source[cursor] === '\\') { cursor += 1; continue; }
        if (source[cursor] === '[') inClass = true;
        else if (source[cursor] === ']') inClass = false;
        else if (source[cursor] === '/' && !inClass) break;
      }
      blank(index + 1, cursor, 'x');
      index = cursor;
      previous = '/';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let cursor = index + 1;
      let literalStart = cursor;
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === '\\') { cursor += 1; continue; }
        // A template's `${ … }` holds code, not text. Leaving it unmasked is what makes an
        // interpolated fixture path such as `` `${root}/tmp-x-` `` fail closed rather than open.
        if (char === '`' && source[cursor] === '$' && source[cursor + 1] === '{') {
          blank(literalStart, cursor, 'x');
          let depth = 0;
          for (; cursor < source.length; cursor += 1) {
            if (source[cursor] === '{') depth += 1;
            else if (source[cursor] === '}' && (depth -= 1) === 0) break;
          }
          literalStart = cursor + 1;
          continue;
        }
        if (source[cursor] === char) break;
      }
      blank(literalStart, cursor, 'x');
      index = cursor;
      previous = char;
      continue;
    }
    if (!/\s/u.test(char)) previous = char;
  }
  return out.join('');
}

/** Reads the balanced-parenthesis argument text of the call opening at `open`. */
function callArgumentText(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

const stringLiterals = (text) => [...text.matchAll(/'([^']*)'|"([^"]*)"/gu)]
  .map((literal) => literal[1] ?? literal[2]);

// Every suite this gate scans lives here: `collectLiveTreeFixtures` reads only `scriptsDir`. A
// binding's offset is therefore resolved from this directory.
const SCANNED_SUITE_DIR = '.github/scripts';

// The two spellings of "this file's directory" that live in this tree: the modern
// `import.meta.dirname` and the older `dirname(fileURLToPath(import.meta.url))`, with or without
// a `path.` namespace.
const THIS_DIRECTORY = String.raw`(?:import\.meta\.dirname|(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\))`;

/**
 * A repo-root-relative path as segments; null when it leaves the checkout. Callers pass the
 * output of `posix.join`, which normalizes: that is what keeps `join(scriptsDir, '..', 'x')`
 * comparable with the declared `.github/x`.
 */
function checkoutSegments(normalized) {
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  return normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Identifiers bound at module scope to a directory of this checkout, each mapped to that
 * directory's repo-root-relative segments, or to null where the binding cannot be resolved
 * statically. A `root` bound inside a helper is almost always a tmpdir fixture root; only a
 * module-level binding derived from this file's directory reaches into the live checkout.
 *
 * Accepted shapes, each with an optional `export`: `const x = resolve(<here>, ...)` and
 * `const x = join(<here>, ...)`, with or without `path.`, and a bare `const x = <here>;`, where
 * `<here>` is either spelling of this file's directory. `<here>` must be the whole first argument,
 * and the arguments after it must each be one plain string literal; anything else (such as
 * `<here> + '/sub'`), an absolute literal, or a result that escapes the checkout binds the name to
 * null, which every call through it reports.
 *
 * This used to accept only `resolve(<here>, ...)` climbing to the repository root. That made the
 * gate skip every suite that binds a checkout directory some other way -- `const scriptsDir =
 * path.dirname(fileURLToPath(import.meta.url))`, with no root at all -- silently:
 * `findInCheckoutFixtureCalls` returns [] with no bindings, so the fail-closed null-prefix path
 * is never reached (#3240). Recognizing only one spelling of `<here>` failed the same way before.
 */
export function findCheckoutBindings(source) {
  const masked = maskLiterals(source);
  /** @type {Map<string, string[] | null>} */
  const bindings = new Map();
  const derived = new RegExp(
    String.raw`^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*${THIS_DIRECTORY}`,
    'gmu',
  );
  const wholeDirectory = new RegExp(String.raw`^\s*${THIS_DIRECTORY}\s*$`, 'u');
  for (const match of masked.matchAll(derived)) {
    const open = masked.indexOf('(', match.index + match[0].indexOf('='));
    const maskedArguments = callArgumentText(masked, open);
    const rawArguments = callArgumentText(source, open);
    const here = wholeDirectory.test(argumentAt(maskedArguments, rawArguments, 0).masked);
    const rest = [];
    for (let index = 1; index <= argumentBoundaries(maskedArguments).length; index += 1) {
      rest.push(argumentAt(maskedArguments, rawArguments, index).raw.trim());
    }
    // Literals are read from the raw text: the masked copy blanks their contents.
    const literal = /^(['"])([^'"]*)\1$/u;
    const resolvable = rest.every((argument) => literal.test(argument) && !argument.slice(1).startsWith('/'));
    bindings.set(
      match[1],
      here && resolvable
        ? checkoutSegments(posix.join(SCANNED_SUITE_DIR, ...rest.map((argument) => argument.slice(1, -1))))
        : null,
    );
  }
  const bare = new RegExp(String.raw`^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*${THIS_DIRECTORY}\s*(?:;|$)`, 'gmu');
  for (const match of masked.matchAll(bare)) bindings.set(match[1], checkoutSegments(SCANNED_SUITE_DIR));
  return bindings;
}

/**
 * Calls that create a path under the repository root, each with the repo-root-relative prefix it
 * creates. `segments` is null when the path is not statically resolvable to string literals, or
 * when it resolves outside the checkout.
 *
 * Known limits, accepted and matching the style of the tree's other regex-based guards: the
 * scanner resolves one level of `const x = join(dir, ...)` indirection but not two, does not
 * follow a path through a function parameter or a template literal, reads only the calls in
 * FIXTURE_CREATING_CALLS, and sees only the module-level checkout bindings findCheckoutBindings
 * accepts. A directory reference used inline in a call rather than bound at module scope, a
 * `new URL(..., import.meta.url)`, a function-local binding, a root imported from another
 * module, or a spelling of this file's directory other than the two THIS_DIRECTORY names (such as
 * `dirname(import.meta.filename)`, `` `${import.meta.dirname}/x` ``, or
 * `import.meta.dirname ?? ...`) binds nothing, and a suite with none of the accepted bindings is
 * skipped. A new
 * in-checkout fixture built in a shape outside those bounds is invisible to this gate, which is
 * why the rule is documented at the fixture site as well.
 */
export function findInCheckoutFixtureCalls(source) {
  const bindings = findCheckoutBindings(source);
  if (bindings.size === 0) return [];
  const masked = maskLiterals(source);
  const rootReference = new RegExp(`\\b(?:${[...bindings.keys()].join('|')})\\b`, 'u');
  // The first of `names` a masked argument references; undefined when it references none.
  const referenced = (names, maskedText) => names.find((name) => new RegExp(`\\b${name}\\b`, 'u').test(maskedText));

  // One level of indirection: `const dir = join(root, '.github', 'scripts', '.tmp-x-');` is the
  // house style in this directory, and reading only the fixture call's own parens would miss it.
  /** @type {Map<string, { offset: string[] | null, literals: string[] }>} */
  const pathBindings = new Map();
  for (const match of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:join|resolve)\(/gu)) {
    const open = match.index + match[0].length - 1;
    const through = referenced([...bindings.keys()], callArgumentText(masked, open));
    if (through === undefined) continue;
    pathBindings.set(match[1], {
      offset: bindings.get(through),
      literals: stringLiterals(callArgumentText(source, open)),
    });
  }
  const pathReference = pathBindings.size === 0
    ? null
    : new RegExp(`\\b(?:${[...pathBindings.keys()].join('|')})\\b`, 'u');

  const calls = [];
  for (const [name, destination] of FIXTURE_CREATING_CALLS) {
    for (const match of masked.matchAll(new RegExp(`\\b${name}\\(`, 'gu'))) {
      const open = match.index + name.length;
      const argument = argumentAt(callArgumentText(masked, open), callArgumentText(source, open), destination);
      const maskedTarget = argument.masked;
      const viaRoot = rootReference.test(maskedTarget);
      if (!viaRoot && !(pathReference && pathReference.test(maskedTarget))) continue;
      const base = viaRoot
        ? { offset: bindings.get(referenced([...bindings.keys()], maskedTarget)), literals: [] }
        : pathBindings.get(referenced([...pathBindings.keys()], maskedTarget));
      const literals = [...base.literals, ...stringLiterals(argument.raw)];
      const segments = base.offset === null || literals.length === 0
        ? null
        : checkoutSegments(posix.join(...base.offset, ...literals));
      calls.push({ call: name, segments: segments !== null && segments.length > 0 ? segments : null });
    }
  }
  return calls;
}

/** Repo-root-relative prefixes each suite creates inside the checkout, keyed by suite filename. */
export function collectLiveTreeFixtures(scriptsRoot = scriptsDir) {
  /** @type {Record<string, (string | null)[]>} */
  const found = {};
  for (const name of listScriptTests(scriptsRoot)) {
    const calls = findInCheckoutFixtureCalls(readFileSync(join(scriptsRoot, name), 'utf8'));
    if (calls.length === 0) continue;
    found[name] = calls.map(({ segments }) => (segments === null ? null : segments.join('/')));
  }
  return found;
}

/**
 * `line`, or the empty string where the whole line is a YAML comment.
 *
 * Three reads match over prose otherwise. The two below: the invocation test sees a comment that
 * merely mentions `node --test`, and the harvest takes every `*.test.mjs` the prose names. Together
 * they mint an invocation that does not exist, and a phantom naming a LIVE_TREE_MUTATING_TESTS
 * member reds the co-scheduling guard on nothing (#3149). Measured over the current workflows this
 * drops exactly one line — a comment in `platform-architecture-control.yml` — and changes no
 * surviving invocation's file list. The one above, `collectReferencedScriptTests`: a suite
 * mentioned only in a comment satisfied the orphan gate, which is that gate's own fail-open
 * direction (#4400). Measured over the current workflows the stripped harvest loses no reference.
 *
 * Whole-line comments only, deliberately, rather than a strip from the first whitespace-preceded
 * `#` to end of line. That wider strip is quoting-unaware in the fail-OPEN direction: a `#` inside
 * a quoted scalar takes the rest of its line with it, so `- run: echo " #" && node --test
 * a.test.mjs b.test.mjs` comes back as no invocation at all — a live batch the co-scheduling guard
 * cannot see, which is precisely what that guard exists to catch.
 *
 * The residual this shape keeps runs the other way: a trailing `# ...` comment still reads as code,
 * so on a real `node --test` line its prose contributes any `*.test.mjs` names it spells, and on a
 * line carrying no invocation at all it mints a whole phantom one — #3149's shape again, in the
 * trailing-comment position rather than the whole-line one. Both over-report. Over-reporting can
 * only red a batch that is co-scheduled on paper and not in fact; under-reporting greens one that
 * is co-scheduled in fact. This gate takes the false red, which is why the narrower strip is the
 * right one even though it leaves this behind. For the orphan harvest the same residual runs
 * fail-open — a suite named only in a trailing comment on a code line still counts as referenced —
 * and is accepted because nothing in the tree writes that shape and a second, wider strip private
 * to the harvest would be a second definition of "comment" for it (#4400).
 */
function withoutCommentLine(line) {
  return /^\s*#/u.test(line) ? '' : line;
}

export function collectTestInvocations(workflowsRoot = workflowsDir) {
  const invocations = [];
  for (const fileName of readdirSync(workflowsRoot).filter((name) => name.endsWith('.yml'))) {
    const lines = readFileSync(join(workflowsRoot, fileName), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\bnode\s+--test\b/u.test(withoutCommentLine(lines[index]))) continue;
      const files = [];
      let last = index;
      for (;;) {
        const code = withoutCommentLine(lines[last]);
        for (const match of code.matchAll(/([A-Za-z0-9_.-]+\.test\.mjs)/gu)) files.push(match[1]);
        if (!lines[last].trimEnd().endsWith('\\') || last + 1 >= lines.length) break;
        last += 1;
      }
      invocations.push({ workflow: fileName, files });
      index = last;
    }
  }
  return invocations;
}

/**
 * Every `node --test` invocation hiding inside a folded (`>`) `run:` scalar, as
 * `{ workflow, line }`.
 *
 * `collectTestInvocations` follows a multi-line invocation by its trailing `\`. A folded scalar
 * has none — YAML joins the lines itself — so the walk stops after the first body line and the
 * file list comes back missing everything else. That is a real co-scheduling violation the guard
 * above cannot see: the invocation reads as a one-file batch no matter how many suites it actually
 * runs.
 *
 * This refuses the shape rather than parsing it. Nothing in the tree writes it — the folded scalars
 * it does carry include none with `node --test` — and a folded-scalar reader inside this guard
 * would be a second YAML parser to keep honest for a shape that has never appeared (#3149).
 *
 * The body is every following line indented past the `run:` key itself, which is where both
 * `run: >-` and `- run: >-` put it. The key may also be quoted, carry an anchor, or have its
 * header alone on the following line (#4399); YAML folds every one of those to the same single
 * command, so every one is refused. The key column is read from the matched prefix rather than
 * `indexOf('run:')`, because a quoted key contains no `run:` substring.
 *
 * Three more shapes fold the same way (#4603): a tag, alone or after an anchor, between the key and
 * the indicator (`run: !!str >-`); node properties on a next-line indicator (`&cmd >-`); and a plain
 * or quoted scalar that continues onto a line indented past the key — inline (`run: node --test
 * a.test.mjs` over an indented `b.test.mjs`) or as the body of a bare `run:`. YAML folds a plain
 * scalar's lines exactly as it folds `>`, so a multi-line one carrying `node --test` is refused. A
 * one-line plain scalar is a single command and is not.
 *
 * The header match takes an optional indentation indicator either side of the chomping indicator
 * and an optional trailing comment, because YAML writes all of `>2`, `>2-`, `>-2` and `>- # ...`.
 * A `>[-+]?`-only match read every one of those as an ordinary scalar and refused nothing, while
 * `collectTestInvocations` under-read the body regardless — the hole this gate exists to close,
 * behind a header a CI author may legally write (#3149). It over-matches a few headers YAML would
 * reject (`>12`, `>-2-`); over-refusal is a false red on a shape nothing writes, and this gate
 * takes the false red every time. `|` stays outside the match on purpose: a literal scalar keeps
 * its newlines, so its second line is a separate command rather than a continuation.
 */
export function foldedTestInvocations(workflowsRoot = workflowsDir) {
  const found = [];
  for (const fileName of readdirSync(workflowsRoot).filter((name) => name.endsWith('.yml'))) {
    const lines = readFileSync(join(workflowsRoot, fileName), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index].match(/^(\s*(?:-\s+)?)(?:run|"run"|'run'):(?:\s*[&!]\S+)*\s*(>[-+]?\d*[-+]?)?\s*(?:#.*)?$/u);
      // A plain or quoted scalar starting on the key line. Its first character is none of `|`, `>`,
      // `#`, nor a node property, so this never overlaps the header match above (#4603).
      const inline = header === null
        ? lines[index].match(/^(\s*(?:-\s+)?)(?:run|"run"|'run'):(?:\s+[&!]\S+)*\s+([^\s|>#&!].*)$/u)
        : null;
      if (header === null && inline === null) continue;
      // The key column comes from the matched prefix, not `indexOf('run:')`: a quoted key has no
      // `run:` substring, and a column of -1 never ends the body walk (#4399).
      const keyColumn = (header ?? inline)[1].length;
      if (inline !== null) {
        const line = plainScalarTestInvocation(lines, index + 1, keyColumn, [{ code: inline[2], line: index + 1 }]);
        if (line !== null) found.push({ workflow: fileName, line });
        continue;
      }
      let cursor = index + 1;
      if (header[2] === undefined) {
        // A bare `run:` (or `run: &anchor`) is a folded header only if the indicator sits alone on
        // the next non-blank, non-comment line at or past the key's column — YAML skips a whole-line
        // comment there exactly as it skips a blank. An indicator at the key's own column is
        // parser-dependent (YAML 1.2 and js-yaml reject it; the libyaml family folds it), and this
        // gate takes the false red over the under-read, so it is refused too (#4562). One less
        // indented than the key is invalid everywhere. `|` there is a literal scalar and a mapping
        // key there is the `defaults.run:` block; neither is refused (#4399). The indicator may carry
        // its own node properties (`&cmd >-`, `!!str >-`), and anything else indented past the key
        // is a plain scalar body, which folds exactly as `>` does (#4603).
        while (cursor < lines.length && withoutCommentLine(lines[cursor]).trim() === '') cursor += 1;
        if (cursor >= lines.length) continue;
        const next = lines[cursor];
        const nextColumn = next.match(/^\s*/u)[0].length;
        if (!/^\s*(?:[&!]\S+\s+)*>[-+]?\d*[-+]?\s*(?:#.*)?$/u.test(next)) {
          const scalarBody = nextColumn > keyColumn
            && !/^\s*(?:[&!]\S+\s+)*\|/u.test(next)
            && !/^\s*-(?:\s|$)/u.test(next)
            && !/^\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'):(?:\s|$)/u.test(next);
          const line = scalarBody ? plainScalarTestInvocation(lines, cursor, keyColumn, []) : null;
          if (line !== null) found.push({ workflow: fileName, line });
          continue;
        }
        if (nextColumn < keyColumn) continue;
        cursor += 1;
      }
      for (; cursor < lines.length; cursor += 1) {
        if (lines[cursor].trim() === '') continue;
        if (lines[cursor].match(/^\s*/u)[0].length <= keyColumn) break;
        if (/\bnode\s+--test\b/u.test(withoutCommentLine(lines[cursor]))) {
          found.push({ workflow: fileName, line: cursor + 1 });
          break;
        }
      }
    }
  }
  return found;
}

/**
 * The 1-based line of the first `node --test` in a plain (or quoted) `run:` scalar that spans more
 * than one line, or `null`. `content` holds the part already on the key line, if any; the body is
 * every following non-blank, non-comment line indented past the key, which YAML folds into the same
 * single command. A one-line scalar is one command and is left to `collectTestInvocations` (#4603).
 */
function plainScalarTestInvocation(lines, start, keyColumn, content) {
  const body = [...content];
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    const code = withoutCommentLine(lines[cursor]);
    if (code.trim() === '') continue;
    if (code.match(/^\s*/u)[0].length <= keyColumn) break;
    body.push({ code, line: cursor + 1 });
  }
  if (body.length < 2) return null;
  return body.find(({ code }) => /\bnode\s+--test\b/u.test(code))?.line ?? null;
}

export function findOrphanedScriptTests(scriptsRoot = scriptsDir, workflowsRoot = workflowsDir) {
  const tests = listScriptTests(scriptsRoot);
  const referenced = collectReferencedScriptTests(workflowsRoot);
  return tests.filter((name) => !referenced.has(name));
}

test('every .github/scripts/*.test.mjs is referenced by at least one workflow', () => {
  const orphans = findOrphanedScriptTests();
  if (orphans.length === 0) return;

  const details = orphans.map((name) => {
    const owner = SUGGESTED_OWNER_BY_TEST[name] ?? 'an owning workflow under .github/workflows/';
    return `- ${name} (suggested owner: ${owner})`;
  }).join('\n');

  assert.fail(
    `Found ${orphans.length} unwired script test file(s). Each .github/scripts/*.test.mjs must appear in a workflow node --test invocation:\n${details}`,
  );
});

test('findOrphanedScriptTests detects a planted orphan', () => {
  const scriptsRoot = mkdtempSync(join(tmpdir(), 'jinn-planted-orphan-scripts-'));
  const workflowsRoot = mkdtempSync(join(tmpdir(), 'jinn-planted-orphan-workflows-'));
  try {
    writeFileSync(join(scriptsRoot, 'wired.test.mjs'), '');
    writeFileSync(join(scriptsRoot, 'orphan.test.mjs'), '');
    writeFileSync(join(workflowsRoot, 'w.yml'), [
      'jobs:',
      '  verify:',
      '    steps:',
      '      - run: node --test .github/scripts/wired.test.mjs',
      '',
    ].join('\n'));
    assert.deepEqual(findOrphanedScriptTests(scriptsRoot, workflowsRoot), ['orphan.test.mjs']);
  } finally {
    rmSync(scriptsRoot, { recursive: true, force: true });
    rmSync(workflowsRoot, { recursive: true, force: true });
  }
});

// The harvest matched `*.test.mjs` over raw workflow source, comments included, so a suite named
// only in a workflow's prose counted as referenced and the orphan gate greened on it — fail-open in
// the gate's own direction. Whole-line comments are stripped before the harvest now (#4400); a
// name in a trailing `# ...` comment on a code line still counts, the accepted residual documented
// on `withoutCommentLine`.
test('a suite named only in a workflow comment is still an orphan', () => {
  const scriptsRoot = mkdtempSync(join(tmpdir(), 'jinn-orphan-scripts-'));
  const workflowsRoot = mkdtempSync(join(tmpdir(), 'jinn-orphan-workflows-'));
  try {
    writeFileSync(join(scriptsRoot, 'planted.test.mjs'), '');
    writeFileSync(join(scriptsRoot, 'live.test.mjs'), '');
    writeFileSync(join(workflowsRoot, 'w.yml'), [
      'jobs:',
      '  verify:',
      '    steps:',
      '      # planted.test.mjs runs elsewhere',
      '      - run: node --test .github/scripts/live.test.mjs',
      '',
    ].join('\n'));
    assert.deepEqual(findOrphanedScriptTests(scriptsRoot, workflowsRoot), ['planted.test.mjs']);
  } finally {
    rmSync(scriptsRoot, { recursive: true, force: true });
    rmSync(workflowsRoot, { recursive: true, force: true });
  }
});

test('a suite that mutates the checked-out tree never shares a node --test invocation', () => {
  for (const { workflow, files } of collectTestInvocations()) {
    for (const solo of files.filter((name) => LIVE_TREE_MUTATING_TESTS.has(name))) {
      assert.deepEqual(
        files,
        [solo],
        `${workflow} runs ${solo} alongside ${files.filter((name) => name !== solo).join(', ')}. `
        + `${solo} rewrites package.json files in the checked-out tree while it packs, so a `
        + 'co-scheduled suite reads them mid-rewrite. Give it its own node --test invocation.',
      );
    }
  }
});

test('collectTestInvocations reads the platform-release-surface lists', () => {
  const lists = collectTestInvocations()
    .filter(({ workflow }) => workflow === 'platform-architecture-control.yml')
    .map(({ files }) => files);
  assert.ok(lists.some((files) => files.length > 1), 'expected at least one multi-file invocation');
  assert.ok(
    lists.some((files) => files.length === 1 && LIVE_TREE_MUTATING_TESTS.has(files[0])),
    'expected the live-tree-mutating suite to own an invocation',
  );
});

// A `#` opens a YAML comment, and the harvest matches `*.test.mjs` anywhere on a line — prose
// included. A comment that merely mentions `node --test` and names some suites therefore minted an
// invocation that does not exist. That is not cosmetic: if one of the named files is in
// LIVE_TREE_MUTATING_TESTS, the co-scheduling guard above reds on a phantom (#3149).
test('collectTestInvocations ignores a node --test named in a YAML comment', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-comment-'));
  try {
    writeFileSync(join(fixture, 'commented.yml'), [
      'jobs:',
      '  verify:',
      '    steps:',
      '      # A suite co-scheduled by `node --test` reads a.test.mjs and b.test.mjs',
      '      - run: node --test c.test.mjs',
      '',
    ].join('\n'));
    assert.deepEqual(collectTestInvocations(fixture), [
      { workflow: 'commented.yml', files: ['c.test.mjs'] },
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// A `#` inside a quoted scalar does not open a YAML comment. Stripping from the first
// whitespace-preceded `#` took the rest of the line with it, so a real multi-suite invocation came
// back as no invocation at all — a live batch invisible to the co-scheduling guard above, which is
// the fail-open direction that guard exists to close (#3149).
test('collectTestInvocations reads a node --test line whose quoted scalar holds a #', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-quoted-hash-'));
  try {
    writeFileSync(join(fixture, 'quoted.yml'), [
      'jobs:',
      '  verify:',
      '    steps:',
      '      - run: echo " #" && node --test live-a.test.mjs live-b.test.mjs',
      '',
    ].join('\n'));
    assert.deepEqual(collectTestInvocations(fixture), [
      { workflow: 'quoted.yml', files: ['live-a.test.mjs', 'live-b.test.mjs'] },
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('no node --test invocation hides in a folded run scalar', () => {
  const folded = foldedTestInvocations();
  if (folded.length === 0) return;
  assert.fail(
    `Found ${folded.length} node --test invocation(s) inside a folded run scalar:\n`
    + folded.map(({ workflow, line }) => `- ${workflow}:${line}`).join('\n')
    + '\nA folded scalar carries no trailing `\\`, so collectTestInvocations stops after the first '
    + 'body line and the invocation reads as a one-file batch however many suites it runs — which '
    + 'hides a co-scheduling violation from the guard above. Use `run: |`, or put the invocation '
    + 'on one line.',
  );
});

test('a folded run scalar hiding node --test is detected, and shows why it must be', () => {
  // Every header shape YAML lets a folded scalar carry: bare, either chomping indicator, an
  // explicit indentation indicator, both indicators in either order, and a trailing comment. The
  // narrower `>[-+]?` match this replaces read `>2`, `>2-`, `>-2` and `>- # ...` as ordinary
  // scalars, so the refusal returned nothing on them while `collectTestInvocations` still under-read
  // the body as a one-file batch — the exact hole this gate exists to close, behind a header a CI
  // author may legally write (#3149).
  for (const header of ['>', '>-', '>+', '>2', '>2-', '>-2', '>- # folded onto one line']) {
    const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-folded-'));
    try {
      writeFileSync(join(fixture, 'folded.yml'), [
        'jobs:',
        '  verify:',
        '    steps:',
        `      - run: ${header}`,
        '          node --test x.test.mjs',
        '          y.test.mjs',
        '',
      ].join('\n'));
      assert.deepEqual(foldedTestInvocations(fixture), [{ workflow: 'folded.yml', line: 5 }], header);
      // The damage the refusal exists for, on the same fixture: the invocation is found, but the
      // second suite is invisible, so the co-scheduling guard reads a two-suite batch as a one-suite
      // one and passes it.
      assert.deepEqual(collectTestInvocations(fixture), [
        { workflow: 'folded.yml', files: ['x.test.mjs'] },
      ], header);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

// Three more places YAML lets the folded header sit, each of which the `run:`-line-anchored match
// read as an ordinary scalar while `collectTestInvocations` still under-read the body as a one-file
// batch: the header on the line after a bare `run:`, an anchor between key and header, and a quoted
// key (#4399). Each fixture asserts the refusal and the under-read it exists for. The next-line
// header may also sit behind a whole-line comment, which YAML skips exactly as it skips a blank
// line, or at the key's own column, which the libyaml parser family folds (#4562). The quoted key
// is the load-bearing one: it contains no `run:` substring, so a key column taken by `indexOf`
// came back -1 and the body walk never stopped — a `node --test` anywhere later in the file would
// have reported as folded. The last negative below pins that: a quoted-key body without
// `node --test` followed by a dedented step that has one must report nothing.
test('a folded run scalar is refused with its header on the next line, behind an anchor, or under a quoted key', () => {
  const shapes = [
    { name: 'next-line header', header: ['      - run:', '          >-'], line: 6 },
    { name: 'comment, next-line header', header: ['      - run:', '          # note', '          >-'], line: 7 },
    { name: 'next-line header at the key column', header: ['      - run:', '        >-'], line: 6 },
    { name: 'anchor before header', header: ['      - run: &cmd >-'], line: 5 },
    { name: 'anchor, next-line header', header: ['      - run: &cmd', '          >-'], line: 6 },
    { name: 'double-quoted key', header: ['      - "run": >-'], line: 5 },
    { name: 'single-quoted key', header: ["      - 'run': >-"], line: 5 },
  ];
  for (const { name, header, line } of shapes) {
    const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-folded-placement-'));
    try {
      writeFileSync(join(fixture, 'folded.yml'), [
        'jobs:',
        '  verify:',
        '    steps:',
        ...header,
        '          node --test x.test.mjs',
        '          y.test.mjs',
        '',
      ].join('\n'));
      assert.deepEqual(foldedTestInvocations(fixture), [{ workflow: 'folded.yml', line }], name);
      assert.deepEqual(collectTestInvocations(fixture), [
        { workflow: 'folded.yml', files: ['x.test.mjs'] },
      ], name);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  // A bare `run:` is not a folded header by itself. Followed by a literal indicator it is a
  // literal scalar, and followed by a mapping it is the `defaults.run:` block the tree writes
  // thirty times today; neither is refused.
  for (const { name, lines } of [
    { name: 'bare run: then literal', lines: ['      - run:', '          |', '          node --test x.test.mjs', '          y.test.mjs'] },
    { name: 'defaults.run mapping', lines: ['defaults:', '  run:', '    shell: bash', 'jobs:', '  verify:', '    steps:', '      - run: node --test x.test.mjs y.test.mjs'] },
    { name: 'quoted-key body ends before a dedented step', lines: ['jobs:', '  verify:', '    steps:', '      - "run": >-', '          echo hi', '      - run: node --test a.test.mjs'] },
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-folded-negative-'));
    try {
      writeFileSync(join(fixture, 'plain.yml'), [...lines, ''].join('\n'));
      assert.deepEqual(foldedTestInvocations(fixture), [], name);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

// Three more shapes YAML folds into one command that the header match did not refuse (#4603): a
// tag between key and indicator, node properties on the next-line indicator, and a plain or quoted
// scalar continued onto a more-indented line — inline or under a bare `run:`. A plain multi-line
// scalar folds exactly like `>`, so `collectTestInvocations` under-reads it the same way.
test('a tagged header, a propertied next-line indicator, and a multi-line plain scalar are refused', () => {
  const shapes = [
    { name: 'tag before header', lines: ['      - run: !!str >-', '          node --test x.test.mjs', '          y.test.mjs'], line: 5 },
    { name: 'anchor and tag before header', lines: ['      - run: &cmd !!str >-', '          node --test x.test.mjs', '          y.test.mjs'], line: 5 },
    { name: 'anchor on the next-line indicator', lines: ['      - run:', '          &cmd >-', '          node --test x.test.mjs', '          y.test.mjs'], line: 6 },
    { name: 'tag on the next-line indicator', lines: ['      - run:', '          !!str >-', '          node --test x.test.mjs', '          y.test.mjs'], line: 6 },
    { name: 'inline plain scalar', lines: ['      - run: node --test x.test.mjs', '          y.test.mjs'], line: 4 },
    { name: 'inline plain scalar, invocation on the continuation', lines: ['      - run: cd operator &&', '          node --test x.test.mjs y.test.mjs'], line: 5 },
    { name: 'inline double-quoted scalar', lines: ['      - run: "node --test x.test.mjs', '          y.test.mjs"'], line: 4 },
    { name: 'named step, inline plain scalar', lines: ['      - name: Test', '        run: node --test x.test.mjs', '          y.test.mjs'], line: 5 },
    { name: 'bare run: then plain lines', lines: ['      - run:', '          node --test x.test.mjs', '          y.test.mjs'], line: 5 },
  ];
  for (const { name, lines, line } of shapes) {
    const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-folded-shape-'));
    try {
      writeFileSync(join(fixture, 'folded.yml'), ['jobs:', '  verify:', '    steps:', ...lines, ''].join('\n'));
      assert.deepEqual(foldedTestInvocations(fixture), [{ workflow: 'folded.yml', line }], name);
      assert.equal(collectTestInvocations(fixture).flatMap(({ files }) => files).includes('y.test.mjs'), name.includes('continuation'), name);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  // A one-line plain scalar is one command, and a bare `run:` over a single plain line folds
  // nothing; a mapping or a literal under a bare `run:` is not a scalar body at all.
  for (const { name, lines } of [
    { name: 'single-line plain run', lines: ['      - run: node --test x.test.mjs y.test.mjs', '        env:', '          A: b', '      - run: node --test z.test.mjs'] },
    { name: 'named single-line plain run', lines: ['      - name: Test', '        run: node --test x.test.mjs', '        env:', '          A: b'] },
    { name: 'bare run: over one plain line', lines: ['      - run:', '          node --test x.test.mjs y.test.mjs', '      - run: echo hi'] },
    { name: 'multi-line plain scalar without node --test', lines: ['      - run: echo one', '          two', '      - run: node --test z.test.mjs'] },
    { name: 'tagged literal', lines: ['      - run: !!str |', '          node --test x.test.mjs', '          node --test y.test.mjs'] },
    { name: 'bare run: then tagged literal', lines: ['      - run:', '          !!str |', '          node --test x.test.mjs', '          node --test y.test.mjs'] },
    { name: 'defaults.run mapping', lines: ['  defaults:', '    run:', '      shell: bash', '      working-directory: operator'] },
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-folded-shape-negative-'));
    try {
      writeFileSync(join(fixture, 'plain.yml'), ['jobs:', '  verify:', '    steps:', ...lines, ''].join('\n'));
      assert.deepEqual(foldedTestInvocations(fixture), [], name);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

// A literal (`|`) scalar carries the same body shape and must NOT be refused. YAML keeps its
// newlines, so `node --test x.test.mjs` and the line under it are two separate commands rather than
// one folded invocation — which is exactly what the reader above already reports. Refusing it would
// red a shape that is correct.
test('a literal run scalar is not refused as folded', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-workflow-literal-'));
  try {
    writeFileSync(join(fixture, 'literal.yml'), [
      'jobs:',
      '  verify:',
      '    steps:',
      '      - run: |',
      '          node --test x.test.mjs',
      '          node --test y.test.mjs',
      '',
    ].join('\n'));
    assert.deepEqual(foldedTestInvocations(fixture), []);
    assert.deepEqual(collectTestInvocations(fixture), [
      { workflow: 'literal.yml', files: ['x.test.mjs'] },
      { workflow: 'literal.yml', files: ['y.test.mjs'] },
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('every in-checkout fixture is declared, dot-prefixed, and gitignored', () => {
  for (const [suite, observed] of Object.entries(collectLiveTreeFixtures())) {
    if (LIVE_TREE_MUTATING_TESTS.has(suite)) continue;
    const declared = LIVE_TREE_FIXTURES[suite] ?? [];
    const guidance = 'It creates a path under the repository root while running, so a sibling suite '
      + 'scheduled in the same `node --test` batch sees a path git cannot return. Declare the '
      + 'prefix in LIVE_TREE_FIXTURES, keep it dot-prefixed and gitignored, or add the suite to '
      + 'LIVE_TREE_MUTATING_TESTS so it owns its invocation.';

    for (const prefix of observed) {
      assert.ok(prefix !== null, `${suite} builds an in-checkout path from something other than string literals, so this gate cannot check it. ${guidance}`);
      assert.ok(declared.includes(prefix), `${suite} creates ${prefix}, which LIVE_TREE_FIXTURES does not declare. ${guidance}`);

      const basename = prefix.split('/').filter(Boolean).at(-1);
      assert.ok(
        basename?.startsWith('.'),
        `${suite} creates ${prefix}; its final segment must be dot-prefixed so dot-skipping tree walks never descend into it mid-scan.`,
      );

      const sample = `${prefix}0a1b2c`;
      let ignored = true;
      try {
        execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', sample], { cwd: root, stdio: 'ignore' });
      } catch {
        ignored = false;
      }
      assert.ok(
        ignored,
        `${suite} creates ${sample}, but .gitignore does not match it, so a sibling suite comparing the tree against \`git ls-files\` sees an untracked path.`,
      );
    }
  }
});

test('LIVE_TREE_FIXTURES declares nothing stale', () => {
  const observed = collectLiveTreeFixtures();
  for (const [suite, prefixes] of Object.entries(LIVE_TREE_FIXTURES)) {
    assert.ok(observed[suite], `LIVE_TREE_FIXTURES lists ${suite}, which no longer creates an in-checkout path.`);
    for (const prefix of prefixes) {
      assert.ok(observed[suite].includes(prefix), `LIVE_TREE_FIXTURES lists ${prefix} for ${suite}, which no longer creates it.`);
    }
  }
});

test('the in-checkout fixture detector reads repo-root bindings, not tmpdir ones', () => {
  const inCheckout = [
    "const root = resolve(import.meta.dirname, '../..');",
    "const dir = mkdtempSync(join(root, '.github', 'scripts', '.tmp-guard-'));",
  ].join('\n');
  assert.deepEqual([...findCheckoutBindings(inCheckout)], [['root', []]]);
  assert.deepEqual(findInCheckoutFixtureCalls(inCheckout), [
    { call: 'mkdtempSync', segments: ['.github', 'scripts', '.tmp-guard-'] },
  ]);

  const viaBinding = [
    "const root = resolve(import.meta.dirname, '../..');",
    "const dir = join(root, '.github', 'scripts', '.tmp-indirect-');",
    'mkdirSync(dir);',
  ].join('\n');
  assert.deepEqual(
    findInCheckoutFixtureCalls(viaBinding).map(({ segments }) => segments),
    [['.github', 'scripts', '.tmp-indirect-']],
    'the house style binds the path first, so one level of indirection must resolve',
  );

  assert.deepEqual(findInCheckoutFixtureCalls("mkdirSync(join(tmpdir(), 'x'));"), []);

  // `cpSync(repoRoot, scratch)` reads the checkout and writes to a tmpdir; only the destination
  // argument says where anything is created.
  const copyOut = [
    "const repoRoot = resolve(import.meta.dirname, '../..');",
    "cpSync(repoRoot, scratch, { recursive: true });",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(copyOut), []);
});

test('both repo-root binding spellings are recognized', () => {
  // 17 suites in this directory bind the root as `dirname(fileURLToPath(import.meta.url))` rather
  // than `import.meta.dirname`. Reading only the latter made the gate skip all of them without
  // reporting anything, so a fixture written from either template must be seen.
  const viaFileUrl = [
    "const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');",
    "mkdtempSync(join(root, 'packages', 'tmp-new-fixture-'));",
  ].join('\n');
  assert.deepEqual([...findCheckoutBindings(viaFileUrl)], [['root', []]]);
  assert.deepEqual(findInCheckoutFixtureCalls(viaFileUrl), [
    { call: 'mkdtempSync', segments: ['packages', 'tmp-new-fixture-'] },
  ]);

  // `export const root = …` is live at .github/scripts/plugin-tree-guard-common.mjs.
  const exported = [
    "export const root = resolve(import.meta.dirname, '../..');",
    "mkdtempSync(join(root, 'packages', '.tmp-exported-'));",
  ].join('\n');
  assert.deepEqual([...findCheckoutBindings(exported)], [['root', []]]);
  assert.deepEqual(
    findInCheckoutFixtureCalls(exported).map(({ segments }) => segments),
    [['packages', '.tmp-exported-']],
  );

  // A tmpdir root written in either spelling still binds nothing.
  assert.deepEqual([...findCheckoutBindings("const dir = resolve(tmpdir(), 'x');")], []);
});

test('a checkout-directory binding with no repo root is seen (#3240)', () => {
  // `npm-publish-workflow.test.mjs` binds only its own directory. A fixture added from that
  // template used to bind nothing, so the gate skipped the suite without reporting anything.
  const scriptsOnly = [
    'const scriptsDir = path.dirname(fileURLToPath(import.meta.url));',
    "writeFileSync(path.join(scriptsDir, 'tmp-x-'), 'x');",
  ].join('\n');
  assert.deepEqual([...findCheckoutBindings(scriptsOnly)], [['scriptsDir', ['.github', 'scripts']]]);
  assert.deepEqual(findInCheckoutFixtureCalls(scriptsOnly), [
    { call: 'writeFileSync', segments: ['.github', 'scripts', 'tmp-x-'] },
  ]);

  // The binding's offset is carried through one level of indirection.
  const indirect = [
    'const here = resolve(import.meta.dirname);',
    "const d = join(here, '.tmp-y-');",
    'mkdirSync(d);',
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(indirect), [
    { call: 'mkdirSync', segments: ['.github', 'scripts', '.tmp-y-'] },
  ]);

  // The reported prefix is normalized, so it stays comparable with a declared one.
  const climbing = [
    'const scriptsDir = join(import.meta.dirname);',
    "mkdtempSync(join(scriptsDir, '..', 'tmp-z-'));",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(climbing), [
    { call: 'mkdtempSync', segments: ['.github', 'tmp-z-'] },
  ]);

  const bare = ['const here = import.meta.dirname;', "mkdirSync(join(here, '.tmp-w-'));"].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(bare), [
    { call: 'mkdirSync', segments: ['.github', 'scripts', '.tmp-w-'] },
  ]);
});

test('a checkout binding that escapes the root or is not literal fails closed', () => {
  const escaping = [
    "const up = resolve(import.meta.dirname, '../../..');",
    "mkdirSync(join(up, 'a'));",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(escaping), [{ call: 'mkdirSync', segments: null }]);

  const dynamic = [
    'const dyn = resolve(import.meta.dirname, name);',
    "mkdirSync(join(dyn, 'a'));",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(dynamic), [{ call: 'mkdirSync', segments: null }]);

  const absolute = [
    "const abs = resolve(import.meta.dirname, '/tmp');",
    "mkdirSync(join(abs, 'a'));",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(absolute), [{ call: 'mkdirSync', segments: null }]);

  const outside = [
    "const root = resolve(import.meta.dirname, '../..');",
    "mkdirSync(join(root, '..', 'outside'));",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(outside), [{ call: 'mkdirSync', segments: null }]);

  // The directory must be the whole first argument; a concatenated suffix is not dropped.
  const concatenated = [
    "const x = resolve(import.meta.dirname + '/sub');",
    "mkdirSync(join(x, 'tmp-a-'));",
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(concatenated), [{ call: 'mkdirSync', segments: null }]);

  // A directory reference with no literal of its own still names nothing checkable.
  const unnamed = [
    'const scriptsDir = dirname(fileURLToPath(import.meta.url));',
    'const fixture = mkdtempSync(`${scriptsDir}/tmp-interpolated-`);',
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(unnamed), [{ call: 'mkdtempSync', segments: null }]);
});

test('the async, append, copy, and link siblings of covered calls are seen (#3278)', () => {
  const prelude = "const root = resolve(import.meta.dirname, '../..');";
  const rows = [
    ["await writeFile(join(root, 'packages', '.tmp-a-'), 'x');", 'writeFile'],
    ["appendFileSync(join(root, 'packages', '.tmp-a-'), 'x');", 'appendFileSync'],
    ["await appendFile(join(root, 'packages', '.tmp-a-'), 'x');", 'appendFile'],
    ["await cp(src, join(root, 'packages', '.tmp-a-'));", 'cp'],
    ["copyFileSync(src, join(root, 'packages', '.tmp-a-'));", 'copyFileSync'],
    ["await copyFile(src, join(root, 'packages', '.tmp-a-'));", 'copyFile'],
    ["renameSync(src, join(root, 'packages', '.tmp-a-'));", 'renameSync'],
    ["await rename(src, join(root, 'packages', '.tmp-a-'));", 'rename'],
    ["symlinkSync(src, join(root, 'packages', '.tmp-a-'));", 'symlinkSync'],
    ["await symlink(src, join(root, 'packages', '.tmp-a-'));", 'symlink'],
    ["linkSync(src, join(root, 'packages', '.tmp-a-'));", 'linkSync'],
    ["await fsp.link(src, join(root, 'packages', '.tmp-a-'));", 'link'],
  ];
  for (const [callSource, call] of rows) {
    assert.deepEqual(
      findInCheckoutFixtureCalls(`${prelude}\n${callSource}`),
      [{ call, segments: ['packages', '.tmp-a-'] }],
      callSource,
    );
  }

  // The two-path calls read their destination: a copy out of the checkout creates nothing in it.
  assert.deepEqual(
    findInCheckoutFixtureCalls(`${prelude}\ncopyFileSync(join(root, 'x'), join(tmpdir(), 'y'));`),
    [],
  );
});

test('the mask survives quotes inside regex literals and comments', () => {
  // Regression: an odd number of quotes inside a character class used to open a phantom string
  // that blanked every later call, silently turning this gate green.
  const source = [
    "const root = resolve(import.meta.dirname, '../..');",
    "const quoted = text.match(/'([^']*)'/u);",
    "// a comment mentioning root and mkdirSync( that must not be scanned",
    "mkdtempSync(join(root, 'packages', '.tmp-after-regex-'));",
  ].join('\n');
  assert.deepEqual(
    findInCheckoutFixtureCalls(source).map(({ segments }) => segments),
    [['packages', '.tmp-after-regex-']],
  );

  const divided = "const half = (a + b) / 2; const other = c / 2;";
  assert.equal(maskLiterals(divided), divided, 'division must not be read as a regex literal');

  // `return /…/` looks like division if only the previous character is consulted: `n` reads as an
  // identifier. A quote inside such a regex would then open a phantom string over later calls.
  const afterKeyword = [
    "const root = resolve(import.meta.dirname, '../..');",
    "const q = (name) => { return /['\"]/u.test(name); };",
    "mkdtempSync(join(root, 'packages', '.tmp-after-return-regex-'));",
  ].join('\n');
  assert.deepEqual(
    findInCheckoutFixtureCalls(afterKeyword).map(({ segments }) => segments),
    [['packages', '.tmp-after-return-regex-']],
  );
});

test('an interpolated in-checkout fixture path fails closed', () => {
  // A template literal hides `root` inside the literal unless `${ … }` stays unmasked, and a
  // fixture the scanner cannot see is a silently green gate. It must be reported with a null
  // prefix instead, which the declaration gate rejects with a message naming the shape.
  const interpolated = [
    "const root = resolve(import.meta.dirname, '../..');",
    'const fixture = mkdtempSync(`${root}/tmp-interpolated-`);',
  ].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(interpolated), [{ call: 'mkdtempSync', segments: null }]);

  const interpolatedTmpdir = ['const fixture = mkdtempSync(`${tmpdir()}/jinn-`);'].join('\n');
  assert.deepEqual(findInCheckoutFixtureCalls(interpolatedTmpdir), []);
});

test('argument boundaries come from the masked copy, not the raw text', () => {
  // A comma inside a string literal is a separator in the raw text but not the masked one.
  // Splitting each independently would make `cpSync` read the wrong argument.
  const source = [
    "const root = resolve(import.meta.dirname, '../..');",
    "cpSync(from, join(root, 'packages', '.tmp-copy-target-'), { recursive: true });",
  ].join('\n');
  assert.deepEqual(
    findInCheckoutFixtureCalls(source).map(({ segments }) => segments),
    [['packages', '.tmp-copy-target-']],
  );

  const commaInLiteral = [
    "const root = resolve(import.meta.dirname, '../..');",
    "cpSync('a, b', join(root, 'packages', '.tmp-comma-'), { recursive: true });",
  ].join('\n');
  assert.deepEqual(
    findInCheckoutFixtureCalls(commaInLiteral).map(({ segments }) => segments),
    [['packages', '.tmp-comma-']],
  );
});

test('the gate rejects an in-checkout fixture that is not dot-prefixed', () => {
  const violating = [
    "const root = resolve(import.meta.dirname, '../..');",
    "mkdtempSync(join(root, 'packages', 'tmp-not-dot-prefixed-'));",
  ].join('\n');
  const [{ segments }] = findInCheckoutFixtureCalls(violating);
  assert.deepEqual(segments, ['packages', 'tmp-not-dot-prefixed-']);
  assert.ok(!segments.at(-1).startsWith('.'), 'the dot-prefix assertion above would fail for this suite');
});
