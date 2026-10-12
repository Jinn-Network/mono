import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// Reader-vocabulary pin (#4895). Section 5 of the reader-facing vocabulary spec
// is the ruled glossary. `PUBLIC-BUNDLE.md` and `EXTERNAL-VERIFICATION.md` each
// carry a "Reader vocabulary" table that restates it, one row per contract
// spelling. Nothing else keeps those three tables equal, so an edit to any one
// of them drifts silently. This guard parses all three and fails on any
// difference.
//
// It lives under `.github/scripts` and is wired into `repository-structure.yml`
// because that workflow runs on every pull request and merge group. The
// Benchmark Product CI lane runs only on pull requests and only when
// `packages/benchmark-product/**` changes, so a test placed there would miss an
// edit to the spec section alone.
//
// Row order is not normative: each table is a lookup from a contract spelling
// to a reader-facing name, so the comparison keys on the contract spelling.
// Whitespace inside a cell is not normative either. Everything else in a cell,
// code spans included, is part of the spelling and must match exactly.

const SPEC_PATH = 'docs/superpowers/specs/2026-09-02-reader-facing-vocabulary.md';
const SPEC_HEADING = /^##\s+5\.\s+Canonical glossary\s*$/u;
const SPEC_COLUMNS = ['Concept', 'Reader-facing name', 'Contract spelling (unchanged)'];
const DOC_HEADING = /^##\s+Reader vocabulary\s*$/u;
const DOC_COLUMNS = ['Contract spelling', 'Reader-facing name'];
const DOC_PATHS = [
  'packages/benchmark-product/PUBLIC-BUNDLE.md',
  'packages/benchmark-product/EXTERNAL-VERIFICATION.md',
];

const squeeze = (text) => text.replace(/\s+/gu, ' ').trim();

/**
 * Splits one table row into cells on top-level pipes. A pipe inside a code span
 * or after a backslash is cell content, not a separator.
 */
export function splitRow(line) {
  const cells = [];
  let current = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/u, '');
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '`') {
      inCode = !inCode;
      current += char;
    } else if (char === '|' && !inCode) {
      cells.push(squeeze(current));
      current = '';
    } else {
      current += char;
    }
  }
  if (squeeze(current) !== '') cells.push(squeeze(current));
  return cells;
}

const isDelimiterRow = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));

/**
 * The first table under the first heading matching `headingPattern`, read until
 * the next `## ` heading. Throws, naming `label`, when the heading, the table,
 * or the expected header row is missing, so a renamed heading or a reordered
 * column reads as a loud failure and never as an empty comparison.
 */
export function readTable(markdown, headingPattern, columns, label) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) throw new Error(`${label}: heading ${headingPattern} not found`);
  const rows = [];
  let header = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/u.test(line)) break;
    if (!line.trim().startsWith('|')) {
      if (header && rows.length > 0) break;
      continue;
    }
    const cells = splitRow(line);
    if (!header) {
      header = cells;
      continue;
    }
    if (isDelimiterRow(cells)) continue;
    rows.push(cells);
  }
  if (!header) throw new Error(`${label}: no table under the heading`);
  assert.deepEqual(header, columns, `${label}: header row is not the expected columns`);
  for (const row of rows) {
    assert.equal(row.length, columns.length, `${label}: row has ${row.length} cells, expected ${columns.length}: ${row.join(' | ')}`);
  }
  return rows;
}

/** Contract spelling to reader-facing name. A repeated contract spelling throws. */
export function vocabularyOf(markdown, kind, label) {
  const rows = kind === 'spec'
    ? readTable(markdown, SPEC_HEADING, SPEC_COLUMNS, label).map(([, reader, contract]) => [contract, reader])
    : readTable(markdown, DOC_HEADING, DOC_COLUMNS, label);
  const map = new Map();
  for (const [contract, reader] of rows) {
    assert.ok(!map.has(contract), `${label}: contract spelling listed twice: ${contract}`);
    map.set(contract, reader);
  }
  assert.ok(map.size > 0, `${label}: table has no rows`);
  return map;
}

/** Human-readable differences between a doc's vocabulary and the spec's. Empty means equal. */
export function differences(spec, doc, docLabel) {
  const found = [];
  for (const [contract, reader] of spec) {
    if (!doc.has(contract)) found.push(`${docLabel}: missing row for ${contract} (spec: ${reader})`);
    else if (doc.get(contract) !== reader) {
      found.push(`${docLabel}: ${contract} reads "${doc.get(contract)}", spec section 5 says "${reader}"`);
    }
  }
  for (const [contract, reader] of doc) {
    if (!spec.has(contract)) found.push(`${docLabel}: row for ${contract} (${reader}) is not in spec section 5`);
  }
  return found;
}

const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('both reader-vocabulary tables match section 5 of the vocabulary spec', () => {
  const spec = vocabularyOf(read(SPEC_PATH), 'spec', SPEC_PATH);
  for (const path of DOC_PATHS) {
    const doc = vocabularyOf(read(path), 'doc', path);
    assert.deepEqual(differences(spec, doc, path), [], `${path} drifted from ${SPEC_PATH} section 5`);
  }
});

const SPEC_FIXTURE = `# Spec

## 4. Surfaces

| Concept | Reader-facing name | Contract spelling (unchanged) |
| --- | --- | --- |
| Not the glossary | decoy | \`decoy\` |

## 5. Canonical glossary

Prose before the table.

| Concept | Reader-facing name | Contract spelling (unchanged) |
| --- | --- | --- |
| One configuration under test | configuration | \`arm\`, \`armId\` |
| One task run by one configuration once | run | \`cell\`, \`cellKey\` |
| Proof that bytes existed by a time | timestamp proof | \`anchor\` |

## 6. Next section

| Concept | Reader-facing name | Contract spelling (unchanged) |
| --- | --- | --- |
| Beyond the glossary | decoy | \`beyond\` |
`;

const docFixture = (rows) => `# Doc

## Reader vocabulary

Prose before the table.

| Contract spelling | Reader-facing name |
| --- | --- |
${rows.join('\n')}

## Identity and closure

| Contract spelling | Reader-facing name |
| --- | --- |
| \`decoy\` | decoy |
`;

const FIXTURE_ROWS = [
  '| `arm`, `armId` | configuration |',
  '| `cell`, `cellKey` | run |',
  '| `anchor` | timestamp proof |',
];

const fixtureDifferences = (rows) =>
  differences(
    vocabularyOf(SPEC_FIXTURE, 'spec', 'spec fixture'),
    vocabularyOf(docFixture(rows), 'doc', 'doc fixture'),
    'doc fixture',
  );

test('self-test: a matching table is clean, and only the section 5 and Reader vocabulary tables are read', () => {
  assert.deepEqual(fixtureDifferences(FIXTURE_ROWS), []);
});

test('self-test: a changed reader-facing name is caught', () => {
  const found = fixtureDifferences(['| `arm`, `armId` | setup |', ...FIXTURE_ROWS.slice(1)]);
  assert.equal(found.length, 1);
  assert.match(found[0], /`arm`, `armId` reads "setup", spec section 5 says "configuration"/u);
});

test('self-test: a changed contract spelling is caught as a missing and an extra row', () => {
  const found = fixtureDifferences(['| `arm` | configuration |', ...FIXTURE_ROWS.slice(1)]);
  assert.equal(found.length, 2);
  assert.match(found[0], /missing row for `arm`, `armId`/u);
  assert.match(found[1], /row for `arm` \(configuration\) is not in spec section 5/u);
});

test('self-test: a dropped row and an added row are caught', () => {
  assert.match(fixtureDifferences(FIXTURE_ROWS.slice(0, 2)).join('\n'), /missing row for `anchor`/u);
  assert.match(fixtureDifferences([...FIXTURE_ROWS, '| `extra` | extra name |']).join('\n'), /row for `extra` \(extra name\) is not in spec section 5/u);
});

test('self-test: a changed code span is caught, because the contract spelling is part of the row', () => {
  assert.equal(fixtureDifferences([FIXTURE_ROWS[0].replace('`armId`', 'armId'), ...FIXTURE_ROWS.slice(1)]).length, 2);
});

test('self-test: a repeated contract spelling is refused rather than silently collapsed', () => {
  assert.throws(() => vocabularyOf(docFixture([...FIXTURE_ROWS, FIXTURE_ROWS[0]]), 'doc', 'doc fixture'), /listed twice/u);
});

test('self-test: a renamed heading, swapped columns, or a short row fails loudly instead of comparing nothing', () => {
  assert.throws(() => vocabularyOf(docFixture(FIXTURE_ROWS).replace('## Reader vocabulary', '## Vocabulary'), 'doc', 'doc fixture'), /heading .* not found/u);
  assert.throws(
    () => vocabularyOf(docFixture(FIXTURE_ROWS).replace('| Contract spelling | Reader-facing name |', '| Reader-facing name | Contract spelling |'), 'doc', 'doc fixture'),
    /header row is not the expected columns/u,
  );
  assert.throws(() => vocabularyOf(docFixture([...FIXTURE_ROWS, '| `short` |']), 'doc', 'doc fixture'), /row has 1 cells, expected 2/u);
});

test('self-test: whitespace and row order are not drift', () => {
  const reordered = [FIXTURE_ROWS[2], FIXTURE_ROWS[0], FIXTURE_ROWS[1]];
  assert.deepEqual(fixtureDifferences(reordered), []);
  const spaced = [
    '|   `arm`,   `armId`   |   configuration   |',
    '|`cell`, `cellKey`|run|',
    '| `anchor` |\ttimestamp   proof |',
  ];
  assert.deepEqual(fixtureDifferences(spaced), []);
  assert.deepEqual(fixtureDifferences(FIXTURE_ROWS.map((row) => `${row}  `)), []);
});

test('self-test: a pipe inside a code span stays inside its cell', () => {
  assert.deepEqual(splitRow('| `a|b` | name |'), ['`a|b`', 'name']);
  assert.deepEqual(splitRow('| a \\| b | name |'), ['a | b', 'name']);
});
