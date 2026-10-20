import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function relPath(absPath) {
  return absPath.slice(root.length + 1);
}

const SCAN_DIRS = ['content', 'app', 'components'];

function scanFiles() {
  return SCAN_DIRS.flatMap((d) => walk(resolve(root, d)));
}

// Conservative emoji check over the common pictographic ranges, plus the
// variation-selector-16 (emoji presentation) codepoint.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

test('no emoji in content/, app/, or components/', () => {
  const violations = [];
  for (const file of scanFiles()) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (EMOJI_RE.test(line)) {
        violations.push(`${relPath(file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], `emoji found:\n${violations.join('\n')}`);
});

function mdxFilesUnder(dir) {
  return walk(dir).filter((f) => f.endsWith('.mdx'));
}

test('every content/docs/**/*.mdx has non-empty title and description frontmatter', () => {
  const docsRoot = resolve(root, 'content/docs');
  const files = mdxFilesUnder(docsRoot);
  assert.ok(files.length > 0, 'no .mdx files found under content/docs — check the path');

  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      violations.push(`${relPath(file)}: missing YAML frontmatter block`);
      continue;
    }
    const frontmatter = match[1];
    const titleMatch = frontmatter.match(/^title:\s*(.*)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.*)$/m);
    if (!titleMatch || !titleMatch[1].trim()) {
      violations.push(`${relPath(file)}: missing or empty title`);
    }
    if (!descMatch || !descMatch[1].trim()) {
      violations.push(`${relPath(file)}: missing or empty description`);
    }
  }
  assert.deepEqual(violations, []);
});

test('every content/docs/**/meta.json is bidirectionally complete with its directory', () => {
  const docsRoot = resolve(root, 'content/docs');
  const metaFiles = walk(docsRoot).filter((f) => f.endsWith('meta.json'));
  assert.ok(metaFiles.length > 0, 'no meta.json files found under content/docs — check the path');

  const violations = [];
  for (const metaFile of metaFiles) {
    const dir = dirname(metaFile);
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const pages = Array.isArray(meta.pages) ? meta.pages : [];

    // Every listed page resolves to a sibling .mdx file or subdirectory.
    for (const page of pages) {
      const asFile = join(dir, `${page}.mdx`);
      const asDir = join(dir, page);
      const fileExists = existsSync(asFile) && statSync(asFile).isFile();
      const dirExists = existsSync(asDir) && statSync(asDir).isDirectory();
      if (!fileExists && !dirExists) {
        violations.push(`${relPath(metaFile)}: listed page "${page}" has no matching .mdx file or subdirectory`);
      }
    }

    // Every .mdx / subdirectory in this directory is listed.
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === 'meta.json') continue;
      const full = join(dir, entry);
      const isDir = statSync(full).isDirectory();
      const name = isDir ? entry : entry.replace(/\.mdx$/, '');
      if (!isDir && !entry.endsWith('.mdx')) continue;
      // A subfolder's own index.mdx is deliberately unlisted: Fumadocs then
      // links the folder title to it, rather than rendering the folder title
      // and a child entry carrying the same name.
      if (!isDir && name === 'index' && dir !== docsRoot) continue;
      if (!pages.includes(name)) {
        violations.push(`${relPath(metaFile)}: "${name}" exists in the directory but is not listed in pages`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('app/(home)/page.tsx carries exactly one CTA, and it is "Bring a claim" (GROWTH.md §3)', () => {
  const pagePath = resolve(root, 'app/(home)/page.tsx');
  const text = readFileSync(pagePath, 'utf8');

  const buttonOpens = text.match(/<Button/g) ?? [];
  assert.equal(
    buttonOpens.length,
    1,
    'app/(home)/page.tsx must contain exactly one <Button: GROWTH.md §3 names one call to ' +
      'action for every outward surface',
  );

  // The single Button's block carries the CTA destination and the CTA's own words.
  const buttonBlockMatch = text.match(/<Button[\s\S]*?<\/Button>/);
  assert.ok(buttonBlockMatch, 'could not locate the <Button>...</Button> block');
  assert.ok(
    buttonBlockMatch[0].includes('links.bringAClaim'),
    'the single <Button> on app/(home)/page.tsx must use links.bringAClaim as its href ' +
      '(GROWTH.md §3 single CTA)',
  );
  assert.match(
    buttonBlockMatch[0],
    />\s*Bring a claim\s*</,
    'the single <Button> must read "Bring a claim", the call to action GROWTH.md §3 names',
  );

  // The destination lives in lib/shared.ts and nowhere else on the page.
  const shared = readFileSync(resolve(root, 'lib/shared.ts'), 'utf8');
  assert.match(
    shared,
    /bringAClaim:\s*'https:\/\/colophon\.claims\/[^']*'/,
    'links.bringAClaim must point at colophon.claims',
  );
  const literalHosts = text.match(/colophon\.claims|t\.me\//g) ?? [];
  assert.equal(
    literalHosts.length,
    0,
    'app/(home)/page.tsx must not hard-code an outbound host; route it through links (lib/shared.ts)',
  );
});

const FORBIDDEN_VERBS = [
  'paid',
  'pays',
  'compensation',
  'proven',
  'guaranteed',
  'co-founder',
  'team',
  'executive',
];
const FORBIDDEN_VERBS_RE = new RegExp(
  `\\b(${FORBIDDEN_VERBS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

test('no forbidden words in content/** or app/**', () => {
  const files = ['content', 'app'].flatMap((d) => walk(resolve(root, d)));
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      const match = line.match(FORBIDDEN_VERBS_RE);
      if (match) {
        violations.push(`${relPath(file)}:${i + 1}: forbidden word "${match[1]}": ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

// Where the site's copy lives: the docs tree, the page and layout modules,
// and the shared nav and link table.
function copyFiles() {
  return [
    ...walk(resolve(root, 'content')),
    ...walk(resolve(root, 'app')).filter((f) => f.endsWith('.tsx')),
    ...walk(resolve(root, 'lib')),
  ];
}

// Matches over the whole file, so a pattern that allows `\s+` between words
// still finds a phrase the source wraps across two lines.
function scanCopy(re) {
  const everywhere = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const violations = [];
  for (const file of copyFiles()) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const match of text.matchAll(everywhere)) {
      const line = text.slice(0, match.index).split('\n').length;
      violations.push(
        `${relPath(file)}:${line}: "${match[0].replace(/\s+/g, ' ')}": ${lines[line - 1].trim()}`,
      );
    }
  }
  return violations;
}

test('copy has no em dashes', () => {
  assert.deepEqual(scanCopy(/—/), []);
});

// The task marketplace is parked. The site may say so; it may not hand a
// visitor a command, a package, or a door that belongs to it.
const PARKED_FLOW_RE = new RegExp(
  [
    '@jinn-network/(client|operator)',
    '\\bjinn (run|init|bootstrap|doctor|fund-requirements|tasks|evidence|solver-nets)\\b',
    '\\.jinn-(client|operator)\\b',
    'JINN_PASSWORD',
    '/docs/(build|operate)\\b',
  ].join('|'),
);

test('nothing walks the parked task marketplace as if it were live', () => {
  assert.deepEqual(scanCopy(PARKED_FLOW_RE), []);
});

// Copy the parked story used, the old site's own headings (issue #4770
// quotes them), and stub notices. None of it comes back. A space in a phrase
// matches any run of whitespace, so a phrase wrapped across source lines is
// still the phrase.
const RETIRED_PHRASES = [
  'not yet written',
  'coming soon',
  'open work that compounds',
  'knowledge economy',
  'evidence work creates',
  'post a task',
  'posts a task',
  'run an operator',
  'operators earn',
  'join the telegram',
  'bring us a task',
  'run an agent',
  'put your agent to work',
  'market for work done by ai agents',
  'watch the network live',
];
const RETIRED_COPY_RE = new RegExp(
  RETIRED_PHRASES.map((phrase) => phrase.replace(/ /g, '\\s+')).join('|'),
  'i',
);

test('no stub notices and no copy from the parked story', () => {
  assert.deepEqual(scanCopy(RETIRED_COPY_RE), []);
});

// Nothing on the site invites a visitor to earn, stake or fund. The parked
// pages may tell a visitor not to, so a clause with a negation ahead of the
// verb ("Do not fund an account", "no pool to fund") is not an invitation.
// Clauses end at a sentence mark or a tag, and the check reads one line at a
// time, so a negation on another line never excuses a verb.
const INVITATION_VERB_RE = /\b(earn|earning|stake|staking|fund|funding)\b/gi;
const NEGATION_RE = /\b(not|no|never|nothing|without)\b|n't\b/i;

test('nothing invites a visitor to earn, stake or fund', () => {
  const violations = [];
  for (const file of copyFiles()) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const plain = line.replace(/&rsquo;|\u2019/g, "'").replace(/&\w+;/g, ' ');
        for (const clause of plain.split(/[.!?:;]|<[^>]*>/)) {
          for (const match of clause.matchAll(INVITATION_VERB_RE)) {
            if (!NEGATION_RE.test(clause.slice(0, match.index))) {
              violations.push(`${relPath(file)}:${i + 1}: "${match[0]}": ${line.trim()}`);
            }
          }
        }
      });
  }
  assert.deepEqual(violations, []);
});

// The site title and description are a link preview, which has no room for
// the sentence that says buying and selling records is the direction, not a
// working market. So they may not use the words that present it as working.
// BRAND.md's canonical line says "sold"; the site says "offered".
// test/build-output.test.mjs holds the same list for the built page.
const MARKET_WORDS_RE = /\b(sold|sells?|selling|buy|buys|buying|bought|markets?|marketplace)\b/i;

function layoutConstant(name) {
  const source = readFileSync(resolve(root, 'app/layout.tsx'), 'utf8');
  const match = source.match(new RegExp(`const ${name} =\\s*(['\`])([\\s\\S]*?)\\1;`));
  assert.ok(match, `could not find "const ${name} = ..." in app/layout.tsx; this test reads it`);
  return match[2];
}

test('the site title and description do not present the market as working', () => {
  for (const name of ['title', 'description']) {
    const text = layoutConstant(name);
    assert.doesNotMatch(
      text,
      MARKET_WORDS_RE,
      `the site ${name} is "${text}". Buying and selling records is the direction, not a ` +
        `working market (BRAND.md); the ${name} has no room to say so.`,
    );
  }
});

// The words the site puts in quotation marks are the words of a source a
// reader can open. Each quotation is checked against its source before it is
// listed here, so a paraphrase inside quotation marks fails.
const VERIFIED_QUOTATIONS = new Map([
  ['written from the spec alone', 'https://github.com/Jinn-Network/spec#what-is-not-yet-proven'],
]);

test('every quotation in the copy is verbatim from the source it names', () => {
  const unverified = [];
  for (const file of copyFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/&ldquo;([\s\S]*?)&rdquo;|\u201C([\s\S]*?)\u201D/g)) {
      const words = (match[1] ?? match[2]).replace(/\s+/g, ' ').trim();
      if (!VERIFIED_QUOTATIONS.has(words)) unverified.push(`${relPath(file)}: "${words}"`);
    }
  }
  assert.deepEqual(
    unverified,
    [],
    'a quotation must match its source word for word; once checked, list it in VERIFIED_QUOTATIONS',
  );
});

// Only `@colophon-claims/verify` is published. The other Colophon packages
// are 0.0.0 name reservations, so no command on the site may install or run
// them, and the checker is always pinned to an exact version.
test('every Colophon command on the site runs a published, pinned package', () => {
  const unpublished = scanCopy(
    /\b(npx|npm (i|install|exec)|yarn (add|dlx)|pnpm (add|dlx))\b[^\n]*@colophon-claims\/(?!verify\b)/,
  );
  assert.deepEqual(unpublished, []);

  const unpinned = scanCopy(/\bnpx\b[^\n]*@colophon-claims\/verify(?!@\d+\.\d+\.\d+)/);
  assert.deepEqual(unpinned, []);
});

test('the landing page names Colophon, links the specification, and labels the explorer', () => {
  const page = readFileSync(resolve(root, 'app/(home)/page.tsx'), 'utf8');
  assert.match(page, /links\.colophon\b/, 'the landing page must link Colophon (links.colophon)');
  assert.match(page, /links\.spec\b/, 'the landing page must link the specification (links.spec)');

  const shared = readFileSync(resolve(root, 'lib/shared.ts'), 'utf8');
  assert.match(
    shared,
    /spec:\s*'https:\/\/github\.com\/Jinn-Network\/spec'/,
    'links.spec must be the specification repository',
  );

  // An explorer link is a link to a record of the parked network. Its own
  // words must say so, wherever it appears in a page or in the nav.
  const unlabelled = [];
  for (const file of copyFiles().filter((f) => f.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/<a\s+href=\{links\.explorer\}[^>]*>([\s\S]*?)<\/a>/g)) {
      if (!/record/i.test(match[1])) unlabelled.push(`${relPath(file)}: ${match[0]}`);
    }
    for (const match of text.matchAll(/\{[^{}]*links\.explorer[^{}]*\}/g)) {
      if (/text:/.test(match[0]) && !/record/i.test(match[0])) {
        unlabelled.push(`${relPath(file)}: ${match[0]}`);
      }
    }
  }
  for (const file of mdxFilesUnder(resolve(root, 'content/docs'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]*explorer\.jinn\.network[^)]*)\)/g)) {
      if (!/record/i.test(match[1])) unlabelled.push(`${relPath(file)}: ${match[0]}`);
    }
    // A bare explorer URL carries no label at all.
    const bare = text.replace(/\]\([^)]*\)/g, '').match(/https?:\/\/explorer\.jinn\.network\S*/);
    if (bare) unlabelled.push(`${relPath(file)}: bare link ${bare[0]}`);
  }
  assert.deepEqual(unlabelled, []);
});
