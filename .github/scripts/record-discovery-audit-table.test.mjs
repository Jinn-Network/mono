import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The §12 "Audit table" of the record-discovery protocol design enumerates, per record
// kind, the leaf that registers it, the reference-bearing set its newest facts profile
// declares, and what its first profile declared. Every one of those is a reading of
// `packages/discovery/facts/*/profiles/*.json`, and until this guard existed nothing read
// the table back: a profile could widen its declared set, or a whole kind could arrive,
// with the table silently going stale (#3391).
//
// The limit is the one §12 already states of its own `profiles.test.ts` pins, and it is
// worth restating because this guard does not lift it: these are change-detectors, not
// completeness proofs. What is proven here is that the table matches the profile
// documents. Whether a profile document is itself complete against the schema it
// describes is a question no mechanical check in this repository answers.

const root = resolve(import.meta.dirname, '../..');
const specPath = join(root, 'docs', 'superpowers', 'specs', '2026-07-27-record-discovery-protocol-design.md');
const factsDir = join(root, 'packages', 'discovery', 'facts');

const TABLE_HEADER_PREFIX = '| Record kind | Leaf | Set | v1 declared |';

/** Backticked tokens of one markdown cell. `_none_` is §12's empty marker. */
function cellTokens(cell) {
  const trimmed = cell.trim();
  if (trimmed === '_none_') return [];
  return [...trimmed.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
}

export function parseAuditTable(markdown = readFileSync(specPath, 'utf8')) {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex((line) => line.startsWith(TABLE_HEADER_PREFIX));
  assert.notEqual(
    headerIndex,
    -1,
    `§12 audit-table header not found. This guard locates the table by the literal prefix "${TABLE_HEADER_PREFIX}"; if the columns were renamed or reordered, update both the table and this guard.`,
  );
  assert.match(
    lines[headerIndex + 1] ?? '',
    /^\|\s*---/u,
    '§12 audit-table header is not followed by a markdown separator row.',
  );

  const rows = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1);
    assert.equal(
      cells.length,
      5,
      `§12 audit-table row ${rows.length + 1} has ${cells.length} columns, expected 5 (line ${index + 1}).`,
    );
    // Only the first four columns are parsed. The *Revision* column is prose and does
    // contain backticks of its own (field names, kind names), so reading tokens from it
    // would mix commentary into the audited sets.
    const [kindCell, leafCell, setCell, v1Cell] = cells;
    const kinds = cellTokens(kindCell);
    const leaves = cellTokens(leafCell);
    assert.ok(kinds.length >= 1, `§12 audit-table row ${rows.length + 1} names no record kind.`);
    assert.equal(
      leaves.length,
      1,
      `§12 audit-table row for ${kinds.join(', ')} must name exactly one leaf, found ${leaves.length}.`,
    );
    rows.push({ kinds, leaf: leaves[0], set: cellTokens(setCell), v1: cellTokens(v1Cell), line: index + 1 });
  }

  assert.ok(rows.length > 0, '§12 audit-table has no data rows.');
  return rows;
}

export function readProfiles(profilesRoot = factsDir) {
  const profiles = [];
  for (const leaf of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!leaf.isDirectory()) continue;
    const dir = join(profilesRoot, leaf.name, 'profiles');
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // a facts leaf need not register any profile
    }
    for (const file of entries.filter((name) => name.endsWith('.json'))) {
      const document = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const kind = document.kind.replace(/^.*\/records\//u, '');
      const profile = document.profile.replace(/^.*\/facts\//u, '');
      const versionSegment = profile.slice(profile.lastIndexOf('/') + 1);
      assert.match(
        versionSegment,
        /^v[0-9]+$/u,
        `${leaf.name}/profiles/${file} declares profile "${document.profile}", whose last segment is not a "v<integer>" version. Ordering newest-vs-first depends on it.`,
      );
      const version = Number.parseInt(versionSegment.slice(1), 10);
      assert.ok(Number.isFinite(version), `${leaf.name}/profiles/${file} has a non-finite profile version.`);
      // `fields` is a flat array whose `name`s are already dotted paths
      // (`runtime.image.manifestDigest`), so a filter reaches every declared path; there
      // is no nesting to walk. This is what `referenceBearingFields()` does in each
      // leaf's own `profiles.test.ts`.
      const referenceBearing = (document.fields ?? [])
        .filter((field) => field.referenceBearing === true)
        .map((field) => field.name);
      profiles.push({ leaf: leaf.name, file, kind, profile, version, referenceBearing });
    }
  }
  assert.ok(profiles.length > 0, `no profile documents found under ${profilesRoot}`);
  return profiles;
}

const rows = parseAuditTable();
const profiles = readProfiles();

/** @type {Map<string, typeof profiles>} */
const byKind = new Map();
for (const profile of profiles) {
  if (!byKind.has(profile.kind)) byKind.set(profile.kind, []);
  byKind.get(profile.kind).push(profile);
}

test('every §12 audit-table row names record kinds that exist in the profile tree', () => {
  for (const row of rows) {
    const missing = row.kinds.filter((kind) => !byKind.has(kind));
    assert.deepEqual(
      missing,
      [],
      `§12 line ${row.line}: table names kind(s) not in tree: ${missing.join(', ')}`,
    );
  }
});

test('every record kind in the profile tree has exactly one §12 audit-table row', () => {
  /** @type {Map<string, number[]>} */
  const rowsByKind = new Map();
  for (const row of rows) {
    for (const kind of row.kinds) {
      if (!rowsByKind.has(kind)) rowsByKind.set(kind, []);
      rowsByKind.get(kind).push(row.line);
    }
  }
  for (const kind of byKind.keys()) {
    assert.ok(
      rowsByKind.has(kind),
      `kind "${kind}" is in the tree but has no audit-table row in §12`,
    );
  }
  for (const [kind, lines] of rowsByKind) {
    assert.equal(lines.length, 1, `kind "${kind}" is named by ${lines.length} §12 rows (lines ${lines.join(', ')})`);
  }
});

test('each §12 row records the leaf that registers its kinds', () => {
  for (const row of rows) {
    for (const kind of row.kinds) {
      for (const profile of byKind.get(kind) ?? []) {
        assert.equal(
          profile.leaf,
          row.leaf,
          `§12 line ${row.line}: ${profile.file} registers "${kind}" in leaf "${profile.leaf}", table says "${row.leaf}"`,
        );
      }
    }
  }
});

test('each §12 *Set* cell equals the newest profile\'s reference-bearing fields, in document order', () => {
  for (const row of rows) {
    const group = orderedGroup(row);
    const newest = group[group.length - 1];
    assert.deepEqual(
      row.set,
      newest.referenceBearing,
      `§12 line ${row.line} (${row.kinds.join(', ')}): Set mismatch: ${JSON.stringify(row.set)} vs ${JSON.stringify(newest.referenceBearing)} (${newest.profile}, ${newest.file})`,
    );
  }
});

test('each §12 *v1 declared* cell equals the first profile\'s reference-bearing fields', () => {
  for (const row of rows) {
    const group = orderedGroup(row);
    const first = group[0];
    assert.deepEqual(
      row.v1,
      first.referenceBearing,
      `§12 line ${row.line} (${row.kinds.join(', ')}): v1-declared mismatch: table ${JSON.stringify(row.v1)} vs ${first.file} ${JSON.stringify(first.referenceBearing)}`,
    );
  }
});

/**
 * The profiles a row audits, oldest first. A row may name more than one record kind —
 * `benchmark-report/v1`, `benchmark-report/v2` is one row over two kind URIs — so newest
 * and first are taken across the union.
 */
function orderedGroup(row) {
  const group = row.kinds.flatMap((kind) => byKind.get(kind) ?? []).sort((a, b) => a.version - b.version);
  assert.ok(group.length > 0, `§12 line ${row.line}: no profile documents for ${row.kinds.join(', ')}`);
  const versions = group.map((profile) => profile.version);
  assert.equal(
    new Set(versions).size,
    versions.length,
    `§12 line ${row.line}: the kinds on this row share a profile version (${versions.join(', ')}), so "newest" and "first" are ambiguous. Split the row.`,
  );
  return group;
}
