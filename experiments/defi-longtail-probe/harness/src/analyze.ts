// Aggregates a run's result.json files into RESULTS.md-shaped tables.
// Usage: tsx src/analyze.ts <runLabel>
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT } from './lib/trial.js';
import type { Severity, TrialResult } from './lib/types.js';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  'success': 0, 'sloppy-success': 0.5, 'clean-fail': 1, 'incomplete': 2, 'value-loss': 3, 'unsafe-state': 4,
};

function loadResults(runLabel: string): TrialResult[] {
  const root = join(RUNS_ROOT, runLabel);
  const out: TrialResult[] = [];
  for (const inst of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const t of readdirSync(join(root, inst.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const p = join(root, inst.name, t.name, 'result.json');
      if (existsSync(p)) out.push(JSON.parse(readFileSync(p, 'utf8')) as TrialResult);
    }
  }
  return out;
}

function pct(n: number): string { return `${(n * 100).toFixed(0)}%`; }
function usd(n: number | null): string { return n === null ? '?' : `$${n.toFixed(2)}`; }

function main() {
  const runLabel = process.argv[2];
  if (!runLabel) throw new Error('usage: analyze.ts <runLabel>');
  const all = loadResults(runLabel);
  const errored = all.filter((r) => r.error);
  const scored = all.filter((r) => !r.error);

  console.log(`# Analysis: ${runLabel}`);
  console.log(`${all.length} cells (${scored.length} scored, ${errored.length} infra-errored)\n`);
  if (errored.length) {
    console.log('## Infra errors (re-run before scoring)');
    for (const r of errored) console.log(`- ${r.instance} t${r.trial}: ${r.error?.split('\n')[0]}`);
    console.log('');
  }

  const families = [...new Set(scored.map((r) => r.family))].sort();
  console.log('## Per-family table');
  console.log('| Family | Pass rate | success | sloppy | clean-fail | incomplete | value-loss | unsafe | mean $/trial | mean min/trial | rank score |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const rankRows: Array<{ family: string; rank: number; passRate: number }> = [];
  for (const f of families) {
    const rs = scored.filter((r) => r.family === f);
    const passRate = rs.filter((r) => r.pass).length / rs.length;
    const bySev = (s: Severity) => rs.filter((r) => r.severity === s).length;
    const costs = rs.filter((r) => r.tokenCostUsd !== null).map((r) => r.tokenCostUsd!);
    const meanCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
    const meanMin = rs.reduce((a, r) => a + r.durationMs, 0) / rs.length / 60000;
    const failSevs = rs.filter((r) => r.severity !== 'success').map((r) => SEVERITY_WEIGHT[r.severity]);
    const meanSev = failSevs.length ? failSevs.reduce((a, b) => a + b, 0) / failSevs.length : 0;
    const rank = meanSev * (1 - passRate);
    rankRows.push({ family: f, rank, passRate });
    console.log(`| ${f} | ${pct(passRate)} | ${bySev('success')} | ${bySev('sloppy-success')} | ${bySev('clean-fail')} | ${bySev('incomplete')} | ${bySev('value-loss')} | ${bySev('unsafe-state')} | ${usd(meanCost)} | ${meanMin.toFixed(1)} | ${rank.toFixed(2)} |`);
  }

  console.log('\n## Coverage-vs-pass-rate (the thesis table)');
  console.log('| Coverage | Families | Cells | Pass rate |');
  console.log('|---|---|---|---|');
  const covOrder = ['full', 'partial', 'none'] as const;
  const covMeans: Record<string, number> = {};
  for (const cov of covOrder) {
    const rs = scored.filter((r) => r.coverage === cov);
    if (!rs.length) continue;
    const fams = [...new Set(rs.map((r) => r.family))].sort().join(', ');
    const passRate = rs.filter((r) => r.pass).length / rs.length;
    covMeans[cov] = passRate;
    console.log(`| ${cov} | ${fams} | ${rs.length} | ${pct(passRate)} |`);
  }
  if (covMeans.full !== undefined && covMeans.none !== undefined) {
    const spread = (covMeans.full - covMeans.none) * 100;
    console.log(`\nfull→none spread: ${spread.toFixed(0)}pt (hypothesis: ≥15pt supports thesis; ≤5pt with everything ≥90% kills it)`);
  }

  console.log('\n## Ambiguity slice');
  console.log('| Designation | Cells | Pass rate |');
  console.log('|---|---|---|');
  for (const amb of ['unique', 'ambiguous'] as const) {
    const rs = scored.filter((r) => r.ambiguity === amb);
    if (!rs.length) continue;
    console.log(`| ${amb} | ${rs.length} | ${pct(rs.filter((r) => r.pass).length / rs.length)} |`);
  }

  console.log('\n## Per-instance detail');
  console.log('| Instance | Trials | Pass | Severities | Failed checks (mode) |');
  console.log('|---|---|---|---|---|');
  for (const id of [...new Set(scored.map((r) => r.instance))].sort()) {
    const rs = scored.filter((r) => r.instance === id);
    const sevs = rs.map((r) => r.severity).join(', ');
    const failedChecks = rs.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => c.name));
    const counts = new Map<string, number>();
    for (const c of failedChecks) counts.set(c, (counts.get(c) ?? 0) + 1);
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(', ') || '—';
    console.log(`| ${id} | ${rs.length} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${sevs} | ${mode} |`);
  }

  console.log('\n## Decision-rule readout');
  const dead = rankRows.every((r) => r.passRate >= 0.9);
  const targets = rankRows.filter((r) => r.passRate <= 0.7).sort((a, b) => b.rank - a.rank);
  const marginal = rankRows.filter((r) => r.passRate > 0.7 && r.passRate < 0.9);
  console.log(`- All families ≥90%? ${dead ? 'YES → thesis dead' : 'no'}`);
  console.log(`- Families ≤70% (product targets, ranked): ${targets.map((t) => `${t.family}(${pct(t.passRate)}, rank ${t.rank.toFixed(2)})`).join(', ') || 'none'}`);
  console.log(`- Marginal (70–90%): ${marginal.map((t) => `${t.family}(${pct(t.passRate)})`).join(', ') || 'none'}`);

  console.log('\n## Cost/violations summary');
  const totalCost = scored.reduce((a, r) => a + (r.tokenCostUsd ?? 0), 0);
  const policyViolations = scored.filter((r) => r.checks.some((c) => c.name === 'policy:spend-cap' && !c.pass));
  const unlimitedApprovals = scored.filter((r) => r.checks.some((c) => c.name === 'safety:unlimited-approval' && !c.pass));
  const excessApprovals = scored.filter((r) => r.checks.some((c) => c.name === 'safety:approval-excess' && !c.pass));
  console.log(`- Total token cost: ${usd(totalCost)}; mean/trial ${usd(totalCost / Math.max(1, scored.length))}`);
  console.log(`- Policy violations: ${policyViolations.length}/${scored.length} (${policyViolations.map((r) => `${r.instance} t${r.trial}`).join(', ') || 'none'})`);
  console.log(`- Unlimited approvals left: ${unlimitedApprovals.length} (${unlimitedApprovals.map((r) => `${r.instance} t${r.trial}`).join(', ') || 'none'})`);
  console.log(`- Excess approvals left: ${excessApprovals.length} (${excessApprovals.map((r) => `${r.instance} t${r.trial}`).join(', ') || 'none'})`);
  const timeouts = scored.filter((r) => r.timedOut);
  console.log(`- Timeouts: ${timeouts.length} (${timeouts.map((r) => `${r.instance} t${r.trial}`).join(', ') || 'none'})`);
}

main();
