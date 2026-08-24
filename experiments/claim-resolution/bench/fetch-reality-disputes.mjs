/**
 * Reconstruct historically-disputed Reality.eth questions directly from chain
 * state, over public JSON-RPC. Produces the dispute-export JSONL that
 * bench/ingest-disputes.mjs consumes (schema/dispute-export.schema.json).
 *
 *   node bench/fetch-reality-disputes.mjs scan   [--deployment <key>|all]
 *   node bench/fetch-reality-disputes.mjs export [--deployment <key>|all]
 *                                                [--out bench/raw/dispute-export.jsonl]
 *
 * Ground-truth discipline: nothing here asks a model anything. The final
 * answer comes from the contract's own `resultFor()` (and the stored
 * `finalize_ts`), read at a fixed snapshot block. `LogFinalize` is NOT used as
 * the finalization criterion — inspection of the contract source shows it is
 * emitted only on the arbitrator-submission path (RealityETH-3.0.sol L549);
 * ordinary questions finalize passively when `finalize_ts` passes. That
 * corrects the assumption in DATA_REQUEST.md §1.2.
 *
 * Scan is resumable: raw logs append to bench/raw/<key>.logs.jsonl with a
 * checkpoint at bench/raw/<key>.checkpoint.json. The snapshot block is pinned
 * on first scan so a resumed run cannot smear across chain heads.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, decodeEventLog, getAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
const argv = process.argv.slice(2);
const CMD = argv[0];
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DEP = arg('--deployment', 'all');
const OUT = arg('--out', join(RAW, 'dispute-export.jsonl'));

// ── deployments (addresses/first blocks verified against
//    @reality.eth/contracts@3.2.25 chains/deployments/) ────────────────────
const RPCS = {
  // publicnode mainnet gates deep-history getLogs behind a token and
  // cloudflare-eth 500s on them; mevblocker (10k-block cap) and drpc carry the
  // historical scan.
  1: ['https://rpc.mevblocker.io', 'https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'],
  100: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
};
const DEPLOYMENTS = {
  'eth-2.0': { chainId: 1, version: '2.0', address: '0x325a2e0F3CCA2ddbaeBB4DfC38Df8D19ca165b47', firstBlock: 6531265, token: { kind: 'native', symbol: 'ETH', decimals: 18 } },
  'eth-3.0': { chainId: 1, version: '3.0', address: '0x5b7dD1E86623548AF054A4985F7fc8Ccbb554E2c', firstBlock: 13194676, token: { kind: 'native', symbol: 'ETH', decimals: 18 } },
  'eth-3.2': { chainId: 1, version: '3.2', address: '0x6a2155613b68eFB38D5c6074921F3F4281c8c177', firstBlock: 22100226, token: { kind: 'native', symbol: 'ETH', decimals: 18 } },
  'gno-2.1': { chainId: 100, version: '2.1', address: '0x79e32aE03fb27B07C89c0c568F80287C01ca2E57', firstBlock: 14005802, token: { kind: 'native', symbol: 'XDAI', decimals: 18 } },
  'gno-3.0': { chainId: 100, version: '3.0', address: '0xE78996A233895bE74a66F451f1019cA9734205cc', firstBlock: 17997262, token: { kind: 'native', symbol: 'XDAI', decimals: 18 } },
  'gno-3.2': { chainId: 100, version: '3.2', address: '0xEb51d9d9717906c981C57af09C4a3449eF30705b', firstBlock: 39142627, token: { kind: 'native', symbol: 'XDAI', decimals: 18 } },
};

const ABI = {};
for (const v of ['2.0', '2.1', '3.0', '3.2']) {
  ABI[v] = JSON.parse(readFileSync(join(HERE, 'abi', `RealityETH-${v}.abi.json`), 'utf8'));
}
// Event shapes are identical across 2.0–3.2 (verified field-by-field); decode
// everything with the 3.2 ABI. Function decoding uses the per-version ABI.
const EVENT_ABI = ABI['3.2'];

const WANTED_EVENTS = [
  'LogNewQuestion', 'LogNewAnswer', 'LogAnswerReveal',
  'LogNotifyOfArbitrationRequest', 'LogCancelArbitration', 'LogFinalize',
  'LogNewTemplate', 'LogReopenQuestion', 'LogFundAnswerBounty',
];

// topic0 per wanted event, computed from the ABI itself.
import { toEventSelector } from 'viem';
const TOPIC0 = new Map();
for (const e of EVENT_ABI) {
  if (e.type === 'event' && WANTED_EVENTS.includes(e.name)) {
    const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
    TOPIC0.set(toEventSelector(sig), e.name);
  }
}

// ── RPC pool with rotation, retry, adaptive windows ───────────────────────
function makePool(chainId) {
  const urls = RPCS[chainId];
  const clients = urls.map((u) => createPublicClient({ transport: http(u, { timeout: 30_000 }) }));
  let i = 0;
  return {
    current: () => clients[i % clients.length],
    rotate: () => { i += 1; },
    url: () => urls[i % clients.length],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(pool, fn, what, tries = 6) {
  let lastErr;
  for (let t = 0; t < tries; t += 1) {
    try {
      return await fn(pool.current());
    } catch (e) {
      lastErr = e;
      pool.rotate();
      await sleep(1000 * (t + 1));
    }
  }
  throw new Error(`${what} failed after ${tries} tries: ${lastErr?.message ?? lastErr}`);
}

// ── scan ──────────────────────────────────────────────────────────────────
async function scanDeployment(key) {
  const d = DEPLOYMENTS[key];
  const pool = makePool(d.chainId);
  mkdirSync(RAW, { recursive: true });
  const logsFile = join(RAW, `${key}.logs.jsonl`);
  const ckptFile = join(RAW, `${key}.checkpoint.json`);

  let ckpt = existsSync(ckptFile) ? JSON.parse(readFileSync(ckptFile, 'utf8')) : null;
  if (!ckpt) {
    const head = Number(await withRetry(pool, (c) => c.getBlockNumber(), 'blockNumber'));
    ckpt = { nextBlock: d.firstBlock, snapshotBlock: head, startedAt: new Date().toISOString() };
    writeFileSync(ckptFile, JSON.stringify(ckpt));
  }
  if (ckpt.nextBlock > ckpt.snapshotBlock) {
    console.log(`[scan ${key}] already complete at snapshot ${ckpt.snapshotBlock}`);
    return;
  }

  let window = 20_000;
  const MIN_W = 200;
  const MAX_W = 60_000;
  let streak = 0;
  let nLogs = 0;
  const t0 = Date.now();

  while (ckpt.nextBlock <= ckpt.snapshotBlock) {
    const from = ckpt.nextBlock;
    const to = Math.min(from + window - 1, ckpt.snapshotBlock);
    let logs;
    try {
      logs = await pool.current().request({
        method: 'eth_getLogs',
        params: [{
          address: d.address,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [[...TOPIC0.keys()]],
        }],
      });
    } catch (e) {
      streak = 0;
      if (window > MIN_W) { window = Math.max(MIN_W, Math.floor(window / 2)); continue; }
      pool.rotate();
      await sleep(2000);
      continue;
    }
    const lines = logs.map((l) => JSON.stringify({
      bn: Number(l.blockNumber), li: Number(l.logIndex), tx: l.transactionHash,
      topics: l.topics, data: l.data,
    })).join('\n');
    if (logs.length) appendFileSync(logsFile, lines + '\n');
    nLogs += logs.length;
    ckpt.nextBlock = to + 1;
    writeFileSync(ckptFile, JSON.stringify(ckpt));
    streak += 1;
    if (streak >= 4 && window < MAX_W) { window = Math.min(MAX_W, window * 2); streak = 0; }
    if ((ckpt.nextBlock - d.firstBlock) % 1_000_000 < window) {
      const pct = (100 * (ckpt.nextBlock - d.firstBlock) / (ckpt.snapshotBlock - d.firstBlock)).toFixed(1);
      console.log(`[scan ${key}] ${pct}% block=${ckpt.nextBlock} logs=${nLogs} window=${window} ${(Date.now() - t0) / 1000 | 0}s via ${pool.url()}`);
    }
  }
  console.log(`[scan ${key}] done: +${nLogs} logs to ${logsFile}, snapshot=${ckpt.snapshotBlock}`);
}

// ── export ────────────────────────────────────────────────────────────────
function decode(l) {
  try {
    const { eventName, args } = decodeEventLog({ abi: EVENT_ABI, topics: l.topics, data: l.data });
    return { eventName, args };
  } catch {
    return null; // unrelated topic (shouldn't happen — topics filtered at scan)
  }
}

async function exportDeployment(key, sink) {
  const d = DEPLOYMENTS[key];
  const pool = makePool(d.chainId);
  const logsFile = join(RAW, `${key}.logs.jsonl`);
  const ckptFile = join(RAW, `${key}.checkpoint.json`);
  if (!existsSync(ckptFile)) throw new Error(`no checkpoint for ${key} — run scan first`);
  const ckpt = JSON.parse(readFileSync(ckptFile, 'utf8'));
  if (ckpt.nextBlock <= ckpt.snapshotBlock) throw new Error(`scan for ${key} incomplete (${ckpt.nextBlock}/${ckpt.snapshotBlock})`);

  const questions = new Map(); // qid -> record
  const templates = new Map(); // template_id -> text (custom, from LogNewTemplate)
  const raw = existsSync(logsFile) ? readFileSync(logsFile, 'utf8').split('\n').filter(Boolean) : [];
  const logs = raw.map((l) => JSON.parse(l)).sort((a, b) => a.bn - b.bn || a.li - b.li);

  // De-dup (a resumed scan can re-append a window's logs after a crash
  // between the append and the checkpoint write).
  const seen = new Set();

  for (const l of logs) {
    const k = `${l.bn}:${l.li}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ev = decode(l);
    if (!ev) continue;
    const a = ev.args;
    const q = (qid) => {
      if (!questions.has(qid)) questions.set(qid, { qid, answers: [], reveals: [], arb: null, arbCancelled: false, finalizeLog: null, reopenedAs: null, reopenedFrom: null, bounties: [] });
      return questions.get(qid);
    };
    switch (ev.eventName) {
      case 'LogNewTemplate':
        templates.set(Number(a.template_id), a.question_text);
        break;
      case 'LogNewQuestion': {
        const r = q(a.question_id);
        Object.assign(r, {
          created_bn: l.bn, created_tx: l.tx,
          template_id: Number(a.template_id),
          question_raw: a.question,
          arbitrator: a.arbitrator,
          timeout: Number(a.timeout),
          opening_ts: Number(a.opening_ts),
          created_ts: Number(a.created),
          asker: a.user,
          content_hash: a.content_hash,
          nonce: String(a.nonce),
        });
        break;
      }
      case 'LogNewAnswer':
        q(a.question_id).answers.push({
          answer_raw: a.answer, bond: String(a.bond), ts: Number(a.ts), user: a.user,
          is_commitment: Boolean(a.is_commitment), history_hash: a.history_hash,
          block_number: l.bn, tx_hash: l.tx,
        });
        break;
      case 'LogAnswerReveal':
        q(a.question_id).reveals.push({ answer_hash: a.answer_hash, answer_raw: a.answer, nonce: String(a.nonce), bond: String(a.bond), block_number: l.bn, tx_hash: l.tx });
        break;
      case 'LogNotifyOfArbitrationRequest':
        q(a.question_id).arb = { requested_by: a.user, block_number: l.bn, tx_hash: l.tx };
        break;
      case 'LogCancelArbitration':
        q(a.question_id).arbCancelled = true;
        break;
      case 'LogFinalize':
        q(a.question_id).finalizeLog = { answer_raw: a.answer, block_number: l.bn, tx_hash: l.tx };
        break;
      case 'LogReopenQuestion':
        // question_id = the NEW replacement question; reopened_question_id = the
        // original question being reopened (contract source, reopenQuestion()).
        q(a.question_id).reopenedFrom = a.reopened_question_id;
        q(a.reopened_question_id).reopenedAs = a.question_id;
        break;
      case 'LogFundAnswerBounty':
        q(a.question_id).bounties.push({ bounty_added: String(a.bounty_added ?? a.bounty ?? 0), user: a.user });
        break;
      default:
    }
  }

  // Mechanical selection: >=2 distinct effective answers, or arbitration requested.
  const effAnswers = (r) => {
    const revealByHash = new Map(r.reveals.map((v) => [v.answer_hash, v]));
    return r.answers.map((ans) => {
      if (!ans.is_commitment) return ans.answer_raw;
      const rev = revealByHash.get(ans.answer_raw); // commitment stores the hash in `answer`
      return rev ? rev.answer_raw : null; // unrevealed commitment: no answer content
    }).filter(Boolean);
  };

  const candidates = [];
  for (const r of questions.values()) {
    if (!r.question_raw && r.answers.length === 0) continue; // stray event for question created before firstBlock (shouldn't happen)
    if (!r.question_raw) continue; // no creation record — cannot reconstruct
    const distinct = new Set(effAnswers(r).map((x) => x.toLowerCase()));
    const contested = distinct.size >= 2;
    const arbitrated = Boolean(r.arb);
    if (contested || arbitrated) candidates.push({ r, n_distinct: distinct.size });
  }
  console.log(`[export ${key}] ${questions.size} questions scanned, ${candidates.length} pass the mechanical dispute filter`);

  // Enrich candidates via eth_call at the snapshot block: finalization status,
  // the contract's own final answer, and stored finalize_ts.
  const abi = ABI[d.version];
  const snap = BigInt(ckpt.snapshotBlock);
  const blockTsCache = new Map();
  const blockTs = async (bn) => {
    if (!blockTsCache.has(bn)) {
      const b = await withRetry(pool, (c) => c.getBlock({ blockNumber: BigInt(bn) }), `getBlock ${bn}`);
      blockTsCache.set(bn, Number(b.timestamp));
    }
    return blockTsCache.get(bn);
  };

  let exported = 0;
  let unfinalized = 0;
  const BATCH = 20;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ r, n_distinct }) => {
      const contract = { address: getAddress(d.address), abi };
      // Finalization is monotonic (once finalized a question cannot revert and
      // resultFor is stable; reopening creates a NEW question id), so falling
      // back from the pinned snapshot block to `latest` — for nodes without
      // deep state — cannot change an answer, only admit a question that
      // finalized after the snapshot.
      const call = (functionName) =>
        withRetry(pool, (c) => c.readContract({ ...contract, functionName, args: [r.qid], blockNumber: snap }), `${functionName} ${r.qid}`, 3)
          .catch(() => withRetry(pool, (c) => c.readContract({ ...contract, functionName, args: [r.qid] }), `${functionName}@latest ${r.qid}`));
      let fin, qstruct;
      try {
        [fin, qstruct] = await Promise.all([call('isFinalized'), call('questions')]);
      } catch (e) {
        console.error(`[export ${key}] enrich failed for ${r.qid}: ${e.message}`);
        return;
      }
      if (!fin) { unfinalized += 1; return; }
      let finalAnswer;
      try {
        finalAnswer = await call('resultFor');
      } catch (e) {
        console.error(`[export ${key}] resultFor failed for ${r.qid}: ${e.message}`);
        return;
      }
      const finalizeTs = Number(qstruct[4]); // finalize_ts — same slot in all versions
      let arb = null;
      if (r.arb) {
        const ts = await blockTs(r.arb.block_number);
        arb = {
          arbitrator: r.arbitrator ?? null,
          requested_by: r.arb.requested_by,
          requested_ts: ts,
          cancelled: r.arbCancelled,
          arbitrator_answer_raw: r.finalizeLog?.answer_raw ?? null,
          arbitrator_answer_ts: r.finalizeLog ? await blockTs(r.finalizeLog.block_number) : null,
        };
      }
      const rec = {
        source_protocol: 'reality.eth',
        case_id: r.qid,
        chain_id: d.chainId,
        contract_address: d.address,
        contract_version: d.version,
        template_id: r.template_id,
        template_text: r.template_id >= 5 ? (templates.get(r.template_id) ?? undefined) : undefined,
        question_raw: r.question_raw,
        content_hash: r.content_hash,
        asker: r.asker,
        created_ts: r.created_ts,
        opening_ts: r.opening_ts,
        timeout: r.timeout,
        min_bond: d.version >= '3.0' ? String(qstruct[10] ?? '0') : '0',
        bond_token: d.token,
        answer_history: r.answers.map((ans) => {
          if (!ans.is_commitment) return ans;
          const rev = r.reveals.find((v) => v.answer_hash === ans.answer_raw);
          return rev ? { ...ans, answer_raw: rev.answer_raw, revealed: true } : { ...ans, unrevealed: true };
        }).filter((ans) => !ans.unrevealed),
        arbitration: arb ?? undefined,
        final_answer_raw: finalAnswer,
        finalize_ts: finalizeTs,
        finalize_tx: r.finalizeLog?.tx_hash ?? undefined,
        reopened_as: r.reopenedAs ?? undefined,
        reopened_from: r.reopenedFrom ?? undefined,
        deployment_key: key,
        snapshot_block: ckpt.snapshotBlock,
        n_distinct_answers_prefilter: n_distinct,
      };
      sink(rec);
      exported += 1;
    }));
    if ((i / BATCH) % 10 === 0) console.log(`[export ${key}] enriched ${Math.min(i + BATCH, candidates.length)}/${candidates.length}`);
  }
  console.log(`[export ${key}] exported ${exported} finalized disputed cases (${unfinalized} candidates not yet finalized)`);
  return { questions: questions.size, candidates: candidates.length, exported, unfinalized, snapshotBlock: ckpt.snapshotBlock };
}

// ── main ──────────────────────────────────────────────────────────────────
const keys = DEP === 'all' ? Object.keys(DEPLOYMENTS) : [DEP];
for (const k of keys) if (!DEPLOYMENTS[k]) { console.error(`unknown deployment ${k}`); process.exit(2); }

if (CMD === 'scan') {
  // Deployments scan concurrently across chains, sequentially within a chain
  // (shared rate limits).
  const byChain = new Map();
  for (const k of keys) {
    const c = DEPLOYMENTS[k].chainId;
    if (!byChain.has(c)) byChain.set(c, []);
    byChain.get(c).push(k);
  }
  await Promise.all([...byChain.values()].map(async (ks) => {
    for (const k of ks) await scanDeployment(k);
  }));
} else if (CMD === 'export') {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');
  const manifest = { generated_at: new Date().toISOString(), filter: 'finalized AND (>=2 distinct effective answers OR arbitration requested)', deployments: {} };
  for (const k of keys) {
    manifest.deployments[k] = await exportDeployment(k, (rec) => appendFileSync(OUT, JSON.stringify(rec) + '\n'));
  }
  writeFileSync(join(dirname(OUT), 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[export] wrote ${OUT} + manifest.json`);
} else {
  console.error('usage: fetch-reality-disputes.mjs scan|export [--deployment <key>|all] [--out <file>]');
  process.exit(2);
}
