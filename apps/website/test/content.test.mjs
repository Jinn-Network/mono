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

test('app/(home)/page.tsx carries exactly one CTA, and it is the Telegram link (GROWTH.md §3)', () => {
  const pagePath = resolve(root, 'app/(home)/page.tsx');
  const text = readFileSync(pagePath, 'utf8');

  const buttonOpens = text.match(/<Button/g) ?? [];
  assert.equal(
    buttonOpens.length,
    1,
    'app/(home)/page.tsx must contain exactly one <Button — GROWTH.md §3 binds every outward ' +
      'surface to a single CTA until the v0 gate produces a result',
  );

  // The single Button's block should carry the Telegram href.
  const buttonBlockMatch = text.match(/<Button[\s\S]*?<\/Button>/);
  assert.ok(buttonBlockMatch, 'could not locate the <Button>...</Button> block');
  assert.ok(
    buttonBlockMatch[0].includes('links.telegram'),
    'the single <Button> on app/(home)/page.tsx must use links.telegram as its href — ' +
      'GROWTH.md §3 single CTA',
  );

  // No literal t.me/ string outside of the links.telegram indirection.
  const literalTme = text.match(/t\.me\//g) ?? [];
  assert.equal(
    literalTme.length,
    0,
    'app/(home)/page.tsx must not contain a literal "t.me/" string — route the CTA through ' +
      'links.telegram (lib/shared.ts) instead, per GROWTH.md §3',
  );
});

const FORBIDDEN_VERBS = ['paid', 'pays', 'compensation', 'proven', 'guaranteed', 'co-founder'];
const FORBIDDEN_VERBS_RE = new RegExp(
  `\\b(${FORBIDDEN_VERBS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

test('no forbidden verbs in content/** or app/**', () => {
  const files = ['content', 'app'].flatMap((d) => walk(resolve(root, d)));
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      const match = line.match(FORBIDDEN_VERBS_RE);
      if (match) {
        violations.push(`${relPath(file)}:${i + 1}: forbidden verb "${match[1]}" — ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});
