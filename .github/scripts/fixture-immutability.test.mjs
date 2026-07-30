import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertMinorBump, compareFixtureManifests } from './fixture-immutability.mjs';

const baseline = {
  version: 1,
  entries: [{ id: 'golden/a.json', sha256: 'aa' }, { id: 'adversarial/b.json', sha256: 'bb' }],
  errata: [],
};

test('an unchanged manifest adds nothing', () => {
  assert.deepEqual(compareFixtureManifests(baseline, baseline, { label: 'packages/trust/core' }), { added: [] });
});

test('an added fixture is allowed and reported', () => {
  const candidate = { ...baseline, entries: [...baseline.entries, { id: 'adversarial/c.json', sha256: 'cc' }] };
  assert.deepEqual(compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }), {
    added: ['adversarial/c.json'],
  });
});

test('a changed fixture byte is refused', () => {
  const candidate = { ...baseline, entries: [{ id: 'golden/a.json', sha256: 'ZZ' }, baseline.entries[1]] };
  assert.throws(
    () => compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }),
    /packages\/trust\/core: golden\/a\.json changed from aa to ZZ; a published fixture is never edited, it is superseded by a new fixture plus a dated erratum/,
  );
});

test('a removed fixture is refused', () => {
  const candidate = { ...baseline, entries: [baseline.entries[0]] };
  assert.throws(
    () => compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }),
    /packages\/trust\/core: adversarial\/b\.json was removed; fixtures are append-only/,
  );
});

test('a correction is accepted as a new fixture plus a dated erratum', () => {
  const candidate = {
    version: 1,
    entries: [...baseline.entries, { id: 'golden/a-corrected.json', sha256: 'cc' }],
    errata: [{ id: 'golden/a.json', supersededBy: 'golden/a-corrected.json', date: '2026-07-30', reason: 'sealed the wrong outcome value' }],
  };
  assert.deepEqual(compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }), {
    added: ['golden/a-corrected.json'],
  });
});

test('errata are append-only', () => {
  const withErratum = {
    ...baseline,
    errata: [{ id: 'golden/a.json', supersededBy: 'golden/a2.json', date: '2026-07-30', reason: 'wrong' }],
  };
  assert.throws(
    () => compareFixtureManifests(withErratum, baseline, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum for golden\/a\.json was removed; errata are append-only/,
  );
});

test('a malformed erratum is refused', () => {
  const candidate = { ...baseline, errata: [{ id: 'golden/a.json', supersededBy: 'nope.json', date: '2026-07-30', reason: 'x' }] };
  assert.throws(
    () => compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum for golden\/a\.json names supersededBy nope\.json, which is not a fixture in this manifest/,
  );
  const undated = { ...baseline, errata: [{ id: 'golden/a.json', supersededBy: 'adversarial/b.json', date: 'soon', reason: 'x' }] };
  assert.throws(
    () => compareFixtureManifests(baseline, undated, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum for golden\/a\.json needs an ISO date \(YYYY-MM-DD\), got soon/,
  );
  const unnamed = { ...baseline, errata: [{ id: 'ghost.json', supersededBy: 'adversarial/b.json', date: '2026-07-30', reason: 'x' }] };
  assert.throws(
    () => compareFixtureManifests(baseline, unnamed, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum names ghost\.json, which is not a fixture in this manifest/,
  );
});

test('an addition against a published version requires a minor bump', () => {
  assert.doesNotThrow(() => assertMinorBump('0.1.0', '0.2.0', { label: 'packages/trust/core', added: ['a.json'] }));
  assert.doesNotThrow(() => assertMinorBump('0.1.0', '0.1.1', { label: 'packages/trust/core', added: [] }));
  assert.throws(
    () => assertMinorBump('0.1.0', '0.1.1', { label: 'packages/trust/core', added: ['a.json'] }),
    /packages\/trust\/core: 1 fixture added since 0\.1\.0 \(a\.json\); a fixture addition is at least a minor bump, but 0\.1\.1 keeps minor 1/,
  );
});

test('a major bump also satisfies the addition rule', () => {
  assert.doesNotThrow(() => assertMinorBump('0.9.0', '1.0.0', { label: 'packages/trust/core', added: ['a.json'] }));
});

test('a version that goes backwards is refused outright', () => {
  assert.throws(
    () => assertMinorBump('0.2.0', '0.1.0', { label: 'packages/trust/core', added: [] }),
    /packages\/trust\/core: candidate 0\.1\.0 is not ahead of the published 0\.2\.0/,
  );
});
