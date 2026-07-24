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

import {
  mineableTraceRecordFromStored,
} from './_swe-rebench-v2-mineable-store.js';
import type { MineableTraceStorePort } from './_swe-rebench-v2-mineable-store-port.js';
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
import {
  assertPublicRepoForPublish,
  assertRepoAllowedForMint,
  loadMintRepoDenylist,
} from './_swe-rebench-v2-guards.js';
import { mintedIpfsDatasetCid, parseMintedIpfsDataset } from './_swe-rebench-v2-minted-pool.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import { EVAL_SEMANTICS_VERSION } from './_swe-rebench-v2-validated-pool.js';

export interface SessionEchoMintDeps extends HarvestMintDeps {
  mineableStore: MineableTraceStorePort;
  /** Recording operator's Safe — stamped into provenance as `sourceSolverSafe`
   *  so `syntheticClaimBlocked` refuses that operator's own claim (§7). */
  operatorSafe?: string;
  /** Same admitted pool a sibling harvest tick would load — used only to find
   *  an already-admitted same-repo instance whose eval infra (image,
   *  install config, test framework) the echo borrows. Plays no role in
   *  naming or provenance. */
  pool: PoolTask[];
  /** Max session-echo records processed per harvest tick (sibling of
   *  `harvest.limitPerRepo`). Unprocessed backlog remains for later ticks. */
  limitPerTick?: number;
}

const DEFAULT_LIMIT_PER_TICK = 3;

export async function mineSessionEchoes(deps: SessionEchoMintDeps): Promise<SessionEchoTickResult> {
  const scorableIds = await deps.validatedStore.getScorableIds(EVAL_SEMANTICS_VERSION);
  if (!scorableIds || scorableIds.size === 0) {
    return { discovered: 0, admitted: [], rejected: [], skipped: ['no-validated-pool'] };
  }

  // Newly recorded candidates always run through local mining, even when
  // sharing is disabled. A locally minted candidate is revisited only when a
  // preview acknowledgement (or the persisted standing acknowledgement for a
  // later candidate) has moved its publication axis to queued.
  const pending = (await deps.mineableStore.list()).filter((record) =>
    record.localState === 'recorded' ||
    (Boolean(deps.publish) && record.localState === 'minted' && record.publicationState === 'queued'),
  );
  const limitPerTick = deps.limitPerTick ?? DEFAULT_LIMIT_PER_TICK;
  const batch = pending.slice(0, limitPerTick);
  const denylist = loadMintRepoDenylist();
  const admitted: string[] = [];
  const rejected: Array<{ instance_id: string; reason: string }> = [];

  for (const stored of batch) {
    const record = mineableTraceRecordFromStored(stored);
    const provisionalId = sessionEchoInstanceId(record.repo, record.sourceId);

    const rejectAndFinish = async (reason: string): Promise<void> => {
      rejected.push({ instance_id: provisionalId, reason });
      if (stored.localState === 'recorded') {
        await deps.mineableStore.markRejected(record.sourceId, reason);
      } else {
        // The local mint remains useful, but a failed final publication gate
        // must not retry outbound forever.
        await deps.mineableStore.veto(record.sourceId);
      }
    };

    try {
      assertRepoAllowedForMint(record.repo, denylist);
    } catch (err) {
      await rejectAndFinish(err instanceof Error ? err.message : String(err));
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
        await rejectAndFinish('synthetic-source');
        continue;
      }
    }

    // A prior tick may have committed the local mint (or even its IPFS
    // artifact) before the contribution record advanced. Resume from that
    // durable state without repeating Docker evaluation or overwriting it.
    const existingMint = await deps.mintedStore.getEntry(provisionalId, EVAL_SEMANTICS_VERSION);
    if (existingMint) {
      admitted.push(provisionalId);
      if (stored.publicationState === 'queued' && deps.publish) {
        try {
          await deps.mineableStore.publishAuthorized(record.sourceId, async () => {
            let publicationRef = existingMint.published
              ? existingMint.hf_dataset
              : undefined;
            if (existingMint.published && !parseMintedIpfsDataset(existingMint.hf_dataset)) {
              throw new Error(`published mint ${provisionalId} has no IPFS artifact reference`);
            }
            if (!publicationRef) {
              const artifact = await deps.mintedStore.exportArtifact(EVAL_SEMANTICS_VERSION, {
                generatedAt: existingMint.mintedAt,
                includeIds: [provisionalId],
              });
              await assertPublicRepoForPublish(record.repo, deps.publicRepoChecker);
              const cid = await uploadToIpfs(deps.ipfsRegistryUrl, artifact);
              await deps.mintedStore.setPublishedArtifact(
                EVAL_SEMANTICS_VERSION,
                cid,
                [provisionalId],
                { rowHashVersion: 1 },
              );
              await deps.progress?.onIpfsPublished?.({
                instanceIds: [provisionalId],
                rowHashVersion: 1,
                artifactCid: cid,
              });
              publicationRef = mintedIpfsDatasetCid(cid);
            }
            return {
              value: undefined,
              mintRef: provisionalId,
              publicationRef,
            };
          });
        } catch (error) {
          rejected.push({
            instance_id: provisionalId,
            reason: error instanceof Error ? error.message : String(error),
          });
          // The local mint remains useful even when consent/repo publication
          // authorization disappeared before outbound I/O.
          await deps.mineableStore.markMinted(record.sourceId, provisionalId);
        }
      } else if (stored.localState !== 'minted') {
        await deps.mineableStore.markMinted(record.sourceId, provisionalId);
      }
      continue;
    }

    const source = findSourceInstanceForRepo(deps.pool, scorableIds, record.repo);
    if (!source) {
      await rejectAndFinish(`no admitted source instance for repo ${record.repo}`);
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
      await rejectAndFinish(builtResult.reason ?? 'build-failed');
      continue;
    }

    // Publication is a persisted state transition, not a process-local
    // interpretation of the old consent boolean. Disabled, preview-required,
    // and vetoed candidates may mint locally but cause zero outbound I/O.
    const publish = Boolean(deps.publish) && stored.publicationState === 'queued';

    let mintResult;
    try {
      mintResult = await admitBuiltMintCandidates([builtResult.built], {
        ...deps,
        publish,
        ...(publish ? {
          withPublicationAuthorization: async (_args, publishArtifact) =>
            deps.mineableStore.publishAuthorized(record.sourceId, async () => {
              const cid = await publishArtifact();
              return {
                value: cid,
                mintRef: builtResult.built!.poolTask.instance_id,
                publicationRef: mintedIpfsDatasetCid(cid),
              };
            }),
        } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const durableMint = await deps.mintedStore.getEntry(provisionalId, EVAL_SEMANTICS_VERSION);
      if (durableMint) {
        if (!admitted.includes(provisionalId)) admitted.push(provisionalId);
        rejected.push({ instance_id: provisionalId, reason });
        await deps.mineableStore.markMinted(record.sourceId, provisionalId);
      } else {
        await rejectAndFinish(reason);
      }
      continue;
    }
    for (const id of mintResult.admitted) admitted.push(id);
    for (const r of mintResult.rejected) rejected.push(r);
    const admittedId = mintResult.admitted[0];
    if (admittedId) {
      if (!publish) {
        await deps.mineableStore.markMinted(record.sourceId, admittedId);
      }
    } else if (stored.localState === 'recorded') {
      await deps.mineableStore.markRejected(
        record.sourceId,
        mintResult.rejected[0]?.reason ?? 'admission-failed',
      );
    } else if (mintResult.rejected.length > 0) {
      await deps.mineableStore.veto(record.sourceId);
    }
  }

  return { discovered: batch.length, admitted, rejected, skipped: [] };
}
