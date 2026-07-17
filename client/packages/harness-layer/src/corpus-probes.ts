/**
 * Layer-side corpus doctor probes — the single shared implementation of the
 * two "does the operator have corpus" checks the doctor renders.
 *
 * Two checks come out of one round-trip against the corpus consume path:
 *   - `corpus-reachable` — is the corpus read path answering at all?
 *   - `corpus-content`   — did the repo-slug query find enough records to matter?
 *
 * Both are shared so the Python doctor (apps/jinn-agent/plugins/jinn/doctor.py)
 * and the layer CLI (`jinn-layer corpus probe`) render identical semantics.
 *
 * Logged assumptions (both are single-predicate swaps inside this module):
 *  1. No retrieval-mark / evidence-tier filter is shipped yet. The probe queries
 *     the plain repo-slug corpus-search path. Mark-gating (the W2 flip) is a
 *     future one-predicate swap inside `corpusProbes` — it does not change the
 *     probe's shape.
 *  2. `corpus-content` counts `hits.length` because
 *     `layer.corpus.search(repoSlug, { limit: k })` already substring-matches
 *     the query against solverType / role / ref / task cid, so the vocabulary
 *     intersection between the repo slug and each record is implicit in the hit
 *     set — a returned hit is a matching record.
 */

import type { HarnessLayer, CorpusSearchHit } from './consume.js';

/**
 * How many matching corpus records a repo needs before Jinn considers itself
 * "onboarded" for that repo. B's "enough corpus" guarantee — the sole source of
 * truth for the K threshold, consumed by both `enoughCorpusForRepo` and the
 * `corpus-content.ok` field below.
 */
export const CORPUS_ONBOARDING_K = 3;

/**
 * One doctor check result. Mirrors the Python doctor contract in
 * apps/jinn-agent/plugins/jinn/doctor.py: a plain `{name, ok, detail}` dict with
 * `remedy` present exactly when `ok` is false — EXCEPT informational checks,
 * which never carry a remedy even when `ok` is false (there is nothing for the
 * operator to fix, so there is no copy-paste command to offer). `corpus-content`
 * is such an informational check.
 */
export type DoctorCheck = { name: string; ok: boolean; detail: string; remedy?: string };

/**
 * Minimal structural dependency: anything exposing the corpus `search` method.
 * Accepts a real `HarnessLayer` or a test fake.
 */
type LayerDep = { corpus: { search: HarnessLayer['corpus']['search'] } };

/**
 * B's "enough corpus" guarantee: a repo has enough corpus when at least `k`
 * matching records were found. The single source of truth for the K threshold —
 * `corpusProbes`' `corpus-content.ok` MUST call this over the same hits so the
 * threshold cannot drift between the two.
 */
export function enoughCorpusForRepo(hits: CorpusSearchHit[], k = CORPUS_ONBOARDING_K): boolean {
  return hits.length >= k;
}

/**
 * Run the two corpus doctor probes off a single corpus-search round-trip.
 *
 * One round-trip, never re-thrown: a search failure is caught and reported as a
 * failing `corpus-reachable` check plus an informational (remedy-free)
 * `corpus-content` that says it was not checked.
 */
export async function corpusProbes({
  layer,
  repoSlug,
  k = CORPUS_ONBOARDING_K,
}: {
  layer: LayerDep;
  repoSlug: string;
  k?: number;
}): Promise<DoctorCheck[]> {
  let hits: CorpusSearchHit[];
  try {
    hits = await layer.corpus.search(repoSlug, { limit: k });
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

  const contentOk = enoughCorpusForRepo(hits, k);
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
        ? `${hits.length} matching record(s)`
        : 'no matching content yet; Jinn stays quiet until it exists',
    },
  ];
}
