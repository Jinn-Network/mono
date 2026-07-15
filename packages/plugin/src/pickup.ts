/** Pure pickup policy — port of apps/jinn-agent/plugins/jinn/pickup.py
 *  decision logic. No I/O: term derivation + adopt/suggest classification
 *  only. Orchestration (search/get over ports) lives in plugin.ts. */
import type { KnowledgeHit } from './schemas/knowledge-hit.js';
import { TIER_ORDER, type PickupConfig, type Tier } from './schemas/pickup-config.js';

// Ported verbatim from _STOPWORDS.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'into', 'onto',
  'this', 'that', 'these', 'those', 'from', 'then', 'than', 'when',
  'what', 'which', 'where', 'how', 'why', 'can', 'could', 'should',
  'would', 'will', 'just', 'please', 'help', 'need', 'want', 'make',
  'using', 'about', 'have', 'has', 'had', 'you', 'your', 'our', 'not',
]);

/** Naive v0 distribution guess: distinctive words from the FIRST LINE only,
 *  alnum + '-'/'_', min length 4, drop stopwords, dedupe, cap at maxTerms.
 *  Alnum is Unicode-aware (\p{L}\p{N}) to match Python's str.isalnum() (AC1). */
export function deriveTerms(userMessage: string, maxTerms = 2): string[] {
  const firstLine = (userMessage ?? '').trim().split(/\r?\n/)[0] ?? '';
  const terms: string[] = [];
  for (const rawWord of firstLine.toLowerCase().split(/\s+/)) {
    const word = [...rawWord].filter((c) => /[\p{L}\p{N}]/u.test(c) || c === '-' || c === '_').join('');
    if (word.length >= 4 && !STOPWORDS.has(word) && !terms.includes(word)) {
      terms.push(word);
    }
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

/** Ports tier_at_least — unknown tier never satisfies the threshold. */
export function tierAtLeast(tier: string, threshold: Tier): boolean {
  const ti = (TIER_ORDER as readonly string[]).indexOf(tier);
  const thi = (TIER_ORDER as readonly string[]).indexOf(threshold);
  if (ti < 0 || thi < 0) return false;
  return ti >= thi;
}

/** Ports classify_payload — 'skill' or 'unknown'. Prefers the explicit
 *  payloadKind classification field; falls back to hit.kind === 'skill'. */
export function classifyPayload(hit: Pick<KnowledgeHit, 'payloadKind' | 'kind'>): 'skill' | 'unknown' {
  if (hit.payloadKind === 'skill') return 'skill';
  if (hit.payloadKind === 'unknown') return 'unknown';
  return hit.kind === 'skill' ? 'skill' : 'unknown';
}

export interface PickupCandidate {
  ref: string;
  slug: string;
  tier: string;
  summary: string;
  payloadKind: 'skill' | 'unknown';
}

/** Project a fetched corpus hit into a classified pickup candidate. Owns the
 *  slug/summary derivation and routes payloadKind through classifyPayload. */
export function hitToCandidate(hit: KnowledgeHit): PickupCandidate {
  return {
    ref: hit.ref,
    slug: hit.title ?? hit.ref.split('/').pop() ?? hit.ref,
    tier: hit.tier ?? '',
    summary: hit.snippet ?? hit.title ?? hit.ref,
    payloadKind: classifyPayload(hit),
  };
}

export interface PickupDecision {
  adopted: PickupCandidate[];
  suggested: PickupCandidate[];
  contextBlock?: string;
}

/** Ports the adopt/suggest branch of _pickup_inner. Pure: candidates are
 *  already fetched + classified; installed slugs are already known. */
export function decidePickup(
  candidates: PickupCandidate[],
  installed: Set<string>,
  config: PickupConfig,
): PickupDecision {
  const adopted: PickupCandidate[] = [];
  const suggested: PickupCandidate[] = [];
  const threshold = config.autoAdoptTier;

  for (const cand of candidates.slice(0, config.maxCandidates)) {
    if (cand.payloadKind === 'skill') {
      if (installed.has(cand.slug)) continue;
      if (config.autoAdopt && tierAtLeast(cand.tier, threshold)) {
        adopted.push(cand);
        continue;
      }
      suggested.push(cand);
    } else {
      // Unknown payload types are never adopted; mention verified ones only.
      if (tierAtLeast(cand.tier, threshold)) suggested.push(cand);
    }
  }

  if (adopted.length === 0 && suggested.length === 0) {
    return { adopted, suggested, contextBlock: undefined };
  }

  const lines = ['[jinn corpus] Relevant to this task:'];
  if (adopted.length > 0) {
    lines.push('Adopted automatically (verified):');
    for (const c of adopted) lines.push(`- ${c.slug} (${c.tier}): installed skill`);
  }
  if (suggested.length > 0) {
    lines.push(
      'Available in the corpus (unverified — read with the corpus tools, or the user can install):',
    );
    for (const c of suggested) {
      lines.push(
        c.payloadKind === 'skill'
          ? `- ${c.slug} (tier: ${c.tier}) — ${c.summary}\n  ref: ${c.ref} · install: /jinn skills install ${c.ref}`
          : `- (${c.payloadKind}, ${c.tier}) ${c.summary} — ref: ${c.ref}`,
      );
    }
  }
  return { adopted, suggested, contextBlock: lines.join('\n') };
}
