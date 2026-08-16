/**
 * LIVE data-pipeline run (dev script) — real testnet ledger → real distilled skills.
 *
 * Uses the VALIDATED evidence path (verdict envelope → producedBy.trajectoryCid →
 * scrubbed spans), the real claude distiller, the real distillClusters
 * orchestration (output secret-scrub + contamination scan), and a local-fs
 * publishSkill (no chain). Scoped tiny (a few instances) — spends `claude` solves.
 *
 *   cd operator && yarn tsx scripts/distill-run-live.ts
 *
 * LIVE FINDINGS (2026-07-07) — RESOLVED. The first run distilled the EVALUATOR's
 * trajectory (`producedBy.trajectoryCid`), not the SOLVER's patch, and the
 * verdict→solution link is NOT a simple key join. Both are now fixed by the
 * VERIFIED 3-hop join (see `fetchEvidence` below): verdict envelope → task doc
 * `restorationRequestId` → `attemptEnvelopeMeta` → solution envelope
 * `payload.patch`. This join is now the shape shipped in the production adapters
 * (`bridge-verdict-source.ts` / `bridge-fetch-evidence.ts`) and made a
 * first-class single indexer column by #1433 (`verdictEnvelopeMeta.solutionRequestId`).
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillMarkdown,
  createClaudeDistiller,
  distillClusters,
  type DistillCluster,
  type SkillPackage,
} from '@jinn-network/jinn-layer';
import { loadActiveHeldOutSlateIds, ACTIVE_HELD_OUT_SLATE_VERSIONS } from '../src/solver-types/_swe-rebench-v2-held-out-slate.js';

const GRAPHQL = 'https://jinn-indexer-production.up.railway.app/graphql';
const GATEWAY = 'https://gateway.autonolas.tech/ipfs';
const MODEL = 'claude-haiku-4-5-20251001';
const N_PASS = 8; // candidates to try per polarity (the 3-hop join can miss per instance)
const N_FAIL = 8;
const TARGET_PER_POLARITY = 1; // distilled skills per polarity (bounds claude solves)

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`gql: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/** Byte ceiling per fetched IPFS object (PR #1476 security review — OOM guard). */
const MAX_IPFS_FETCH_BYTES = 64 * 1024 * 1024;

async function ipfs(cid: string): Promise<any> {
  const res = await fetch(`${GATEWAY}/${cid}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ipfs ${cid}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IPFS_FETCH_BYTES) {
    throw new Error(`ipfs ${cid}: ${buf.byteLength} bytes exceeds the fetch ceiling`);
  }
  return JSON.parse(Buffer.from(buf).toString('utf8'));
}

interface VerdictRow { instanceId: string; actualPassed: boolean; evaluatorVerdict: string; manifestCid: string; }

async function fetchVerdicts(passed: boolean, limit: number, exclude: Set<string>): Promise<VerdictRow[]> {
  const data = await gql<{ verdictEnvelopeMetas: { items: VerdictRow[] } }>(
    `{ verdictEnvelopeMetas(where:{solverType_starts_with:"swe-rebench-v2", enrichmentStatus:"ok", instanceId_not:"", actualPassed:${passed}, evaluatorVerdict:"${passed ? 'PASS' : 'FAIL'}"}, limit:12){ items { instanceId actualPassed evaluatorVerdict manifestCid } } }`,
  );
  const out: VerdictRow[] = [];
  const seen = new Set<string>();
  for (const r of data.verdictEnvelopeMetas.items) {
    if (exclude.has(r.instanceId) || seen.has(r.instanceId) || !r.manifestCid) continue;
    seen.add(r.instanceId);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The VERIFIED 3-hop join to the SOLVER's coding patch (pure HTTP, no RPC):
 *   verdict envelope (row.manifestCid) → task.cid
 *   → task doc → restorationRequestId  (the SOLVE request; the missing link)
 *   → attemptEnvelopeMeta(requestId=restorationRequestId) → solution envelope CID
 *   → solution envelope → payload.patch
 * (Issue #1433 will make this a single indexer join.)
 */
async function fetchEvidence(row: VerdictRow): Promise<{ patch: string; problem: string; solutionCid: string }> {
  const verdictEnv = await ipfs(row.manifestCid);
  const taskCid = verdictEnv?.task?.cid;
  if (!taskCid) throw new Error('no task.cid on verdict envelope');
  const taskDoc = await ipfs(taskCid);
  const solveReq = taskDoc?.restorationRequestId;
  if (!solveReq) throw new Error('no restorationRequestId in task doc');
  const d = await gql<{ attemptEnvelopeMetas: { items: Array<{ manifestCid: string }> } }>(
    `{ attemptEnvelopeMetas(where:{requestId:"${solveReq}"}){ items { manifestCid } } }`,
  );
  const item = d.attemptEnvelopeMetas.items[0];
  if (!item) throw new Error(`no attemptEnvelopeMeta for solve requestId ${solveReq.slice(0, 12)}…`);
  const solEnv = await ipfs(item.manifestCid);
  const patch = solEnv?.payload?.patch;
  if (!patch || typeof patch !== 'string') throw new Error('no payload.patch on solution envelope');
  const problem = String(taskDoc.description ?? taskDoc?.spec?.problem_statement ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 1500);
  return { patch: patch.slice(0, 6000), problem: problem || row.instanceId, solutionCid: item.manifestCid };
}

async function main(): Promise<void> {
  const heldOut = loadActiveHeldOutSlateIds('swe-rebench-v2.v1', ACTIVE_HELD_OUT_SLATE_VERSIONS);
  console.log(`[live] held-out slate: ${heldOut.size} instances excluded`);

  const passRows = await fetchVerdicts(true, N_PASS, heldOut);
  const failRows = await fetchVerdicts(false, N_FAIL, heldOut);
  console.log(`[live] verdicts: ${passRows.length} pass, ${failRows.length} fail`);

  const clusters: DistillCluster[] = [];
  for (const [rows, tier] of [[passRows, 'pattern'], [failRows, 'lesson']] as const) {
    let got = 0;
    for (const row of rows) {
      if (got >= TARGET_PER_POLARITY) break;
      try {
        const ev = await fetchEvidence(row);
        console.log(`[live] evidence ${row.instanceId} (${tier}) — solution ${ev.solutionCid.slice(0, 14)}…, patch ${ev.patch.length} chars`);
        clusters.push({
          clusterId: `${tier}:${row.instanceId}`,
          tier,
          evidenceRefs: [ev.solutionCid],
          instanceIds: [row.instanceId],
          input: { instanceId: row.instanceId, polarity: tier === 'pattern' ? 'pass' : 'fail', problem: ev.problem, patch: ev.patch },
        });
        got++;
      } catch (err) {
        console.warn(`[live] skip ${row.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (clusters.length === 0) throw new Error('no clusters — all evidence fetches failed');

  const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-live-'));
  const skills: SkillPackage[] = [];
  console.log(`[live] distilling ${clusters.length} cluster(s) via claude ${MODEL} …`);
  const result = await distillClusters(clusters, {
    distill: createClaudeDistiller({ model: MODEL }),
    publishSkill: async (pkg) => {
      skills.push(pkg);
      const dir = join(outDir, pkg.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), buildSkillMarkdown(pkg));
      return { envelopeRef: `local:${pkg.name}`, anchorTx: null };
    },
    slate: { instanceIds: heldOut },
    distribution: 'coding',
  });

  console.log(`\n[live] RESULT: published ${result.published.length}, rejected ${result.rejected.length}, errors ${result.errors.length}`);
  for (const r of result.rejected) console.log(`  rejected ${r.clusterId}: ${r.reason}`);
  for (const r of result.errors) console.log(`  error ${r.clusterId}: ${r.error}`);
  console.log(`[live] skills written under: ${outDir}`);
  for (const s of skills) {
    console.log(`\n──────── ${s.name} (${s.jinn.skillKind}) ────────`);
    console.log(buildSkillMarkdown(s).slice(0, 1200));
  }
}

main().catch((e) => { console.error('[live] FAILED:', e); process.exit(1); });
