/**
 * Session-echo miner — mints locally captured task-creator sessions
 * (`MineableTraceRecord`s, Task 6) into mint candidates. Spec §5.2/§7/§10.
 *
 * v0 is session-echo only (whole `acceptedDiff` as gold, one candidate per
 * record) — see {@link buildSessionEchoMintCandidate} in
 * `_swe-rebench-v2-harvest.ts`. Structurally mirrors `runHarvestTick`
 * (`../daemon/harvest-loop.ts`): per record, denylist gate → find source
 * instance → build candidate → admit → `markMined`, so a record is never
 * reprocessed regardless of outcome.
 */

import type { MineableTraceStore } from './_swe-rebench-v2-mineable-store.js';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { HarvestTickResult } from '../daemon/harvest-loop.js';

/**
 * Session-echo mining only ever populates `discovered/admitted/rejected/skipped`
 * — it never emits `awaitingInput`/`quarantined` (those belong to the
 * commit-echo publication state machine). Narrowing the return keeps the caller
 * (`runHarvestTick`) free to spread these fields into its richer 6-field tick
 * result without this function fabricating empty values for concepts it does
 * not model.
 */
export type SessionEchoTickResult = Pick<
  HarvestTickResult,
  'discovered' | 'admitted' | 'rejected' | 'skipped'
>;
import {
  admitBuiltMintCandidates,
  buildSessionEchoMintCandidate,
  findSourceInstanceForRepo,
  sessionEchoInstanceId,
  type HarvestMintDeps,
} from './_swe-rebench-v2-harvest.js';
import { assertRepoAllowedForMint, loadMintRepoDenylist } from './_swe-rebench-v2-guards.js';
import { EVAL_SEMANTICS_VERSION } from './_swe-rebench-v2-validated-pool.js';

export interface SessionEchoMintDeps extends HarvestMintDeps {
  mineableStore: MineableTraceStore;
  /** Recording operator's Safe — stamped into provenance as `sourceSolverSafe`
   *  so `syntheticClaimBlocked` refuses that operator's own claim (§7). */
  operatorSafe?: string;
  /** Same admitted pool a sibling harvest tick would load — used only to find
   *  an already-admitted same-repo instance whose eval infra (image,
   *  install config, test framework) the echo borrows. Plays no role in
   *  naming or provenance. */
  pool: PoolTask[];
}

export async function mineSessionEchoes(deps: SessionEchoMintDeps): Promise<SessionEchoTickResult> {
  const scorableIds = await deps.validatedStore.getScorableIds(EVAL_SEMANTICS_VERSION);
  if (!scorableIds || scorableIds.size === 0) {
    return { discovered: 0, admitted: [], rejected: [], skipped: ['no-validated-pool'] };
  }

  const records = await deps.mineableStore.listUnmined();
  const denylist = loadMintRepoDenylist();
  const admitted: string[] = [];
  const rejected: Array<{ instance_id: string; reason: string }> = [];

  for (const record of records) {
    const provisionalId = sessionEchoInstanceId(record.repo, record.sourceId);

    const rejectAndMine = async (reason: string): Promise<void> => {
      rejected.push({ instance_id: provisionalId, reason });
      await deps.mineableStore.markMined(record.sourceId);
    };

    try {
      assertRepoAllowedForMint(record.repo, denylist);
    } catch (err) {
      await rejectAndMine(err instanceof Error ? err.message : String(err));
      continue;
    }

    // Belt-and-braces against second-generation echoes (spec §7): if this
    // record's source task was itself a synthetic mint (its instance_id
    // already lives in the minted pool), refuse before spending any Docker
    // time building a candidate. The engine's pack()-hook skip is the
    // primary guard; this catches records that predate that fix or that
    // otherwise slipped through.
    if (record.sourceInstanceId) {
      const mintedEntries = await deps.mintedStore.listEntries(EVAL_SEMANTICS_VERSION);
      const sourceIsSynthetic = mintedEntries.some(
        (entry) => entry.row.instance_id === record.sourceInstanceId,
      );
      if (sourceIsSynthetic) {
        await rejectAndMine('synthetic-source');
        continue;
      }
    }

    const source = findSourceInstanceForRepo(deps.pool, scorableIds, record.repo);
    if (!source) {
      await rejectAndMine(`no admitted source instance for repo ${record.repo}`);
      continue;
    }

    const builtResult = await buildSessionEchoMintCandidate({
      record,
      source,
      fetcher: deps.hfFetcher,
      runner: deps.runner,
      minterSafe: deps.minterSafe,
      operatorSafe: deps.operatorSafe,
    });
    if (!builtResult.built) {
      await rejectAndMine(builtResult.reason ?? 'build-failed');
      continue;
    }

    // Tier-2 gate: a record without publish consent still mints locally
    // (tier-1 allows that) but is never published. `Boolean(...)` guarantees
    // a real boolean (never `undefined`) so `runMintTasksPipeline`'s
    // `c.publish !== false` publish-path check is skipped, not defaulted on.
    // `deps` already satisfies HarvestMintDeps (SessionEchoMintDeps extends it);
    // spread it and override only `publish` rather than re-listing every field.
    const publish = Boolean(deps.publish) && record.publishMinedTasksConsent;

    const mintResult = await admitBuiltMintCandidates([builtResult.built], { ...deps, publish });
    for (const id of mintResult.admitted) admitted.push(id);
    for (const r of mintResult.rejected) rejected.push(r);
    await deps.mineableStore.markMined(record.sourceId);
  }

  return { discovered: records.length, admitted, rejected, skipped: [] };
}
