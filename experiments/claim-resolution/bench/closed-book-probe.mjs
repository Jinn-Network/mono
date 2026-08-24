/**
 * Stage 3 — contamination probe.
 *
 * Runs each claim through a solver with NO web access at all. Anything a
 * closed-book model answers correctly and confidently is either already in its
 * parametric memory or is being given away by the wording of the claim and
 * criteria. Those items cannot demonstrate anything about web research, so they
 * are flagged (and reported separately in the results).
 *
 *   node bench/closed-book-probe.mjs --in bench/verified.json --out bench/closed-book.json
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema/solver-output.schema.json'), 'utf8');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in', join(ROOT, 'bench/verified.json'));
const OUT = arg('--out', join(ROOT, 'bench/closed-book.json'));
const MODEL = arg('--model', 'claude-sonnet-5');
const CONCURRENCY = Number(arg('--concurrency', '10'));

const SYSTEM = `You resolve factual claims. You have NO web access and no tools.

Answer from your own knowledge and from the wording of the claim and criteria
alone. If you do not actually know the outcome, set abstain=true and answer
UNRESOLVABLE — do not guess, and do not reason from base rates. Leave evidence
empty. confidence must reflect genuine recall, not plausibility.`;

function probe(c, idx) {
  const prompt = [
    `CLAIM: ${c.claim}`, '',
    `RESOLUTION CRITERIA: ${c.criteria}`, '',
    `RESOLUTION DEADLINE: ${c.deadline}`, '',
    'How did this resolve?',
  ].join('\n');
  const args = [
    '-p', '--model', MODEL, '--system-prompt', SYSTEM,
    '--tools', '', '--setting-sources', '', '--no-session-persistence',
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
    const t = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', () => {
      clearTimeout(t);
      try {
        const meta = JSON.parse(out);
        const p = JSON.parse(meta.result);
        const correct = !p.abstain && p.answer === c.ground_truth;
        if (idx % 20 === 0) console.log(`[closed-book] ${idx}`);
        resolve({ answer: p.answer, confidence: p.confidence, abstain: p.abstain, correct, cost_usd: meta.total_cost_usd ?? 0 });
      } catch {
        resolve({ answer: null, confidence: null, abstain: null, correct: null, cost_usd: 0, error: true });
      }
    });
  });
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const src = JSON.parse(readFileSync(IN, 'utf8'));
const probes = await pool(src.candidates, CONCURRENCY, probe);
const withProbe = src.candidates.map((c, i) => ({ ...c, closed_book: probes[i] }));
const cost = probes.reduce((a, p) => a + (p.cost_usd ?? 0), 0);
writeFileSync(OUT, JSON.stringify({ ...src, closed_book_model: MODEL, closed_book_cost_usd: cost, candidates: withProbe }, null, 2));
const hits = probes.filter((p) => p.correct).length;
const conf = probes.filter((p) => p.correct && (p.confidence ?? 0) >= 0.8).length;
console.log(`[closed-book] ${probes.length} probed: ${hits} correct closed-book (${conf} at conf>=0.8), $${cost.toFixed(2)} -> ${OUT}`);
