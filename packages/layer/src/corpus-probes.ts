/**
 * Layer-side corpus doctor probes — the single shared implementation of the
 * two "does the operator have corpus" checks the doctor renders.
 *
 * Two checks come out of one search against the corpus consume path:
 *   - `corpus-reachable` — is the corpus read path answering at all?
 *   - `corpus-content`   — did the repo-slug query find enough evidence that
 *                         interactive pickup can actually serve?
 *
 * Both are shared so the Python doctor (plugin/frozen/doctor.py)
 * and the layer CLI (`jinn-layer corpus probe`) render identical semantics.
 *
 * The content check deliberately mirrors pickup's two-layer, fail-closed
 * retrieval allowlist (#1824): the search hit must carry the canonical mark,
 * then the fetched trace content must carry it too. Unmarked substrate and
 * skills never satisfy onboarding, even though they remain valid corpus data.
 */

import { deriveRepositorySearchTerms, hasRetrievalMark } from '@jinn-network/plugin';
import { createCorpusAdapter } from './adapters/corpus-adapter.js';
import type { HarnessLayer, CorpusSearchHit } from './consume.js';

/**
 * How many matching corpus records a repo needs before Jinn considers itself
 * "onboarded" for that repo. B's "enough corpus" guarantee — the sole source of
 * truth for the K threshold, consumed by both `enoughCorpusForRepo` and the
 * `corpus-content.ok` field below.
 */
export const CORPUS_ONBOARDING_K = 3;

/**
 * The consume path has no pagination cursor. Ask for a page comfortably wider
 * than K so unmarked substrate at the front cannot hide the curated records
 * behind it. The doctor is a full/manual check, not a session-start hot path.
 */
const CORPUS_PROBE_CANDIDATE_LIMIT = 50;

/**
 * One doctor check result. Mirrors the Python doctor contract in
 * plugin/frozen/doctor.py: a plain `{name, ok, detail}` dict with
 * `remedy` present exactly when `ok` is false — EXCEPT informational checks,
 * which never carry a remedy even when `ok` is false (there is nothing for the
 * operator to fix, so there is no copy-paste command to offer). `corpus-content`
 * is such an informational check.
 */
export type DoctorCheck = { name: string; ok: boolean; detail: string; remedy?: string };

/**
 * B's "enough corpus" guarantee: a repo has enough corpus when at least `k`
 * retrieval-visible matching records survived both of pickup's visibility
 * guards. The single source of truth for the K threshold —
 * `corpusProbes`' `corpus-content.ok` MUST call this over the same admitted hits
 * so the threshold cannot drift between the two.
 */
export function enoughCorpusForRepo(hits: CorpusSearchHit[], k = CORPUS_ONBOARDING_K): boolean {
  return hits.length >= k;
}

/**
 * Run the two corpus doctor probes off one corpus search plus bounded fetches
 * for search-marked candidates.
 *
 * Search failures are never re-thrown: they are reported as a
 * failing `corpus-reachable` check plus an informational (remedy-free)
 * `corpus-content` that says it was not checked. Individual candidate fetch or
 * decode failures simply fail closed for content counting.
 */
export async function corpusProbes({
  layer,
  repoSlug,
  k = CORPUS_ONBOARDING_K,
}: {
  layer: HarnessLayer;
  repoSlug: string;
  k?: number;
}): Promise<DoctorCheck[]> {
  const repoTerms = deriveRepositorySearchTerms(repoSlug);
  // An empty term set means pickup has no repository vocabulary (for example,
  // a two-character repo name). Probe the empty query only for reachability;
  // it must not make arbitrary corpus records count as repo content.
  const searchTerms = repoTerms.length > 0 ? repoTerms : [''];
  let hits: CorpusSearchHit[];
  try {
    const pages = await Promise.all(searchTerms.map((term) =>
      layer.corpus.search(term, {
        limit: Math.max(CORPUS_PROBE_CANDIDATE_LIMIT, k),
      })));
    const seen = new Set<string>();
    hits = pages.flat().filter((hit) => {
      if (seen.has(hit.ref)) return false;
      seen.add(hit.ref);
      return true;
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [
      {
        name: 'corpus-reachable',
        ok: false,
        detail: `unreachable — ${reason}`,
        remedy: 'check network / discovery config (JINN_DISCOVERY_URL) and re-run',
      },
      // Informational: never carries a remedy — there is nothing to fix here, the
      // reachability failure above owns the remedy.
      { name: 'corpus-content', ok: false, detail: 'not checked — corpus unreachable' },
    ];
  }

  // Ranking-side visibility gate: this is the same canonical mark helper the
  // corpus adapter uses to set KnowledgeHit.retrievalVisible. Skills are not
  // retrieval evidence, even if a malformed producer tagged one.
  const markedCandidates = (repoTerms.length > 0 ? hits : []).filter(
    (hit) => hit.kind !== 'skill' && hasRetrievalMark(hit.tags ?? []),
  );

  // Content-side visibility gate: createCorpusAdapter is the exact decoder the
  // plugin pickup wiring uses. It verifies the trace artifact and computes
  // retrievalVisible from the canonical envelope distributionTags, so the
  // doctor cannot drift into a parallel admission policy.
  const corpus = createCorpusAdapter({ layer });
  const admittedHits: CorpusSearchHit[] = [];
  for (const hit of markedCandidates) {
    if (admittedHits.length >= k) break;
    const result = await corpus.get(hit.ref);
    if (result.status !== 'ok' || result.value === null) continue;
    if (result.value.isSkillPayload === true || result.value.retrievalVisible !== true) continue;
    admittedHits.push(hit);
  }

  const contentOk = enoughCorpusForRepo(admittedHits, k);
  return [
    // Reachable is about the read path answering; 0 records is still reachable
    // (empty is non-blocking nothing-found, not an error).
    { name: 'corpus-reachable', ok: true, detail: `reachable — ${hits.length} record(s)` },
    // Informational: no remedy field EVER — a bare corpus is expected while the
    // repo has no records yet; Jinn stays quiet until content exists.
    {
      name: 'corpus-content',
      ok: contentOk,
      detail: contentOk
        ? `${admittedHits.length} retrieval-visible matching record(s)`
        : 'no matching content yet; Jinn stays quiet until it exists',
    },
  ];
}
