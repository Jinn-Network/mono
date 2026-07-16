import { describe, expect, it } from 'vitest';
import {
  classifyPayload,
  dedupeKnowledgeHits,
  deriveSearchTerms,
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
    ...overrides,
  };
}

describe('deriveSearchTerms (rescope §3.3)', () => {
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
    const terms = deriveSearchTerms('fix the client/src/store bug in version-status.test.ts');
    expect(terms).toContain('client/src/store');
    expect(terms).toContain('version-status.test.ts');
  });

  it('recognises a digit-bearing token and a camelCase token as identifier-shaped', () => {
    const terms = deriveSearchTerms('upgrade to es6 and rework sessionBridge please');
    expect(terms).toContain('es6');
    expect(terms).toContain('sessionbridge');
  });

  it('includes the repository slug when provided, lowercased', () => {
    const terms = deriveSearchTerms('generic unrelated words here', 'Jinn-Network/mono');
    expect(terms).toContain('jinn-network/mono');
  });

  it('falls back to the longest remaining non-stopword tokens (>=4 chars)', () => {
    const terms = deriveSearchTerms('please help with the retry budget for tests');
    // 'please' and 'help' and 'the' and 'with' and 'for' are stopwords; longest remainder first.
    expect(terms).toEqual(['budget', 'retry', 'tests']);
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

  it('caps at 6 terms', () => {
    const terms = deriveSearchTerms('`one` `two` `three` `four` `five` `six` `seven` `eight`');
    expect(terms).toHaveLength(6);
  });

  it('returns an empty list for blank or all-stopword input', () => {
    expect(deriveSearchTerms('')).toEqual([]);
    expect(deriveSearchTerms('how do you help me please')).toEqual([]);
  });

  it('keeps Unicode alnum chars in identifier-shaped tokens', () => {
    const terms = deriveSearchTerms('café-menu needs a refactor');
    expect(terms).toContain('café-menu');
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

  it('counts a repository-slug match as 2', () => {
    const h = hit({ snippet: 'fix a bug', tags: ['jinn-network/mono'] });
    expect(scoreKnowledgeHit(h, ['jinn-network/mono'], 'Jinn-Network/mono')).toBe(2);
  });

  it('is case-insensitive', () => {
    const h = hit({ snippet: 'Fix The Dashboard Flake', tags: [] });
    expect(scoreKnowledgeHit(h, ['dashboard'])).toBe(1);
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
