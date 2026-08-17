import { describe, expect, it } from 'vitest';
import {
  classifyPayload,
  dedupeKnowledgeHits,
  deriveRepositorySearchTerms,
  deriveSearchTerms,
  discriminatingTerms,
  rankKnowledgeHits,
  scoreKnowledgeHit,
  selectKnowledgeHits,
  MAX_SELECTED_PACKETS,
} from '../src/pickup.js';
import type { KnowledgeHit } from '../src/schemas/knowledge-hit.js';

function hit(overrides: Partial<KnowledgeHit> = {}): KnowledgeHit {
  return {
    ref: 'bafyEvidence1',
    kind: 'trace',
    tags: [],
    // Default true so pre-#1824 selection/ranking scenarios keep exercising
    // their own concern; the retrieval-visibility allowlist block below sets
    // it explicitly per case.
    retrievalVisible: true,
    ...overrides,
  };
}

describe('deriveSearchTerms (rescope §3.3)', () => {
  it('shares the canonical repository-vocabulary query with non-session consumers', () => {
    expect(deriveRepositorySearchTerms('Jinn-Network/mono')).toEqual(['mono']);
    expect(deriveSearchTerms('', 'Jinn-Network/mono')).toEqual(
      deriveRepositorySearchTerms('Jinn-Network/mono'),
    );
  });

  it('prioritises backticked/quoted tokens over plain words', () => {
    const terms = deriveSearchTerms('please fix `useWidgetState` in the dashboard');
    expect(terms[0]).toBe('usewidgetstate');
  });

  it('extracts double- and single-quoted spans too', () => {
    const terms = deriveSearchTerms(`investigate "version status" and 'async flake'`);
    expect(terms).toContain('version status');
    expect(terms).toContain('async flake');
  });

  it('prioritises identifier-shaped tokens (underscore/dash/dot/slash/digit/camelCase)', () => {
    const terms = deriveSearchTerms('fix the operator/src/store bug in version-status.test.ts');
    expect(terms).toContain('operator/src/store');
    expect(terms).toContain('version-status.test.ts');
  });

  it('recognises a digit-bearing token and a camelCase token as identifier-shaped', () => {
    const terms = deriveSearchTerms('upgrade to es6 and rework sessionBridge please');
    expect(terms).toContain('es6');
    expect(terms).toContain('sessionbridge');
  });

  // The full repository slug can never match a record's text (no record
  // carries the literal `owner/repo` string) — the repository's NAME (the
  // segment after the last `/`) replaces it as the derived term (#1790).
  it('derives the repository NAME, not the full slug, when repositorySlug is provided', () => {
    const terms = deriveSearchTerms('generic unrelated words here', 'Jinn-Network/mono');
    expect(terms).toContain('mono');
    expect(terms).not.toContain('jinn-network/mono');
  });

  it('does not derive a repo-name term shorter than 3 chars', () => {
    const terms = deriveSearchTerms('generic unrelated words here', 'acme/ab');
    expect(terms).not.toContain('ab');
  });

  it('uses the whole slug as the repo name when it has no `/`', () => {
    const terms = deriveSearchTerms('generic unrelated words here', 'monorepo');
    expect(terms).toContain('monorepo');
  });

  // #1791: length is not a retrievability signal against a corpus of short
  // summaries and tags — the remainder bucket is message order (order of
  // first appearance), not longest-first.
  it('falls back to the remaining non-stopword tokens (>=4 chars) in message order, not longest-first', () => {
    const terms = deriveSearchTerms('please help with the retry budget for tests');
    // 'please', 'help', 'with', 'for' are stopwords; 'retry' appears before
    // 'budget' in the message even though it is shorter — message order wins
    // (#1791; the old longest-first sort produced ['budget','retry','tests']).
    expect(terms).toEqual(['retry', 'budget', 'tests']);
  });

  it('orders the remainder bucket by first appearance — a short early topical word beats a longer later one (#1791)', () => {
    // Mirrors the real R6 walkthrough finding: 'flaky' (5 chars) lost the old
    // longest-first sort to 'deterministic' (13 chars) and was evicted from
    // the 6-term budget entirely, even though it was the term that would
    // have matched the seeded record.
    const terms = deriveSearchTerms(
      'flaky tests are annoying because the retry logic is not deterministic',
    );
    const flakyIndex = terms.indexOf('flaky');
    const deterministicIndex = terms.indexOf('deterministic');
    expect(flakyIndex).toBeGreaterThanOrEqual(0);
    expect(deterministicIndex).toBeGreaterThan(flakyIndex);
  });

  it('reads the whole message, not just the first line', () => {
    const terms = deriveSearchTerms('hello\nplease fix `retryBudget` on line two');
    expect(terms).toContain('retrybudget');
  });

  it('is deduplicated and deterministic', () => {
    const terms = deriveSearchTerms('retryBudget retryBudget retryBudget');
    expect(terms).toEqual(['retrybudget']);
    expect(deriveSearchTerms('retryBudget retryBudget retryBudget')).toEqual(terms);
  });

  // Budget raised 6 -> 10 (#1791): a tight budget forced real terms out.
  it('caps at 10 terms', () => {
    const terms = deriveSearchTerms(
      '`one` `two` `three` `four` `five` `six` `seven` `eight` `nine` `ten` `eleven` `twelve`',
    );
    expect(terms).toHaveLength(10);
  });

  it('path-segments a `/`-bearing identifier-shaped token, contributing each cleaned segment (>=3 chars) after the full token (#1791)', () => {
    const terms = deriveSearchTerms('fix the flake under operator/src/dashboard/spa/src please');
    expect(terms).toContain('operator/src/dashboard/spa/src');
    expect(terms).toContain('operator');
    expect(terms).toContain('dashboard');
    expect(terms).toContain('spa');
    // 'src' is exactly MIN_PATH_SEGMENT_LENGTH (3 chars) — included, not excluded.
    expect(terms).toContain('src');
  });

  it('does not path-segment a token with no `/`', () => {
    const terms = deriveSearchTerms('fix version-status.test.ts please');
    expect(terms).not.toContain('version');
    expect(terms).not.toContain('status');
  });

  it('returns an empty list for blank or all-stopword input', () => {
    expect(deriveSearchTerms('')).toEqual([]);
    expect(deriveSearchTerms('how do you help me please')).toEqual([]);
  });

  it('keeps Unicode alnum chars in identifier-shaped tokens', () => {
    const terms = deriveSearchTerms('café-menu needs a refactor');
    expect(terms).toContain('café-menu');
  });

  // Term hygiene (mono #1786, found by the R6 live walkthrough): trailing
  // sentence punctuation must not make an ordinary prose word look
  // identifier-shaped and steal a priority-2 slot from real content words.
  describe('term hygiene: leading/trailing separator stripping (#1786)', () => {
    it('strips a trailing period from a sentence-final word instead of treating it as identifier-shaped', () => {
      const terms = deriveSearchTerms('Say OK.');
      expect(terms).not.toContain('ok.');
    });

    // This message is Run A from the #1791 decision comment's validation
    // table (the real #1006 "dashboard USD labels" walkthrough task,
    // re-derived here) — its pre-lexical-v2 derived terms
    // (['ai-units','jinn-network/mono','distinguishes','dashboard',
    // 'estimated','operator']) are recorded verbatim in #1654's R6
    // walkthrough #3 comment. See the 'lexical v2 validation table' describe
    // block below for its post-lexical-v2 scores against the real fixtures.
    it('never derives a punctuation-suffixed term from natural prose ending in periods', () => {
      const message =
        'The operator dashboard still labels the AI-units claim gate in units, ' +
        'even though the daemon now reports actual USD spend with an estimated ' +
        'flag. Update the dashboard so it shows USD and distinguishes a metered ' +
        'figure from an estimated one. Run the dashboard tests when you are done.';

      const terms = deriveSearchTerms(message, 'Jinn-Network/mono');

      expect(terms).toContain('dashboard');
      for (const term of terms) {
        expect(term.endsWith('.')).toBe(false);
      }
    });

    it('strips leading/trailing separators but preserves internal ones on real identifiers', () => {
      const terms = deriveSearchTerms(
        'ship update_available, fix version-status, review operator/src/dashboard, tune AI-units, hit /v1/status.',
      );
      expect(terms).toContain('update_available');
      expect(terms).toContain('version-status');
      expect(terms).toContain('operator/src/dashboard');
      expect(terms).toContain('ai-units');
      // Leading `/` is stripped like any other leading separator (see #1786
      // AC and the pickup.ts docstring for the trade-off this accepts).
      expect(terms).toContain('v1/status');
    });

    it('falls a stripped prose word through to the remainder bucket rather than promoting it to priority 2', () => {
      // 'else.' cleans to 'else', which is not identifier-shaped (no
      // separator survives the strip) — it must only ever appear via the
      // remainder bucket, alongside ordinary prose words, in message order
      // (#1791 — the old longest-first sort produced
      // ['contribution','done','else']).
      const terms = deriveSearchTerms('done. else. contribution');
      expect(terms).toEqual(['done', 'else', 'contribution']);
    });
  });

  // #1789: the captured span bypassed cleanWord, keeping trailing
  // punctuation (`npm test.` never matched a corpus tag or summary).
  describe('quoted/backtick span cleaning (#1789)', () => {
    it('strips trailing punctuation from a backticked span via the same edge strip as other terms', () => {
      const terms = deriveSearchTerms('run `npm test.` now');
      expect(terms).toContain('npm test');
      for (const term of terms) {
        expect(term.endsWith('.')).toBe(false);
      }
    });

    it("preserves a multi-word quoted span's shape (internal space, no split)", () => {
      const terms = deriveSearchTerms('please check `version status fetch` today');
      expect(terms).toContain('version status fetch');
    });

    it('preserves internal separators on a path-shaped backticked span', () => {
      const terms = deriveSearchTerms('look at `operator/src/dashboard` please');
      expect(terms).toContain('operator/src/dashboard');
    });
  });
});

describe('classifyPayload', () => {
  it('reads skill vs unknown', () => {
    expect(classifyPayload({ payloadKind: 'skill', kind: 'skill' })).toBe('skill');
    expect(classifyPayload({ payloadKind: 'unknown', kind: 'trace' })).toBe('unknown');
  });
  it('falls back to kind when payloadKind absent', () => {
    expect(classifyPayload({ kind: 'skill' })).toBe('skill');
    expect(classifyPayload({ kind: 'trace' })).toBe('unknown');
  });
});

describe('scoreKnowledgeHit (rescope §3.3 step 3)', () => {
  it('counts one point per matched term across snippet + tags', () => {
    const h = hit({ snippet: 'fix the dashboard flake', tags: ['vitest', 'async'] });
    expect(scoreKnowledgeHit(h, ['dashboard', 'vitest'])).toBe(2);
  });

  it('does not double count an unmatched term', () => {
    const h = hit({ snippet: 'fix the dashboard flake', tags: [] });
    expect(scoreKnowledgeHit(h, ['dashboard', 'nonexistent'])).toBe(1);
  });

  // The old +2 repository-slug bonus is gone (#1790, #1791): the slug it
  // matched against could never appear in a record's text, so the bonus
  // never actually fired. The repository's NAME is now a normal derived
  // term (see deriveSearchTerms) and counts 1 like everything else.
  it('a repo-name term counts 1 like any other matched term — no special case', () => {
    const h = hit({ snippet: 'fix a bug', tags: ['mono'] });
    expect(scoreKnowledgeHit(h, ['mono'])).toBe(1);
  });

  it('is case-insensitive', () => {
    const h = hit({ snippet: 'Fix The Dashboard Flake', tags: [] });
    expect(scoreKnowledgeHit(h, ['dashboard'])).toBe(1);
  });

  describe('plural fold (#1791 lexical v2)', () => {
    it('folds a plural term to match a singular haystack', () => {
      const h = hit({ snippet: 'the flaky test needs a fix', tags: [] });
      expect(scoreKnowledgeHit(h, ['tests'])).toBe(1);
    });

    it('does not fold a term of length <= 3 ending in s ("its" does not fold to "it")', () => {
      const h = hit({ snippet: 'fix it now', tags: [] });
      expect(scoreKnowledgeHit(h, ['its'])).toBe(0);
    });

    it('does not require the fold when the plural already matches verbatim', () => {
      const h = hit({ snippet: 'the flaky tests need a fix', tags: [] });
      expect(scoreKnowledgeHit(h, ['tests'])).toBe(1);
    });
  });

  // #1886: a term used to match anywhere in the haystack, including inside a
  // longer word. The first two cases are the real strings from the 2026-07-20
  // local-corpus walkthrough, where an unrelated pgbouncer question was
  // delivered two dashboard records.
  describe('whole-word matching (#1886)', () => {
    it('does not match a term inside a longer word ("load" in "payload")', () => {
      const h = hit({ snippet: 'add an e2e payload test', tags: [] });
      expect(scoreKnowledgeHit(h, ['load'])).toBe(0);
    });

    it('does not match a term that prefixes a longer word ("under" in "underlying")', () => {
      const h = hit({ snippet: 'anchor waits on the underlying mocks', tags: [] });
      expect(scoreKnowledgeHit(h, ['under'])).toBe(0);
    });

    it('still matches a term bounded by path separators', () => {
      const h = hit({ snippet: 'touches operator/src/dashboard/spa', tags: [] });
      expect(scoreKnowledgeHit(h, ['dashboard'])).toBe(1);
    });

    it('still matches an identifier-shaped term containing underscores', () => {
      const h = hit({ snippet: 'the update_available banner races', tags: [] });
      expect(scoreKnowledgeHit(h, ['update_available'])).toBe(1);
    });

    it('still matches a term at the very start and end of the haystack', () => {
      const h = hit({ snippet: 'dashboard', tags: ['flake'] });
      expect(scoreKnowledgeHit(h, ['dashboard', 'flake'])).toBe(2);
    });

    it('folds a plural only onto a whole-word singular ("sessions" misses "sessionId")', () => {
      const h = hit({ snippet: 'the sessionId is reused', tags: [] });
      expect(scoreKnowledgeHit(h, ['sessions'])).toBe(0);
    });
  });
});

// #1886 root cause 2: the repository name tags every record in an in-repo
// corpus, so it scores 1 against everything and cannot discriminate. It stays
// a SEARCH term (it is what finds repo-relevant records) but leaves the
// scoring vocabulary, so it can no longer help clear RELEVANCE_FLOOR.
describe('discriminatingTerms (#1886)', () => {
  it('drops the repository-name term', () => {
    expect(discriminatingTerms(['mono', 'dashboard', 'flaky'], 'Jinn-Network/mono')).toEqual([
      'dashboard',
      'flaky',
    ]);
  });

  it('is a no-op without a repository slug', () => {
    expect(discriminatingTerms(['mono', 'dashboard'], undefined)).toEqual(['mono', 'dashboard']);
  });

  it('leaves a term that merely contains the repo name', () => {
    expect(discriminatingTerms(['monorepo', 'mono'], 'Jinn-Network/mono')).toEqual(['monorepo']);
  });

  it('a record matching only the repository name scores 0 and is not a candidate', () => {
    const h = hit({ snippet: 'unrelated work', tags: ['mono', 'dashboard'] });
    const terms = discriminatingTerms(['mono'], 'Jinn-Network/mono');
    expect(scoreKnowledgeHit(h, terms)).toBe(0);
  });
});

describe('dedupeKnowledgeHits (rescope §3.3 step 2)', () => {
  it('drops a later hit with the same ref', () => {
    const a = hit({ ref: 'r1', snippet: 'one' });
    const b = hit({ ref: 'r1', snippet: 'different-but-same-ref' });
    expect(dedupeKnowledgeHits([a, b])).toEqual([a]);
  });

  it('drops a later hit with the same (taskSummary, origin) content key even under a different ref', () => {
    const a = hit({ ref: 'r1', snippet: 'Seed import: acme/skills/implement', origin: 'agent-1' });
    const b = hit({ ref: 'r2', snippet: 'Seed import: acme/skills/implement', origin: 'agent-1' });
    expect(dedupeKnowledgeHits([a, b])).toEqual([a]);
  });

  it('keeps hits with the same summary but different origin', () => {
    const a = hit({ ref: 'r1', snippet: 'same summary', origin: 'agent-1' });
    const b = hit({ ref: 'r2', snippet: 'same summary', origin: 'agent-2' });
    expect(dedupeKnowledgeHits([a, b])).toEqual([a, b]);
  });

  it('never collapses distinct hits that both lack a summary and an origin', () => {
    const a = hit({ ref: 'r1' });
    const b = hit({ ref: 'r2' });
    expect(dedupeKnowledgeHits([a, b])).toEqual([a, b]);
  });
});

const REPO = 'Jinn-Network/mono';

describe('selectKnowledgeHits (rescope §3.3)', () => {
  it('never selects a skill-kind hit', () => {
    const skill = hit({
      ref: 'skill-1',
      kind: 'skill',
      snippet: 'dashboard vitest async flake fix',
      tags: ['dashboard', 'vitest', 'async', 'flake'],
    });
    expect(selectKnowledgeHits([skill], ['dashboard', 'vitest', 'async', 'flake'])).toEqual([]);
  });

  it('never selects an evaluator-verified skill hit', () => {
    const verifiedSkill = hit({
      ref: 'skill-evaluator-verified',
      kind: 'skill',
      tier: 'evaluator-verified',
      snippet: 'dashboard vitest async flake fix',
      tags: ['dashboard', 'vitest', 'async', 'flake'],
    });
    expect(selectKnowledgeHits(
      [verifiedSkill],
      ['dashboard', 'vitest', 'async', 'flake'],
    )).toEqual([]);
  });

  it('never selects a hit whose payload classifies as a skill package even when kind says otherwise', () => {
    const skillish = hit({
      ref: 'skill-2',
      kind: 'trace',
      payloadKind: 'skill',
      snippet: 'dashboard vitest async flake fix',
      tags: ['dashboard', 'vitest', 'async', 'flake'],
    });
    expect(selectKnowledgeHits([skillish], ['dashboard', 'vitest', 'async', 'flake'])).toEqual([]);
  });

  it('applies the relevance floor: score < 2 is excluded (honest nothing-found)', () => {
    const weak = hit({ ref: 'weak', snippet: 'dashboard only', tags: [] });
    expect(selectKnowledgeHits([weak], ['dashboard', 'vitest'])).toEqual([]);
  });

  it('selects a hit at or above the relevance floor', () => {
    const strong = hit({ ref: 'strong', snippet: 'dashboard vitest flake', tags: [] });
    expect(selectKnowledgeHits([strong], ['dashboard', 'vitest'])).toEqual([strong]);
  });

  it('ranks score desc, then tier desc, then recency desc, and takes the top 2', () => {
    // Distinct origins: these are four different source episodes that happen
    // to score similarly — not duplicated seeds of one another (that is a
    // separate scenario, covered by the dedup tests above).
    const low = hit({ ref: 'low', snippet: 'dashboard vitest', tier: 'user-accepted', publishedAt: 100, origin: 'op-low' });
    const highTier = hit({ ref: 'high-tier', snippet: 'dashboard vitest flake', tier: 'evaluator-verified', publishedAt: 1, origin: 'op-high-tier' });
    const midTierRecent = hit({ ref: 'mid-recent', snippet: 'dashboard vitest flake', tier: 'tests-passed', publishedAt: 500, origin: 'op-mid-recent' });
    const midTierOld = hit({ ref: 'mid-old', snippet: 'dashboard vitest flake', tier: 'tests-passed', publishedAt: 1, origin: 'op-mid-old' });

    const selected = selectKnowledgeHits(
      [low, midTierOld, highTier, midTierRecent],
      ['dashboard', 'vitest', 'flake'],
    );

    expect(selected.map((h) => h.ref)).toEqual(['high-tier', 'mid-recent']);
    expect(selected).toHaveLength(MAX_SELECTED_PACKETS);
  });

  it('does not compare recency magnitudes from different domains', () => {
    const publicBlock = hit({
      ref: 'a-public-block',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 22_000_000,
      recencyDomain: 'block-number',
      origin: 'public',
    });
    const localWallClock = hit({
      ref: 'z-local-wall-clock',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 1_753_286_400_000,
      recencyDomain: 'unix-ms',
      origin: 'local',
    });

    expect(selectKnowledgeHits(
      [publicBlock, localWallClock],
      ['dashboard', 'vitest', 'flake'],
    ).map((candidate) => candidate.ref)).toEqual([
      publicBlock.ref,
      localWallClock.ref,
    ]);
  });

  it('preserves local-then-public input order for an incomparable mixed-domain tie group', () => {
    const local = hit({
      ref: 'local-episode:z-local',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 10,
      recencyDomain: 'unix-ms',
      origin: 'local',
    });
    const publicFirst = hit({
      ref: 'a-public-first',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 99,
      recencyDomain: 'block-number',
      origin: 'public-first',
    });
    const publicSecond = hit({
      ref: 'b-public-second',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 98,
      recencyDomain: 'block-number',
      origin: 'public-second',
    });

    expect(selectKnowledgeHits(
      [local, publicFirst, publicSecond],
      ['dashboard', 'vitest', 'flake'],
    ).map((candidate) => candidate.ref)).toEqual([
      local.ref,
      publicFirst.ref,
    ]);
  });

  it('still compares recency within one explicit domain', () => {
    const older = hit({
      ref: 'older',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 10,
      recencyDomain: 'block-number',
      origin: 'older',
    });
    const newer = hit({
      ref: 'newer',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 11,
      recencyDomain: 'block-number',
      origin: 'newer',
    });

    expect(selectKnowledgeHits(
      [older, newer],
      ['dashboard', 'vitest', 'flake'],
    ).map((candidate) => candidate.ref)).toEqual([newer.ref, older.ref]);
  });

  it('preserves raw-recency ordering when both legacy hits omit a domain', () => {
    const older = hit({
      ref: 'legacy-older',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 10,
      origin: 'legacy-older',
    });
    const newer = hit({
      ref: 'legacy-newer',
      snippet: 'dashboard vitest flake',
      tier: 'tests-passed',
      publishedAt: 11,
      origin: 'legacy-newer',
    });

    expect(selectKnowledgeHits(
      [older, newer],
      ['dashboard', 'vitest', 'flake'],
    ).map((candidate) => candidate.ref)).toEqual([newer.ref, older.ref]);
  });

  it('dedupes and filters skills before scoring, so a duplicated skill seed never displaces evidence', () => {
    const d1 = hit({ ref: 'implement-dup-1', kind: 'skill', snippet: 'Seed import: acme/skills/implement', origin: 'agent-1', tags: ['implement'] });
    const d2 = hit({ ref: 'implement-dup-2', kind: 'skill', snippet: 'Seed import: acme/skills/implement', origin: 'agent-1', tags: ['implement'] });
    const evidence = hit({ ref: 'evidence-1', snippet: 'dashboard vitest flake fix', tags: ['dashboard', 'vitest'] });
    const selected = selectKnowledgeHits([d1, d2, evidence], ['dashboard', 'vitest', 'implement']);
    expect(selected.map((h) => h.ref)).toEqual(['evidence-1']);
  });

  it('no candidates → empty selection', () => {
    expect(selectKnowledgeHits([], ['anything'])).toEqual([]);
  });
});

// Mono #1782: content-level guards that only run after a candidate's
// content is fetched (skill-payload classification, empty-packet honesty)
// need to promote past a disqualified top candidate to the next-ranked one.
// selectKnowledgeHits alone cannot support that — it is already sliced to
// MAX_SELECTED_PACKETS before any post-fetch guard could run.
describe('rankKnowledgeHits (mono #1782)', () => {
  // Distinct origins: three different source episodes that happen to score
  // similarly — not duplicated seeds of one another (dedup is covered above).
  function threeRankedHits(): [KnowledgeHit, KnowledgeHit, KnowledgeHit] {
    const a = hit({ ref: 'a', snippet: 'dashboard vitest flake', tier: 'evaluator-verified', publishedAt: 3, origin: 'op-a' });
    const b = hit({ ref: 'b', snippet: 'dashboard vitest flake', tier: 'tests-passed', publishedAt: 2, origin: 'op-b' });
    const c = hit({ ref: 'c', snippet: 'dashboard vitest flake', tier: 'user-accepted', publishedAt: 1, origin: 'op-c' });
    return [a, b, c];
  }

  it('returns every above-floor candidate, not sliced to MAX_SELECTED_PACKETS', () => {
    const [a, b, c] = threeRankedHits();
    const terms = ['dashboard', 'vitest', 'flake'];

    const ranked = rankKnowledgeHits([a, b, c], terms);
    expect(ranked.map((h) => h.ref)).toEqual(['a', 'b', 'c']);
    expect(ranked.length).toBeGreaterThan(MAX_SELECTED_PACKETS);
  });

  it('selectKnowledgeHits is exactly the top MAX_SELECTED_PACKETS slice of rankKnowledgeHits', () => {
    const [a, b, c] = threeRankedHits();
    const terms = ['dashboard', 'vitest', 'flake'];

    expect(selectKnowledgeHits([a, b, c], terms)).toEqual(
      rankKnowledgeHits([a, b, c], terms).slice(0, MAX_SELECTED_PACKETS),
    );
  });

  it('still drops skill hits and applies the relevance floor — same filter pipeline as selectKnowledgeHits', () => {
    const skill = hit({ ref: 'skill-1', kind: 'skill', snippet: 'dashboard vitest flake', tags: ['dashboard'] });
    const weak = hit({ ref: 'weak', snippet: 'dashboard only', tags: [] });
    expect(rankKnowledgeHits([skill, weak], ['dashboard', 'vitest'])).toEqual([]);
  });
});

// Issue #1824 (corpus-supply-design §5 W2): pickup is an allowlist — only
// records carrying the retrieval-visibility mark may enter the candidate
// pool. Absence of the field excludes (fail-closed): bulk/legacy records
// never set it at all, and they must never surface.
describe('retrieval-visibility allowlist (#1824)', () => {
  const TERMS = ['dashboard', 'vitest'];

  it('a visible hit with a qualifying score survives ranking', () => {
    const visible = hit({ ref: 'visible', snippet: 'dashboard vitest flake', retrievalVisible: true });
    expect(rankKnowledgeHits([visible], TERMS)).toEqual([visible]);
  });

  it('an explicitly not-visible hit with the same score is excluded', () => {
    const hidden = hit({ ref: 'hidden', snippet: 'dashboard vitest flake', retrievalVisible: false });
    expect(rankKnowledgeHits([hidden], TERMS)).toEqual([]);
  });

  it('a hit with retrievalVisible omitted is excluded — fail-closed (the bulk/legacy case)', () => {
    const legacy = hit({ ref: 'legacy', snippet: 'dashboard vitest flake', retrievalVisible: undefined });
    expect(rankKnowledgeHits([legacy], TERMS)).toEqual([]);
  });

  it('composes with the skill filter: a skill hit stays excluded regardless of retrievalVisible', () => {
    const markedSkill = hit({
      ref: 'marked-skill',
      kind: 'skill',
      snippet: 'dashboard vitest flake',
      retrievalVisible: true,
    });
    const legacyTrace = hit({ ref: 'legacy-trace', snippet: 'dashboard vitest flake', retrievalVisible: undefined });
    expect(rankKnowledgeHits([markedSkill, legacyTrace], TERMS)).toEqual([]);
  });

  it('ordering among visible hits is unchanged by the new filter', () => {
    const low = hit({ ref: 'low', snippet: 'dashboard vitest', tier: 'user-accepted', publishedAt: 100, origin: 'op-low', retrievalVisible: true });
    const highTier = hit({ ref: 'high-tier', snippet: 'dashboard vitest flake', tier: 'evaluator-verified', publishedAt: 1, origin: 'op-high-tier', retrievalVisible: true });
    const midTierRecent = hit({ ref: 'mid-recent', snippet: 'dashboard vitest flake', tier: 'tests-passed', publishedAt: 500, origin: 'op-mid-recent', retrievalVisible: true });

    const ranked = rankKnowledgeHits([low, highTier, midTierRecent], ['dashboard', 'vitest', 'flake']);
    expect(ranked.map((h) => h.ref)).toEqual(['high-tier', 'mid-recent', 'low']);
  });
});

// Rebuilds the five-message x three-record validation table from #1791's
// decision comment as unit tests. Hit shapes mirror the real Stage 1 seed
// fixtures verbatim (packages/layer/fixtures/stage1-seeds/
// *.episode.json): taskSummary -> snippet, tags -> tags — the only two
// fields haystackFor() reads, so this is a faithful proxy for the real
// corpus records without needing the seed-import/IPFS machinery in a unit
// test. repositorySlug is REPO ('Jinn-Network/mono') throughout, matching
// the real corpus's actual repository (the source and operator-claims
// fixtures are both genuinely from Jinn-Network/mono; sympy is not).
describe('lexical v2 validation table (#1791 decision comment)', () => {
  const SOURCE = hit({
    ref: 'source-dashboard-flake',
    snippet:
      'Fix flaky dashboard update_available banner test — assert after the version status fetch resolves',
    tags: ['mono', 'dashboard', 'vitest', 'version-status', 'async', 'flake'],
  });
  const OPERATOR_CLAIMS = hit({
    ref: 'distractor-operator-claims',
    snippet: 'Warn when a joinedSolverNets entry silently skips claim registration',
    tags: ['mono', 'operator', 'claims', 'solvernet'],
  });
  const SYMPY = hit({
    ref: 'distractor-sympy-printing',
    snippet: 'Fix LaTeX printer dropping the separator between multi-part symbol subscripts',
    tags: ['sympy', 'printing', 'latex', 'regression'],
  });
  const ALL_THREE = [SOURCE, OPERATOR_CLAIMS, SYMPY];

  it('Run B (verbatim, #1791): retrieves the on-topic source record; the same-repo distractor scores repo-name-only and is excluded; the other-domain distractor scores 0', () => {
    const message =
      'The dashboard notification tests keep going flaky in CI. Please look at the async waits in ' +
      'the notifications tests under apps/operator-console and make them deterministic, then ' +
      'run that test file.';
    const terms = deriveSearchTerms(message, REPO);

    expect(scoreKnowledgeHit(SOURCE, terms)).toBe(4);
    expect(scoreKnowledgeHit(OPERATOR_CLAIMS, terms)).toBe(1);
    expect(scoreKnowledgeHit(SYMPY, terms)).toBe(0);

    const selected = selectKnowledgeHits(ALL_THREE, terms);
    expect(selected.map((h) => h.ref)).toEqual(['source-dashboard-flake']);
  });

  it('Run A (#1006, dashboard USD labels): both the source and the same-repo distractor clear the floor, and the distractor ranks first — an accepted precision limit', () => {
    // Accepted trade-off (#1791 decision comment): "Run A's lexical
    // collision ('AI-units claim gate' vs 'claim registration') ranks D1
    // above the source. Bag-of-words ceiling; accepted for Stage 1 (provided
    // != helped; attribution visible; 2-packet cap) and pinned in a unit
    // test as documented behavior." This is that pin.
    const message =
      'The operator dashboard still labels the AI-units claim gate in units, ' +
      'even though the daemon now reports actual USD spend with an estimated ' +
      'flag. Update the dashboard so it shows USD and distinguishes a metered ' +
      'figure from an estimated one. Run the dashboard tests when you are done.';
    const terms = deriveSearchTerms(message, REPO);

    expect(scoreKnowledgeHit(SOURCE, terms)).toBe(2);
    expect(scoreKnowledgeHit(OPERATOR_CLAIMS, terms)).toBe(3);
    expect(scoreKnowledgeHit(SYMPY, terms)).toBe(0);

    const selected = selectKnowledgeHits(ALL_THREE, terms);
    expect(selected.map((h) => h.ref)).toEqual([
      'distractor-operator-claims',
      'source-dashboard-flake',
    ]);
  });

  it("the gate's no-result message (verbatim, apps/jinn-agent/scripts/stage1-stock-product.py): scores below the floor against every fixture — honest nothing-found", () => {
    const message =
      'Investigate why the OLAS staking reward-claim loop occasionally ' +
      'double-counts checkpoint epochs on Base Sepolia.';
    const terms = deriveSearchTerms(message, REPO);

    expect(scoreKnowledgeHit(SOURCE, terms)).toBe(1);
    expect(scoreKnowledgeHit(OPERATOR_CLAIMS, terms)).toBe(1);
    expect(scoreKnowledgeHit(SYMPY, terms)).toBe(0);
    expect(selectKnowledgeHits(ALL_THREE, terms)).toEqual([]);
  });

  it('an unrelated same-repo message with zero content overlap does not clear the floor on the repo-name term alone (#1791 AC, #1790)', () => {
    const message = 'Draft the quarterly OKR review deck for the leadership meeting next week.';
    const terms = deriveSearchTerms(message, REPO);

    // Only the repo-name term ('mono') can possibly match either mono-repo
    // fixture; content overlap is zero by construction. One point is below
    // RELEVANCE_FLOOR (2), so nothing is selected — the honest outcome
    // #1791's AC requires: "A same-repo record with zero content overlap
    // does not clear the floor."
    expect(scoreKnowledgeHit(SOURCE, terms)).toBe(1);
    expect(scoreKnowledgeHit(OPERATOR_CLAIMS, terms)).toBe(1);
    expect(scoreKnowledgeHit(SYMPY, terms)).toBe(0);
    expect(selectKnowledgeHits(ALL_THREE, terms)).toEqual([]);
  });
});
