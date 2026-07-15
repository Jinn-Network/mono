import { describe, expect, it } from 'vitest';
import {
  deriveTerms,
  tierAtLeast,
  classifyPayload,
  decidePickup,
  type PickupCandidate,
} from '../src/pickup.js';
import { DEFAULT_PICKUP_CONFIG, parsePickupConfig } from '../src/schemas/pickup-config.js';

const REF = 'bafyPickupSkill';

// Parity factory — mirrors trace()/CorpusRunner in test_jinn_pickup.py: one
// candidate, tier + payloadKind driven by args, slug 'tdd'.
function candidate(
  tier = 'user-accepted',
  payloadKind: 'skill' | 'unknown' = 'skill',
  slug = 'tdd',
): PickupCandidate {
  return { ref: REF, slug, tier, payloadKind, summary: `Seed import: acme/skills/${slug}` };
}

describe('deriveTerms (ports derive_terms)', () => {
  it('skips stopwords and keeps distinctive first-line words', () => {
    // Ports test_derive_terms_skips_stopwords
    expect(deriveTerms('Help me with tdd-style refactoring')[0]).toBe('tdd-style');
    expect(deriveTerms('')).toEqual([]);
  });

  it('caps at max 2 terms, min length 4, first line only, deduped', () => {
    const terms = deriveTerms('deploy deploy kubernetes cluster now\nsecond line ignored');
    expect(terms).toEqual(['deploy', 'kubernetes']); // 'now' < 4 dropped, dedup, cap 2, line 1 only
  });

  it('keeps Unicode alnum chars (Python str.isalnum parity, AC1)', () => {
    // ASCII-only /[a-z0-9]/ would strip the accent → 'caf' (< 4, dropped).
    // \p{L}\p{N} keeps 'café' as a 4-char distinctive term.
    expect(deriveTerms('café refactor')).toEqual(['café', 'refactor']);
  });
});

describe('tierAtLeast (ports tier_at_least)', () => {
  it('orders weakest→strongest and rejects unknown tiers', () => {
    expect(tierAtLeast('evaluator-verified', 'tests-passed')).toBe(true);
    expect(tierAtLeast('user-accepted', 'evaluator-verified')).toBe(false);
    expect(tierAtLeast('bogus', 'user-accepted')).toBe(false); // unknown never adopts
  });
});

describe('classifyPayload (ports classify_payload)', () => {
  it('reads skill vs unknown', () => {
    expect(classifyPayload({ payloadKind: 'skill', kind: 'skill' })).toBe('skill');
    expect(classifyPayload({ payloadKind: 'unknown', kind: 'trace' })).toBe('unknown');
  });
  it('falls back to kind when payloadKind absent', () => {
    expect(classifyPayload({ kind: 'skill' })).toBe('skill');
    expect(classifyPayload({ kind: 'trace' })).toBe('unknown');
  });
});

describe('decidePickup (ports _pickup_inner decision logic)', () => {
  it('verified candidate is SUGGESTED not adopted by default', () => {
    // Ports test_verified_candidate_is_suggested_not_adopted_by_default
    const d = decidePickup([candidate('evaluator-verified')], new Set(), DEFAULT_PICKUP_CONFIG);
    expect(d.adopted).toHaveLength(0);
    expect(d.suggested).toHaveLength(1);
    expect(d.contextBlock).toContain('install: /jinn skills install');
    expect(d.contextBlock).not.toContain('Adopted automatically');
  });

  it('opt-in auto-adopts an evaluator-verified skill', () => {
    // Ports test_opt_in_auto_adopts
    const cfg = parsePickupConfig({ autoAdopt: true });
    const d = decidePickup([candidate('evaluator-verified')], new Set(), cfg);
    expect(d.adopted.map((c) => c.slug)).toEqual(['tdd']);
    expect(d.contextBlock).toContain('Adopted automatically (verified)');
  });

  it('unverified payload suggests but never adopts', () => {
    // Ports test_unverified_payload_suggests_but_never_installs
    const d = decidePickup([candidate('user-accepted')], new Set(), DEFAULT_PICKUP_CONFIG);
    expect(d.adopted).toHaveLength(0);
    expect(d.contextBlock).toContain('unverified');
    expect(d.contextBlock).toContain('/jinn skills install');
  });

  it('tests-passed respects the configured threshold', () => {
    // Ports test_tests_passed_tier_respects_configured_threshold
    const dflt = decidePickup([candidate('tests-passed')], new Set(), parsePickupConfig({ autoAdopt: true }));
    expect(dflt.adopted).toHaveLength(0); // default threshold evaluator-verified
    const lowered = decidePickup(
      [candidate('tests-passed')],
      new Set(),
      parsePickupConfig({ autoAdopt: true, autoAdoptTier: 'tests-passed' }),
    );
    expect(lowered.adopted).toHaveLength(1);
  });

  it('unknown payload type is never adopted, only mentioned when verified', () => {
    // Ports test_unknown_payload_type_is_never_adopted
    const cfg = parsePickupConfig({ autoAdopt: true });
    const d = decidePickup([candidate('evaluator-verified', 'unknown')], new Set(), cfg);
    expect(d.adopted).toHaveLength(0);
    expect(d.contextBlock).toContain('unknown');
    expect(d.contextBlock).toContain(REF);
    expect(d.contextBlock).not.toContain('Adopted automatically');
  });

  it('already-installed skill is skipped', () => {
    // Ports test_already_installed_skill_is_skipped
    const cfg = parsePickupConfig({ autoAdopt: true });
    const d = decidePickup([candidate('evaluator-verified')], new Set(['tdd']), cfg);
    expect(d.adopted).toHaveLength(0);
    expect(d.suggested).toHaveLength(0);
    expect(d.contextBlock).toBeUndefined(); // nothing new to say
  });

  it('no candidates → no block', () => {
    const d = decidePickup([], new Set(), DEFAULT_PICKUP_CONFIG);
    expect(d.contextBlock).toBeUndefined();
  });
});
