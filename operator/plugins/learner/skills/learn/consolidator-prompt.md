---
description: Specialized fresh-context subagent for Memory consolidation. Curates the run's write-target state dir (prune/archive unused, revert regressions, compact noise) and workingDir (public/private boundary); commits durable curation as one git commit distinct from Improve's per-change commits.
tools: Bash, Read, Write, Edit, Glob, Grep
---

# Consolidator (subagent role)

Two workstreams. One git commit on `stateDir` at the end.

## Inputs (from your spawn prompt)

All paths listed in the memory-consolidation skill's spawn-input block. Read them.

Two of them decide where you write:

- `stateDir` — **your only write target** for Workstream 1.
- `implStateDir` — the operator's active policy. In `train` mode it is the same path as `stateDir`. In `candidate` mode it is a **different, read-only** path: this run is producing a proposal that will later be measured against the policy it came from, so writing to `implStateDir` would change the thing being measured and cause the harness to discard the run. The harness verifies `implStateDir` is byte-identical when you finish.

## Workstream 1 — Curate durable self (`stateDir`)

Anything that writes to `stateDir` happens here, including:

- **Unused skills / hooks / tools** — anything not invoked in the last N runs (default 20; check policy override). Move to `stateDir/.archive/<ts>/` or delete per policy.
- **Regressed promotions** — revert an Improve commit only when it actually made things worse. There are two triggers; act on either:
  1. **Qualitative trigger** — if the trend in `analysisPath` (the Debrief signal) indicates a recent change made things worse, `git revert <commit-sha>` it. Be specific: revert the exact commit identified, not a bulk rollback. The target sha is `improvePromotionsDir/<n>.json`'s `implStateDirShaAfter`.
  > The graded score (Tier 2) lowers the variance of the keep/revert decision only.
  > It never overrules the binary verdict, and it MUST NOT be used to size on-chain
  > reward — that path is gated on the withheld-test challenge (#1019, design §5.5).

  2. **Quantitative trigger (#764) — RETIRED, do not attempt.** This step used to
     shell out to `jinn codedigest-revert-check` to ask the network-truth indexer
     whether a candidate Improve commit's per-codeDigest pass rate had regressed
     against its parent's. That CLI was retired by one-swap R3b (issue #2494).
     It is not a behavior change you need to compensate for: the HTTP indexer
     serves **no authenticated reward rows** for this read, so the check could
     only ever answer `insufficient_samples` — i.e. "do not revert". Trigger 1
     above is the sole revert path. Do **not** substitute a hand-rolled
     codeDigest hash, a hand-rolled statistical test, or any other CLI for it;
     record `reason: "quantitative_trigger_retired"` on any
     `promotionsReverted[]` entry you would otherwise have justified this way.

  **Thresholds** for the retired quantitative trigger remain documented in `operator/src/learner/revert-decision.ts` (`min-samples = 30` per arm, `alpha = 0.05`, `window = 200`) for whoever re-backs that read on an authenticated source. They are **not** actionable from this prompt today — there is no CLI to invoke and you must not re-derive them here.
- **Noisy notes / records** — if `stateDir/notes/` has accumulated more than `policy.maxNotesBytes` (default 1 MB), keep the last 50 by mtime, archive the rest.
- **Conflicts between recent promotions** — Improve may have promoted two skills with conflicting prompts. Detect and resolve (favor newer; flag conflict in the output record).
- **Migrate operator-private content from this run.** Operator-private session transcripts and operator-requests should be persisted into `stateDir` so the operator has a durable history across runs:
  - Session transcripts containing operator-private reasoning → `stateDir/transcripts/<runId>/`
  - Per-run operator-access requests → `stateDir/operator-requests/<runId>/`. **Rationale:** operator-requests need to persist across runs so the operator can review them on their own cadence; harvesting `workingDir` to deliver only contains public artifacts. Surfacing requests to the operator UI is an operator-side concern that reads from this state-dir path.

After all of these, commit ONE consolidation commit:

```bash
STATE_DIR="<stateDir from spawn input>"
cd "$STATE_DIR"
git add -A
if ! git diff --cached --quiet; then
  msg_file="$(mktemp)"
  cat > "$msg_file" <<'MSG'
consolidate: <one-line summary>

Pruned: <n> | Reverted: <n> | Compacted: <n> | Conflicts resolved: <n>

Run: <goal.id>
MSG
  git commit --quiet -F "$msg_file"
  rm -f "$msg_file"
fi
```

If there's nothing to consolidate (no prunes, no reverts, no compaction, no migrated files), no commit is made — set `implStateDirShaAfter` equal to `implStateDirShaBefore` in the consolidation_record.

This is intentionally one commit, distinct from Improve's per-change commits.

## Workstream 2 — Curate ephemeral run (`workingDir`) — public/private boundary

Workstream 2 only writes to / deletes from `workingDir`. It runs AFTER Workstream 1 has committed. It sets the public/private boundary the harness's artifact harvester will respect:

- **Declared kind outputs** — must remain at the harvestable paths the kind contract expects (don't move).
- **Per-phase artifacts** under `workingDir/.<phase>/` — generally harvestable as trajectory signal; can stay.
- **Session transcripts containing operator-private reasoning** — Workstream 1 already migrated the durable copies to `stateDir/transcripts/<runId>/`; here, optionally remove or move to `workingDir/.private/<phase>/` to keep them out of the harvest. Choose remove if the state-dir copy is sufficient; choose `.private/` if a forensic shadow copy is useful.
- **Operator-requests** under `workingDir/.operator-requests/` — Workstream 1 already migrated them to `stateDir/operator-requests/<runId>/`; here, delete the workingDir copies so they don't accidentally end up in delivery.
- **Errors** under `workingDir/.errors/` — keep public (buyers benefit from honest failure signal).

## Output

Write `<outputPath>`:

```json
{
  "ts": <unix-ms>,
  "implStateDirShaBefore": "<read improveSummaryPath.implStateDirShaAfter>",
  "implStateDirShaAfter": "<git rev-parse HEAD post-consolidation-commit>",
  "durable": {
    "skillsArchived": ["string", "..."],
    "promotionsReverted": [{ "sha": "<commit>", "reason": "string" }],
    "notesCompacted": <count>,
    "conflictsResolved": [{ "what": "string", "resolution": "string" }]
  },
  "ephemeral": {
    "movedToPrivate": ["string", "..."],
    "migratedToImplState": ["string", "..."]
  }
}
```

Return to the dispatching section of `skills/learn/SKILL.md`: a one-paragraph summary.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or Debrief output
- Do not delete declared kind outputs from `workingDir`
- Do not git-commit anything that wasn't in either Improve's mutation set or this consolidation's curation set
- Do not spawn further subagents
- In `candidate` mode, never write to `implStateDir` — `stateDir` is a different directory and the only one you may touch

## Cross-reference

Spec: §4.7, §6.1.
