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
// The dated design is frozen. Historical §12 rows for kinds whose facts leaf has since
// been removed are not current tree membership: RETIRED_RECORD_KINDS is the live
// annotation, not a spec edit. A kind listed there that still has profile documents is
// a contradiction. A kind *not* listed there that is missing from the tree still fails.
// Every kind that still has profile documents must still have a table row.
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

// Kinds on the dated §12 rows for `packages/discovery/facts/benchmarking`, removed by
// #3986. The rows stay in the frozen design; this set is what teaches the live join
// that they are historical, not a missing leaf.
export const RETIRED_RECORD_KINDS = new Set([
  'benchmark/v1',
  'benchmark-run/v1',
  'benchmark-matrix/v1',
  'benchmark-accounting/v1',
  'benchmark-report/v1',
  'benchmark-report/v2',
]);

/**
 * Backticked tokens of one markdown cell. `_none_` is §12's empty marker, and it is the only
 * way to write an empty cell: a cell with no backticked token that is not exactly `_none_`
 * (bare prose, or nothing) is refused rather than read as `[]`, which would otherwise pass
 * for a declared-empty set.
 */
function cellTokens(cell) {
  const trimmed = cell.trim();
  if (trimmed === '_none_') return [];
  const tokens = [...trimmed.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
  assert.ok(
    tokens.length > 0,
    `§12 audit-table cell "${trimmed}" names no backticked token. Write an empty cell as _none_.`,
  );
  return tokens;
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
      // The assertion above already guarantees at least one digit after the `v`, so this
      // parse always yields a finite integer; there is nothing further to check here.
      const version = Number.parseInt(versionSegment.slice(1), 10);
      // `fields` is a flat array whose `name`s are already dotted paths
      // (`runtime.image.manifestDigest`), so a filter reaches every declared path; there
      // is no nesting to walk. This is what `referenceBearingFields()` does; it is defined
      // in `packages/discovery/protocol/src/facts-profile.ts`, and each leaf's own
      // `profiles.test.ts` imports it to pin its profiles.
      const referenceBearing = (document.fields ?? [])
        .filter((field) => field.referenceBearing === true)
        .map((field) => field.name);
      profiles.push({ leaf: leaf.name, file, kind, profile, version, referenceBearing });
    }
  }
  assert.ok(profiles.length > 0, `no profile documents found under ${profilesRoot}`);
  return profiles;
}

function groupProfilesByKind(profileList) {
  /** @type {Map<string, typeof profileList>} */
  const grouped = new Map();
  for (const profile of profileList) {
    if (!grouped.has(profile.kind)) grouped.set(profile.kind, []);
    grouped.get(profile.kind).push(profile);
  }
  return grouped;
}

function rowIsRetired(row, retiredKinds) {
  return row.kinds.length > 0 && row.kinds.every((kind) => retiredKinds.has(kind));
}

function fakeProfile(kind, leaf, referenceBearing, version = 1) {
  return {
    leaf,
    file: `${kind.replace('/', '.')}.json`,
    kind,
    profile: `${kind}/facts/v${version}`,
    version,
    referenceBearing,
  };
}

export function assertTableKindsExistInTree(tableRows, profilesByKind, retiredKinds = RETIRED_RECORD_KINDS) {
  for (const row of tableRows) {
    if (rowIsRetired(row, retiredKinds)) {
      const stillLive = row.kinds.filter((kind) => profilesByKind.has(kind));
      assert.deepEqual(
        stillLive,
        [],
        `§12 line ${row.line}: retired kind(s) still in tree: ${stillLive.join(', ')}`,
      );
      continue;
    }
    const retiredOnRow = row.kinds.filter((kind) => retiredKinds.has(kind));
    const liveOnRow = row.kinds.filter((kind) => !retiredKinds.has(kind));
    assert.deepEqual(
      retiredOnRow,
      [],
      `§12 line ${row.line}: mixes retired kind(s) ${retiredOnRow.join(', ')} with live kind(s) ${liveOnRow.join(', ')}`,
    );
    const missing = row.kinds.filter((kind) => !profilesByKind.has(kind));
    assert.deepEqual(
      missing,
      [],
      `§12 line ${row.line}: table names kind(s) not in tree: ${missing.join(', ')}`,
    );
  }
}

export function assertLiveKindsHaveTableRows(tableRows, profilesByKind, retiredKinds = RETIRED_RECORD_KINDS) {
  /** @type {Map<string, number[]>} */
  const tableLinesByKind = new Map();
  for (const row of tableRows) {
    for (const kind of row.kinds) {
      if (!tableLinesByKind.has(kind)) tableLinesByKind.set(kind, []);
      tableLinesByKind.get(kind).push(row.line);
    }
  }
  for (const kind of profilesByKind.keys()) {
    assert.ok(
      !retiredKinds.has(kind),
      `kind "${kind}" is listed as retired but still has profile documents`,
    );
    assert.ok(
      tableLinesByKind.has(kind),
      `kind "${kind}" is in the tree but has no audit-table row in §12`,
    );
  }
  for (const [kind, lines] of tableLinesByKind) {
    assert.equal(lines.length, 1, `kind "${kind}" is named by ${lines.length} §12 rows (lines ${lines.join(', ')})`);
  }
}

const rows = parseAuditTable();
const profiles = readProfiles();
const byKind = groupProfilesByKind(profiles);

test('every §12 audit-table row names record kinds that exist in the profile tree', () => {
  assertTableKindsExistInTree(rows, byKind);
});

test('every record kind in the profile tree has exactly one §12 audit-table row', () => {
  assertLiveKindsHaveTableRows(rows, byKind);
});

test('each §12 row records the leaf that registers its kinds', () => {
  for (const row of rows) {
    if (rowIsRetired(row, RETIRED_RECORD_KINDS)) continue;
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
    if (rowIsRetired(row, RETIRED_RECORD_KINDS)) continue;
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
    if (rowIsRetired(row, RETIRED_RECORD_KINDS)) continue;
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
function orderedGroup(row, profilesByKind = byKind) {
  const group = row.kinds.flatMap((kind) => profilesByKind.get(kind) ?? []).sort((a, b) => a.version - b.version);
  assert.ok(group.length > 0, `§12 line ${row.line}: no profile documents for ${row.kinds.join(', ')}`);
  const versions = group.map((profile) => profile.version);
  assert.equal(
    new Set(versions).size,
    versions.length,
    `§12 line ${row.line}: the kinds on this row share a profile version (${versions.join(', ')}), so "newest" and "first" are ambiguous. Split the row.`,
  );
  return group;
}

/** A one-row §12 audit table with the given *Set* and *v1 declared* cells. */
function syntheticTable(setCell, v1Cell) {
  return [
    `${TABLE_HEADER_PREFIX} Revision |`,
    '| --- | --- | --- | --- | --- |',
    `| \`benchmark/v1\` | \`benchmarking\` | ${setCell} | ${v1Cell} | prose |`,
    '',
  ].join('\n');
}

function syntheticRows(bodyRows) {
  return parseAuditTable(
    [
      `${TABLE_HEADER_PREFIX} Revision |`,
      '| --- | --- | --- | --- | --- |',
      ...bodyRows,
      '',
    ].join('\n'),
  );
}

test('a *Set* or *v1 declared* cell must be `_none_` or carry at least one backticked token', () => {
  assert.deepEqual(parseAuditTable(syntheticTable('_none_', '`benchmarkDigest`'))[0].set, []);
  assert.deepEqual(parseAuditTable(syntheticTable('`a`, `b`', '_none_'))[0].set, ['a', 'b']);
  // Bare prose used to parse as `[]` and so silently pass for an empty declared set.
  assert.throws(() => parseAuditTable(syntheticTable('none declared', '_none_')), /_none_/u);
  assert.throws(() => parseAuditTable(syntheticTable('_none_', 'same as Set')), /_none_/u);
  assert.throws(() => parseAuditTable(syntheticTable('', '_none_')), /_none_/u);
});

test('without a retired-kind annotation, historical §12 rows fail as missing tree membership', () => {
  assert.throws(
    () => assertTableKindsExistInTree(rows, byKind, new Set()),
    /§12 line 1054: table names kind\(s\) not in tree: benchmark\/v1/u,
  );
});

test('without a retired-kind annotation, Set and v1 checks fail for missing profiles', () => {
  const historical = rows.find((row) => row.kinds.includes('benchmark/v1'));
  assert.ok(historical, 'dated §12 table no longer names benchmark/v1; retarget this regression');
  assert.throws(
    () => orderedGroup(historical, byKind),
    /§12 line 1054: no profile documents for benchmark\/v1/u,
  );
});

test('historical §12 rows for retired kinds are not current tree membership', () => {
  assertTableKindsExistInTree(rows, byKind);
  for (const kind of RETIRED_RECORD_KINDS) {
    assert.equal(byKind.has(kind), false, `retired kind "${kind}" unexpectedly has profile documents`);
    assert.ok(
      rows.some((row) => row.kinds.includes(kind)),
      `retired kind "${kind}" is not named by the dated §12 table; drop it from RETIRED_RECORD_KINDS`,
    );
  }
  assert.doesNotThrow(() => assertTableKindsExistInTree(parseAuditTable(syntheticTable('`taskDigests`', '_none_')), new Map()));
});

test('a live kind without a §12 row still fails', () => {
  const tableRows = syntheticRows([
    '| `environment/v1` | `environments` | `image.manifestDigest` | `image.manifestDigest` | prose |',
  ]);
  const profilesByKind = groupProfilesByKind([
    fakeProfile('environment/v1', 'environments', ['image.manifestDigest']),
    fakeProfile('offer/v1', 'offers', ['subject', 'supersedes']),
  ]);
  assert.throws(
    () => assertLiveKindsHaveTableRows(tableRows, profilesByKind),
    /kind "offer\/v1" is in the tree but has no audit-table row in §12/u,
  );
});

test('a non-retired kind named by §12 but missing from the tree still fails', () => {
  const tableRows = syntheticRows([
    '| `environment/v1` | `environments` | `image.manifestDigest` | `image.manifestDigest` | prose |',
    '| `offer/v1` | `offers` | `subject`, `supersedes` | `subject`, `supersedes` | prose |',
  ]);
  const profilesByKind = groupProfilesByKind([
    fakeProfile('environment/v1', 'environments', ['image.manifestDigest']),
  ]);
  assert.throws(
    () => assertTableKindsExistInTree(tableRows, profilesByKind),
    /table names kind\(s\) not in tree: offer\/v1/u,
  );
});
