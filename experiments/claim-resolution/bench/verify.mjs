/**
 * Stage 2 — independent ground-truth verification.
 *
 * The verifier sees claim + criteria + deadline ONLY. It never sees the
 * curator's proposed ground_truth, so agreement is real agreement.
 *
 * The verifier is deliberately UNRESTRICTED: it is told to go and find the
 * settlement record — the oracle/market resolution page, the official
 * announcement — precisely the sources the solvers are blocked from. That
 * keeps ground truth reliable without making the solver task easy.
 *
 *   node bench/verify.mjs [--in candidates.json] [--out verified.json]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema/verifier.schema.json'), 'utf8');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in', join(ROOT, 'bench/candidates.json'));
const OUT = arg('--out', join(ROOT, 'bench/verified.json'));
const MODEL = arg('--model', 'claude-opus-5');
const CONCURRENCY = Number(arg('--concurrency', '8'));

const SYSTEM = `You establish the ground truth for a benchmark of already-resolved claims.

You are given a claim, its resolution criteria, and a deadline that has passed.
Determine how it actually resolved.

You are explicitly permitted — and encouraged — to consult the settlement record
directly: the prediction market or oracle resolution page, the official
announcement, the regulator's docket, the court's published judgment. Prefer the
authoritative record over secondary reporting.

Report:
- answer: what the claim resolved to under its stated criteria, or UNVERIFIABLE
  if you cannot establish it with high confidence.
- confidence: your probability that this is the true external resolution.
- settlement_record: the authoritative record you relied on, named precisely.
- sources: URLs.
- criteria_are_unambiguous: false if the criteria as written could defensibly
  produce either answer, or if they reference something not defined in the text.
  Be strict — an ambiguous claim is unusable as ground truth.
- notes: anything that would make this a bad benchmark item (unresolved,
  ambiguous, self-answering, criteria that give the answer away, or a claim
  that is trivially settled by one lookup).

Search extensively. Being wrong here corrupts the whole benchmark, so return
UNVERIFIABLE rather than guessing.`;

function verify(c, idx) {
  const prompt = [
    `CLAIM: ${c.claim}`, '',
    `RESOLUTION CRITERIA: ${c.criteria}`, '',
    `RESOLUTION DEADLINE: ${c.deadline}`, '',
    'Today is 2026-08-19. Establish how this resolved.',
  ].join('\n');

  const args = [
    '-p', '--model', MODEL,
    '--system-prompt', SYSTEM,
    '--tools', 'WebSearch', '--allowed-tools', 'WebSearch',
    '--setting-sources', '', '--no-session-persistence',
    '--json-schema', SCHEMA, '--output-format', 'json', prompt,
  ];

  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const child = spawn('claude', args, { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (x) => { out += x; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 900_000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const meta = JSON.parse(out);
        const v = JSON.parse(meta.result);
        console.log(`[verify] ${idx} ${c.bucket}: curator=${c.ground_truth} verifier=${v.answer} conf=${v.confidence} unambig=${v.criteria_are_unambiguous}`);
        resolve({ ...c, verification: { ...v, model: MODEL, cost_usd: meta.total_cost_usd ?? null } });
      } catch (e) {
        console.log(`[verify] ${idx} ${c.bucket}: FAILED`);
        resolve({ ...c, verification: { answer: 'UNVERIFIABLE', confidence: 0, settlement_record: '', sources: [], criteria_are_unambiguous: false, notes: `verifier failed: ${e.message}`, model: MODEL, cost_usd: null } });
      }
    });
  });
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); }
  }));
  return results;
}

const src = JSON.parse(readFileSync(IN, 'utf8'));
const verified = await pool(src.candidates, CONCURRENCY, verify);
const cost = verified.reduce((a, v) => a + (v.verification.cost_usd ?? 0), 0);
writeFileSync(OUT, JSON.stringify({ ...src, verified_at: new Date().toISOString(), verifier_model: MODEL, verification_cost_usd: cost, candidates: verified }, null, 2));

const agree = verified.filter((v) => v.verification.answer === v.ground_truth).length;
console.log(`[verify] ${verified.length} verified, ${agree} agree with curator, $${cost.toFixed(2)} -> ${OUT}`);
