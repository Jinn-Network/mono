#!/usr/bin/env bash
# Read-only learning-loop measurement for the hosted claude-code-learner box.
#
# Answers the two "measure first" questions from
# docs/superpowers/plans/ (foundation-for-self-improvement):
#   1. Loop-completion rate — of all harness runs, what fraction reach the
#      post-execute learning phases (improve / memory-consolidation) vs. stop
#      at execute-only? This decides the deferred steer-vs-enforce question.
#   2. impl-state commit cadence — how many durable commits the learner's
#      self-state git repo has accumulated (per SolverNet). After the Layer-1
#      persistence fix this should be NON-DECREASING across container restarts.
#
# Pure read-only: opens /data/jinn.db readonly and runs `git log` against the
# impl-state repos. Makes no writes. Run from the repo root:
#
#     railway link --project jinn-operator-claude-1 --environment production --service operator
#     deploy/railway-launcher-operator/measure-learning.sh
#
# railway-ssh quirks (see memory hosted-claude-operator-railway): the first
# token is mangled, so the remote command leads with `echo GO;`; the node
# program is shipped base64-encoded and decoded to a temp file (piping into
# `node` over stdin is unreliable on this transport).
set -euo pipefail

# ── The remote measurement program ───────────────────────────────────────────
read -r -d '' REMOTE_JS <<'JS' || true
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/data/jinn.db', { readonly: true, fileMustExist: true });

// task_runs.solution_outputs_json is a serialised Solution; gating.phasesCompleted
// is the array of learner phases that produced a primary artifact this run
// (client/src/harnesses/impls/learner/harvest.ts:516-517).
const rows = db.prepare(
  `SELECT request_id, state, task_role, attempt_index, run_started_at,
          solution_outputs_json, delivery_tx_hash
     FROM task_runs ORDER BY run_started_at DESC`
).all();

const POST_EXEC = ['debrief', 'improve', 'memory-consolidation'];
let total = 0, withGating = 0, reachedExecute = 0, reachedImprove = 0,
    reachedMemory = 0, fullLoop = 0, delivered = 0;
const phaseCounts = {};
const recent = [];
for (const r of rows) {
  total++;
  if (r.delivery_tx_hash) delivered++;
  let phases = [];
  try {
    const s = JSON.parse(r.solution_outputs_json || '{}');
    phases = (s.gating && Array.isArray(s.gating.phasesCompleted)) ? s.gating.phasesCompleted : [];
  } catch { /* malformed/absent — counts as no-gating */ }
  if (phases.length) withGating++;
  for (const p of phases) phaseCounts[p] = (phaseCounts[p] || 0) + 1;
  const has = (p) => phases.includes(p);
  if (has('execute')) reachedExecute++;
  if (has('improve')) reachedImprove++;
  if (has('memory-consolidation')) reachedMemory++;
  if (has('improve') && has('memory-consolidation')) fullLoop++;
  if (recent.length < 20) {
    recent.push({
      role: r.task_role, att: r.attempt_index, state: r.state,
      delivered: !!r.delivery_tx_hash,
      phases: phases.length ? phases.join('>') : '(none)',
    });
  }
}
const pct = (n) => total ? `${((100 * n) / total).toFixed(1)}%` : 'n/a';
console.log('=== loop-completion over ' + total + ' task_runs ===');
console.log('  delivered            :', delivered, '(' + pct(delivered) + ')');
console.log('  with gating payload  :', withGating, '(' + pct(withGating) + ')');
console.log('  reached execute      :', reachedExecute, '(' + pct(reachedExecute) + ')');
console.log('  reached improve      :', reachedImprove, '(' + pct(reachedImprove) + ')');
console.log('  reached memory-consol:', reachedMemory, '(' + pct(reachedMemory) + ')');
console.log('  FULL loop (impr+mem) :', fullLoop, '(' + pct(fullLoop) + ')   <-- self-improvement completions');
console.log('  phase artifact counts:', JSON.stringify(phaseCounts));
console.log('=== most recent ' + recent.length + ' runs (newest first) ===');
for (const x of recent) {
  console.log('  [' + (x.role || '?') + ' att' + (x.att ?? '?') + '] ' +
    x.state + (x.delivered ? ' delivered' : '') + '  phases=' + x.phases);
}
db.close();
JS

REMOTE_B64="$(printf '%s' "$REMOTE_JS" | base64 | tr -d '\n')"

# ── Remote shell: DB stats, then impl-state commit cadence ────────────────────
# IMPL_ROOT prefers the volume path (Layer-1 persistence target); falls back to
# the legacy ephemeral $HOME path so the script is useful before/after redeploy.
REMOTE_SH="echo GO;
printf '%s' '${REMOTE_B64}' | base64 -d > /tmp/measure-learning.js;
node /tmp/measure-learning.js;
echo;
echo '=== impl-state commit cadence (durable self-state) ===';
git config --global --add safe.directory '*' 2>/dev/null || true;
IMPL_ROOT=/data/engine/impl-state;
[ -d \"\$IMPL_ROOT\" ] || IMPL_ROOT=/home/node/.jinn-client/engine/impl-state;
echo \"impl-state root: \$IMPL_ROOT\";
if [ -d \"\$IMPL_ROOT\" ]; then
  find \"\$IMPL_ROOT\" -maxdepth 3 -name .git -type d | while read -r g; do
    repo=\$(dirname \"\$g\");
    n=\$(git -C \"\$repo\" rev-list --count HEAD 2>/dev/null || echo '?');
    last=\$(git -C \"\$repo\" --no-pager log -1 --format='%h %s' 2>/dev/null || echo 'no commits');
    echo \"  \$repo : \$n commits  (HEAD: \$last)\";
  done;
else
  echo '  (no impl-state dir yet)';
fi"

railway ssh "$REMOTE_SH"
