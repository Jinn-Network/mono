import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// §18 of the record-discovery protocol design enumerates the conformance corpus in prose;
// `packages/discovery/testing/fixtures/vectors/` holds the vectors that discharge it. The two
// were maintained 1:1 by convention only, in neither direction, and the convention had
// already broken: seven vectors were in the corpus with no §18 claim naming them (#3557).
//
// COVERAGE below is the map between them. Three assertions bind it:
//
//   A. the map is in step with §18 itself — §18's claim partition is re-derived from the
//      document and compared element-for-element, so a claim added to, removed from, or
//      reworded in §18 fails here rather than leaving a second list to drift;
//   B. every §18 claim names at least one vector that is actually in the loaded corpus;
//   C. every vector in the loaded corpus is named by at least one §18 claim.
//
// The limit, in §12's own words about its audit table: these are change-detectors, not
// completeness proofs. A + B + C prove §18 and the corpus correspond. Whether a vector
// actually exercises the claim it is mapped to is a reading, and the initial mapping is
// authored judgment; what the guard removes is the *drift* from that reading.
//
// The map lives here rather than in the fixtures tree on purpose. Everything under
// `fixtures/` is digested by `fixture-manifest.mjs` and frozen append-only by
// `fixture-immutability.mjs`, so a coverage map placed there could never be edited again
// without a dated erratum — and it must change every time §18 or the corpus changes. And
// the guard is a repo-level `node --test` rather than a vitest in `packages/discovery/testing`
// (#3557's first-named home) because one of its two inputs, the design document, lives
// outside that package: the cross-tree read belongs beside the §12 audit-table guard, in the
// `architecture` job that already runs the record-discovery guards with no install.

const root = resolve(import.meta.dirname, '../..');
const specPath = join(root, 'docs', 'superpowers', 'specs', '2026-07-27-record-discovery-protocol-design.md');
const fixturesRoot = join(root, 'packages', 'discovery', 'testing', 'fixtures');
const vectorsRoot = join(fixturesRoot, 'vectors');

/**
 * §18's claims, in document order, each with the vectors that discharge it. `claim` is the
 * verbatim §18 fragment; assertion A compares these against the document.
 *
 * @type {readonly {label: string, claim: string, vectors: readonly string[]}[]}
 */
const COVERAGE = [
  // --- Golden vectors ---
  { label: 'Golden vectors', claim: 'valid chains', vectors: ['valid-chain'] },
  {
    label: 'Golden vectors',
    claim: 'forked chains (including fork-at-shared-`previous`)',
    vectors: ['forked-chain-shared-previous', 'forked-chain-second-signed-child'],
  },
  { label: 'Golden vectors', claim: 'broken linkage', vectors: ['broken-linkage-previous-mismatch'] },
  {
    label: 'Golden vectors',
    claim: 'sequence gaps and duplicates (must reject)',
    vectors: ['sequence-gap', 'sequence-duplicate'],
  },
  {
    label: 'Golden vectors',
    claim: 'duplicate `announcementId` (must reject)',
    vectors: ['duplicate-announcement-id-across-entries'],
  },
  { label: 'Golden vectors', claim: 'stale heads', vectors: ['stale-head'] },
  { label: 'Golden vectors', claim: 'rolled-back heads', vectors: ['rolled-back-head'] },
  { label: 'Golden vectors', claim: '`issuedAt` regressions', vectors: ['issued-at-regression-v2'] },
  {
    label: 'Golden vectors',
    claim:
      "a head issued further ahead of the verifier's clock than one profile window (must reject `head-issued-ahead`, §5.2 rule 3, and persist no high-water mark), a head whose window is inverted (must reject `refresh-by-ceiling`, §5.2 rule 1) and a head whose window exceeds the profile ceiling (must also reject `refresh-by-ceiling`, §5.2 rule 2)",
    vectors: ['head-issued-ahead', 'refresh-by-ceiling-inverted-window', 'refresh-by-ceiling-exceeds-window'],
  },
  {
    label: 'Golden vectors',
    claim: 'a competing head signed by a rotated-out key (must reject)',
    vectors: ['competing-head-rotated-out-key'],
  },
  { label: 'Golden vectors', claim: 'entries with bad facts cards', vectors: ['facts-consistency-inconsistent'] },
  {
    label: 'Golden vectors',
    claim: 'facts requiring unavailable referenced bytes (must yield `indeterminate` and fail closed at decision grade)',
    vectors: ['facts-consistency-indeterminate-unavailable-referenced-bytes'],
  },
  {
    label: 'Golden vectors',
    claim: 'genesis edge cases (pinned first sequence, `previous: null` uniqueness)',
    vectors: ['genesis-pinned-sequence', 'duplicate-genesis-entries', 'non-genesis-previous-null'],
  },
  {
    label: 'Golden vectors',
    claim: 'withdrawal of foreign announcements, withdrawal-of-withdrawal, and missing reason codes (all must reject)',
    vectors: ['withdrawal-of-foreign-announcement', 'withdrawal-of-withdrawal', 'missing-withdrawal-reason'],
  },
  {
    label: 'Golden vectors',
    claim: 're-announcement after withdrawal (must accept)',
    vectors: ['re-announce-after-withdrawal'],
  },
  {
    label: 'Golden vectors',
    claim: 'unknown kinds and unknown fields (must skip, not error)',
    vectors: ['unknown-record-kind-skip', 'unknown-facts-field-skip'],
  },
  {
    label: 'Golden vectors',
    claim: 'oversized entries and pages (must reject under the published-source profile, `broken-chain` onward)',
    vectors: ['oversized-entry', 'oversized-archive-page'],
  },
  {
    label: 'Golden vectors',
    claim: 'an envelope signed under the wrong trust-layer scope (must fail `unauthorized-signer`)',
    vectors: ['wrong-signing-scope'],
  },
  {
    label: 'Golden vectors',
    claim: 'substrate facts in an author-source announcement (must reject)',
    vectors: ['substrate-fact-in-author-source'],
  },

  // --- Source conformance ---
  {
    label: 'Source conformance',
    claim: 'published (signed) and unpublished profiles',
    vectors: ['source-conformance-published-profile', 'source-conformance-unpublished-profile'],
  },
  {
    label: 'Source conformance',
    claim: 'correction-by-append with `reorged` reasons',
    vectors: ['source-conformance-correction-by-append-reorged'],
  },
  {
    label: 'Source conformance',
    claim: 'head freshness and `issuedAt` monotonicity maintenance',
    vectors: ['source-conformance-freshness-maintenance'],
  },
  {
    label: 'Source conformance',
    claim: '`refreshBy` within profile bounds',
    vectors: ['source-conformance-refreshby-bound'],
  },

  // --- Query-plane conformance ---
  {
    label: 'Query-plane conformance',
    claim: 'provenance on every item',
    vectors: ['query-provenance-present-on-every-item'],
  },
  {
    label: 'Query-plane conformance',
    claim: 'fabricated-provenance detection via §10.4 step 3',
    vectors: ['query-fabricated-provenance'],
  },
  {
    label: 'Query-plane conformance',
    claim: '`complete` honesty (empty-vs-truncated)',
    vectors: ['query-complete-honesty'],
  },
  {
    label: 'Query-plane conformance',
    claim: 'cursor determinism with digest tie-break',
    vectors: ['query-cursor-determinism-digest-tiebreak'],
  },
  { label: 'Query-plane conformance', claim: 'no origination', vectors: ['query-service-originates-rejected'] },

  // --- Subscribe conformance ---
  {
    label: 'Subscribe conformance',
    claim: 'the five cursor cases',
    vectors: [
      'subscribe-cursor-no-cursor',
      'subscribe-cursor-oldest',
      'subscribe-cursor-within-window',
      'subscribe-cursor-older-than-window',
      'subscribe-cursor-unknown-or-future',
    ],
  },
  {
    label: 'Subscribe conformance',
    claim: 'declared replay window',
    vectors: ['subscribe-declared-replay-window'],
  },
  {
    label: 'Subscribe conformance',
    claim: 'relay-local cursor declaration',
    vectors: ['subscribe-relay-local-cursor-declaration'],
  },
  {
    label: 'Subscribe conformance',
    claim: 'announcement dedupe key',
    vectors: ['subscribe-announcement-dedupe-key'],
  },
  {
    label: 'Subscribe conformance',
    claim: 'observation pass-through without alteration',
    vectors: ['subscribe-observation-passthrough-unaltered'],
  },
  {
    label: 'Subscribe conformance',
    claim: 'the per-item-drop censoring relay (must be caught by the entry-granular spot-check)',
    vectors: ['subscribe-per-item-drop-censoring-relay'],
  },

  // --- Consumer conformance ---
  {
    label: 'Consumer conformance',
    claim: "ping-flood debounce (pull rate stays at the consumer's configured ceiling)",
    vectors: ['consumer-ping-flood-debounce'],
  },
  {
    label: 'Consumer conformance',
    claim: 'hostile-locator guards (oversize, wrong content type, private-address)',
    vectors: [
      'consumer-hostile-locator-oversize',
      'consumer-hostile-locator-wrong-content-type',
      'consumer-hostile-locator-private-address',
    ],
  },
  {
    label: 'Consumer conformance',
    claim:
      'well-known archive-root containment (§7 item 3: a contained root accepted; a cross-origin root and a path-escaping root both refused)',
    vectors: [
      'consumer-archive-root-inside-serving-root',
      'consumer-archive-root-outside-serving-root',
      'consumer-archive-root-escaping-serving-root',
    ],
  },
  {
    label: 'Consumer conformance',
    claim: 'head-vs-delivered relay divergence (must downgrade the relay)',
    vectors: ['consumer-head-vs-delivered-divergence'],
  },
  {
    label: 'Consumer conformance',
    claim: 'cold-start mirror disagreement (must take the highest valid `(sequence, issuedAt)`)',
    vectors: ['consumer-cold-start-mirror-disagreement'],
  },
  {
    label: 'Consumer conformance',
    claim: 'withdrawal of a retrospective-kind item (must not prune the decision store)',
    vectors: ['consumer-withdrawal-retrospective-no-prune'],
  },
  {
    label: 'Consumer conformance',
    claim: '`reorged` withdrawal (must trigger recompute)',
    vectors: ['consumer-reorged-withdrawal-recompute'],
  },

  // --- Named checks in isolation ---
  {
    label: 'Named checks in isolation',
    claim:
      '`source-chain-verification` outcomes (`stale`, `forked`, `broken-chain` (including `at: refresh-by-ceiling` and `at: head-issued-ahead`), `unauthorized-signer`), each exercised both from first adoption and against a seeded high-water mark, so the kit proves the *preserve* half of §10.3 step 7 — a refused head leaves a stored mark neither advanced nor cleared — across all four typed failures',
    // The seeded half of each typed failure: `stale`, `unauthorized-signer`, and `forked`
    // by the three `*-seeded-mark` vectors; `broken-chain` by `rolled-back-head`
    // (`at: linkage`) and `issued-at-regression-v2` (`at: issued-at-monotonicity`), which
    // are seeded (`firstAdoption: false` with a stored `hwm`) by construction. The harness
    // (`conformance.ts`) asserts mark preservation on every non-`ok` vector, so each of
    // these discharges the preserve half as well as the refusal.
    vectors: [
      'stale-head',
      'stale-head-seeded-mark',
      'forked-chain-shared-previous',
      'forked-chain-second-signed-child',
      'forked-chain-seeded-mark',
      'refresh-by-ceiling-inverted-window',
      'head-issued-ahead',
      'rolled-back-head',
      'issued-at-regression-v2',
      'wrong-signing-scope',
      'wrong-signing-scope-seeded-mark',
      'competing-head-rotated-out-key',
    ],
  },
  {
    label: 'Named checks in isolation',
    claim:
      "`source-head-revalidation` outcomes (`ok` for a byte-identical head, `stale`, `refresh-by-ceiling`, `head-issued-ahead`, `unauthorized-signer` both for a key that rotated out before the head was issued and for one that rotated out after, `head-origin-mismatch` for a head naming a source other than the one followed, `head-payload-mismatch`, and `invalid-head-envelope`), each exercised with the procedure handed the followed source's seeded high-water mark store, so the kit proves §10.5's *adopts nothing* property — a revalidated head leaves the stored mark unchanged, whatever the outcome",
    // Every `source-head` vector seeds the followed source's mark, and the harness
    // (`checkSourceHeadVector`) passes that same store to the procedure under test and asserts
    // the stored mark is unchanged after every call, `ok` included, so each vector discharges
    // the adopts-nothing half as well as its outcome. `source-head-conformance.test.ts` shows
    // the check failing for a procedure that writes the store.
    vectors: [
      'source-head-revalidation-identical-head-ok',
      'source-head-revalidation-stale',
      'source-head-revalidation-refresh-by-ceiling',
      'source-head-revalidation-head-issued-ahead',
      'source-head-revalidation-unauthorized-signer',
      'source-head-revalidation-signer-rotated-since-issue',
      'source-head-revalidation-head-origin-mismatch',
      'source-head-revalidation-head-payload-mismatch',
      'source-head-revalidation-invalid-head-envelope',
    ],
  },
  {
    label: 'Named checks in isolation',
    claim: '`facts-consistency` (all three outcomes), `derivation-consistency` (present, fabricated, reorged-away)',
    vectors: [
      'facts-consistency-consistent',
      'facts-consistency-inconsistent',
      'facts-consistency-indeterminate-unavailable-referenced-bytes',
      'derivation-consistency-present',
      'derivation-consistency-fabricated',
      'derivation-consistency-reorged-away',
    ],
  },
  {
    label: 'Named checks in isolation',
    claim:
      'item verification outcomes (`content-corruption`; `unauthorized-provenance`, both the never-synced entry and the entry that does not announce this item; and `verified`)',
    vectors: [
      'item-content-corruption',
      'item-unauthorized-provenance',
      'item-lying-entry-provenance',
      'item-verified-consistent',
    ],
  },
];

/**
 * Splits on `"; "` at parenthesis depth zero and outside code spans. Depth-awareness is
 * load-bearing, not decorative: two §18 claims carry a parenthetical that contains a
 * semicolon of its own, and a flat split cuts one of them into three. Code spans are
 * opaque for the same reason — a backticked `; ` is text, not a separator — and a
 * parenthesis inside one is text too, so it moves no depth.
 */
function splitClaims(body) {
  const claims = [];
  let depth = 0;
  let inCode = false;
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '`') inCode = !inCode;
    else if (!inCode && character === '(') depth += 1;
    else if (!inCode && character === ')') depth -= 1;
    if (character === ';' && !inCode && depth === 0 && body[index + 1] === ' ') {
      claims.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += character;
  }
  claims.push(current.trim());
  return claims.filter((claim) => claim !== '');
}

/** §18's claim partition, re-derived from the document. */
export function deriveConformanceClaims(markdown = readFileSync(specPath, 'utf8')) {
  const start = markdown.indexOf('\n## 18. Conformance');
  assert.notEqual(start, -1, 'the design document has no "## 18. Conformance" section.');
  const end = markdown.indexOf('\n## 19.', start);
  assert.notEqual(end, -1, 'the design document has no "## 19." section closing §18.');

  // Unwrap soft line breaks into the bullet they continue. A blank line ends the bullet, so
  // a paragraph after §18's last bullet is not read as part of its last claim.
  const bullets = [];
  let continuing = false;
  for (const raw of markdown.slice(start, end).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
      continuing = true;
    } else if (line === '') continuing = false;
    else if (continuing) bullets[bullets.length - 1] += ` ${line}`;
  }
  assert.ok(bullets.length > 0, '§18 has no bullets.');

  const derived = [];
  for (const bullet of bullets) {
    const match = /^\*\*(.+?):\*\*\s*(.*)$/su.exec(bullet);
    assert.notEqual(
      match,
      null,
      `§18 bullet is not "**Label:** claims" — this guard partitions §18 by that shape, splitting claims on "; " at parenthesis depth zero. Reword the bullet to match, or teach the guard the new shape. Offending bullet: ${bullet.slice(0, 120)}`,
    );
    const body = match[2].trim().replace(/\.$/u, '');
    for (const claim of splitClaims(body)) derived.push({ label: match[1], claim });
  }
  return derived;
}

/**
 * Vector directory names the fixture manifest records as superseded. Published fixtures are
 * append-only — a wrong one is retained unedited and replaced by a new fixture plus a dated
 * erratum — so the loaded corpus skips the superseded copy while its bytes stay on disk.
 * `packages/discovery/testing/src/vectors.ts` (`supersededDirectories`) is the definition of
 * record; this re-derives it because a `.github/scripts` guard cannot import the package: the
 * architecture job runs no install, and `vectors.ts` is TypeScript.
 */
function supersededVectors() {
  const manifest = JSON.parse(readFileSync(join(fixturesRoot, 'manifest.sha256.json'), 'utf8'));
  const superseded = new Set();
  for (const erratum of manifest.errata ?? []) {
    const match = /^vectors\/([^/]+)\/vector\.json$/u.exec(erratum.id);
    if (match !== null) superseded.add(match[1]);
  }
  return superseded;
}

const derivedClaims = deriveConformanceClaims();
const superseded = supersededVectors();
const corpus = new Set(
  readdirSync(vectorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !superseded.has(entry.name))
    .map((entry) => entry.name),
);

test('A. the coverage map is in step with §18 itself', () => {
  const mapped = COVERAGE.map(({ label, claim }) => ({ label, claim }));
  assert.equal(
    mapped.length,
    derivedClaims.length,
    `§18 partitions into ${derivedClaims.length} claims, the coverage map holds ${mapped.length}. Add or remove the map entry that matches the §18 change.`,
  );
  for (const [index, expected] of derivedClaims.entries()) {
    assert.deepEqual(
      mapped[index],
      expected,
      `claim ${index + 1} drift:\n  §18 says: [${expected.label}] ${expected.claim}\n  map says: [${mapped[index].label}] ${mapped[index].claim}`,
    );
  }
});

test('B. every §18 claim names at least one live vector', () => {
  for (const [index, entry] of COVERAGE.entries()) {
    assert.ok(
      entry.vectors.length > 0,
      `claim ${index + 1} ([${entry.label}] ${entry.claim}) names no vector. Every §18 claim must be discharged by at least one golden vector.`,
    );
    for (const name of entry.vectors) {
      if (superseded.has(name)) {
        assert.fail(
          `claim ${index + 1} ([${entry.label}] ${entry.claim}) cites superseded vector "${name}". The fixture manifest's erratum retracted the statement it made; cite its replacement.`,
        );
      }
      assert.ok(
        corpus.has(name),
        `claim ${index + 1} ([${entry.label}] ${entry.claim}) cites vector "${name}", which is not in the corpus.`,
      );
    }
  }
});

test('C. every vector in the loaded corpus is named by at least one §18 claim', () => {
  const named = new Set(COVERAGE.flatMap((entry) => entry.vectors));
  for (const name of [...corpus].sort()) {
    assert.ok(
      named.has(name),
      `vector "${name}" is in the corpus but no §18 claim names it. Either add the claim it discharges to §18 and map it here, or say why the corpus carries a vector the conformance list does not require.`,
    );
  }
});

/** A minimal §18 with the given body between its heading and §19. */
function syntheticSpec(body) {
  return `# Spec\n\n## 18. Conformance\n\nIntro.\n\n${body}\n\n## 19. Declared impact\n`;
}

test('§18 derivation: a paragraph after the last bullet is not appended to its last claim', () => {
  const derived = deriveConformanceClaims(
    syntheticSpec('- **Golden vectors:** alpha; beta\n  continued.\n\nA closing paragraph; not a claim.'),
  );
  assert.deepEqual(derived, [
    { label: 'Golden vectors', claim: 'alpha' },
    { label: 'Golden vectors', claim: 'beta continued' },
  ]);
});

test('§18 derivation: "; " inside a code span does not split a claim', () => {
  const derived = deriveConformanceClaims(
    syntheticSpec('- **Named checks:** `a; b` stays whole (and `c)` too); next'),
  );
  assert.deepEqual(derived, [
    { label: 'Named checks', claim: '`a; b` stays whole (and `c)` too)' },
    { label: 'Named checks', claim: 'next' },
  ]);
});
