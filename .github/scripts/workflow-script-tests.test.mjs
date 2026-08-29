import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    const source = readFileSync(join(workflowsRoot, fileName), 'utf8');
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
// Calls that materialise a path on disk. `writeFileSync` counts: a single in-checkout *file* is
// just as invisible to `git ls-files --cached --others --exclude-standard` as a directory is.
// Mapped to the index of the argument naming the path being *created*: `cpSync(from, to)` reads
// its first argument, so only the second says where anything lands.
const FIXTURE_CREATING_CALLS = new Map([
  ['mkdtempSync', 0], ['mkdtemp', 0], ['mkdirSync', 0], ['mkdir', 0], ['writeFileSync', 0], ['cpSync', 1],
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

/**
 * Identifiers bound at module scope to the repository root. A `root` bound inside a helper is
 * almost always a tmpdir fixture root; only a module-level `resolve(<this file's directory>, ...)`
 * reaches into the live checkout.
 *
 * Both spellings of "this file's directory" that live in this tree are accepted -- the modern
 * `import.meta.dirname` and the older `dirname(fileURLToPath(import.meta.url))`, which 17 suites
 * still use -- with an optional `export`. Recognising only one of them made the gate skip every
 * suite written in the other, silently: `findInCheckoutFixtureCalls` returns [] with no bindings,
 * so the fail-closed null-prefix path is never reached.
 */
export function findRepoRootBindings(source) {
  const binding = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*resolve\(\s*(?:import\.meta\.dirname|dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\))/gmu;
  return [...maskLiterals(source).matchAll(binding)].map((match) => match[1]);
}

/**
 * Calls that create a path under the repository root, each with the repo-root-relative prefix it
 * creates. `segments` is null when the path is not statically resolvable to string literals.
 *
 * Known limits, accepted and matching the style of the tree's other regex-based guards: the
 * scanner resolves one level of `const x = join(root, ...)` indirection but not two, does not
 * follow a path through a function parameter or a template literal, reads only the calls in
 * FIXTURE_CREATING_CALLS, and sees only the two repo-root binding shapes findRepoRootBindings
 * accepts -- a suite that binds a checkout directory some other way (`const scriptsDir =
 * dirname(fileURLToPath(import.meta.url))`, with no repo root at all) is skipped. A new
 * in-checkout fixture built in a shape outside those bounds is invisible to this gate, which is
 * why the rule is documented at the fixture site as well.
 */
export function findInCheckoutFixtureCalls(source) {
  const bindings = findRepoRootBindings(source);
  if (bindings.length === 0) return [];
  const masked = maskLiterals(source);
  const rootReference = new RegExp(`\\b(?:${bindings.join('|')})\\b`, 'u');

  // One level of indirection: `const dir = join(root, '.github', 'scripts', '.tmp-x-');` is the
  // house style in this directory, and reading only the fixture call's own parens would miss it.
  /** @type {Map<string, string[]>} */
  const pathBindings = new Map();
  for (const match of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:join|resolve)\(/gu)) {
    const open = match.index + match[0].length - 1;
    if (!rootReference.test(callArgumentText(masked, open))) continue;
    pathBindings.set(match[1], stringLiterals(callArgumentText(source, open)));
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
      const target = argument.raw;
      const inherited = viaRoot
        ? []
        : pathBindings.get([...pathBindings.keys()].find((key) => new RegExp(`\\b${key}\\b`, 'u').test(maskedTarget))) ?? [];
      const segments = [...inherited, ...stringLiterals(target)];
      calls.push({ call: name, segments: segments.length > 0 ? segments : null });
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

export function collectTestInvocations(workflowsRoot = workflowsDir) {
  const invocations = [];
  for (const fileName of readdirSync(workflowsRoot).filter((name) => name.endsWith('.yml'))) {
    const lines = readFileSync(join(workflowsRoot, fileName), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\bnode\s+--test\b/u.test(lines[index])) continue;
      const files = [];
      let last = index;
      for (;;) {
        for (const match of lines[last].matchAll(/([A-Za-z0-9_.-]+\.test\.mjs)/gu)) files.push(match[1]);
        if (!lines[last].trimEnd().endsWith('\\') || last + 1 >= lines.length) break;
        last += 1;
      }
      invocations.push({ workflow: fileName, files });
      index = last;
    }
  }
  return invocations;
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
  assert.deepEqual(findOrphanedScriptTests(scriptsDir, workflowsDir), []);
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
  assert.deepEqual(findRepoRootBindings(inCheckout), ['root']);
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
  assert.deepEqual(findRepoRootBindings(viaFileUrl), ['root']);
  assert.deepEqual(findInCheckoutFixtureCalls(viaFileUrl), [
    { call: 'mkdtempSync', segments: ['packages', 'tmp-new-fixture-'] },
  ]);

  // `export const root = …` is live at .github/scripts/plugin-tree-guard-common.mjs.
  const exported = [
    "export const root = resolve(import.meta.dirname, '../..');",
    "mkdtempSync(join(root, 'packages', '.tmp-exported-'));",
  ].join('\n');
  assert.deepEqual(findRepoRootBindings(exported), ['root']);
  assert.deepEqual(
    findInCheckoutFixtureCalls(exported).map(({ segments }) => segments),
    [['packages', '.tmp-exported-']],
  );

  // A tmpdir root written in either spelling still binds nothing.
  assert.deepEqual(findRepoRootBindings("const dir = resolve(tmpdir(), 'x');"), []);
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
