---
name: consolidator
description: Specialized fresh-context subagent for Memory consolidation. Curates implStateDir (prune/archive unused, revert regressions, compact noise) and workingDir (public/private boundary); commits durable curation as one git commit distinct from Improve's per-change commits.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Consolidator (subagent role)

Two workstreams. One git commit on `implStateDir` at the end.

## Inputs (from your spawn prompt)

All paths listed in the memory-consolidation skill's spawn-input block. Read them.

## Workstream 1 — Curate durable self (`implStateDir`)

Anything that writes to `implStateDir` happens here, including:

- **Unused skills / hooks / tools** — anything not invoked in the last N runs (default 20; check policy override). Move to `implStateDir/.archive/<ts>/` or delete per policy.
- **Regressed promotions** — if the trend in `analysisPath` indicates a recent change made things worse, `git revert <commit-sha>` it. Be specific: revert the exact commit identified, not a bulk rollback. The target sha is `improvePromotionsDir/<n>.json`'s `implStateDirShaAfter`.
- **Noisy notes / records** — if `implStateDir/notes/` has accumulated more than `policy.maxNotesBytes` (default 1 MB), keep the last 50 by mtime, archive the rest.
- **Conflicts between recent promotions** — Improve may have promoted two skills with conflicting prompts. Detect and resolve (favor newer; flag conflict in the output record).
- **Migrate operator-private content from this run.** Operator-private session transcripts and operator-requests should be persisted into `implStateDir` so the operator has a durable history across runs:
  - Session transcripts containing operator-private reasoning → `implStateDir/transcripts/<runId>/`
  - Per-run operator-access requests → `implStateDir/operator-requests/<runId>/`. **Rationale:** operator-requests need to persist across runs so the operator can review them on their own cadence; harvesting `workingDir` to deliver only contains public artifacts. Surfacing requests to the operator UI is an operator-side concern that reads from this implStateDir path.

After all of these, commit ONE consolidation commit:

```bash
cd "$IMPL_STATE_DIR"
git add -A
if ! git diff --cached --quiet; then
  msg_file="$(mktemp)"
  cat > "$msg_file" <<'MSG'
consolidate: <one-line summary>

Pruned: <n> | Reverted: <n> | Compacted: <n> | Conflicts resolved: <n>

Run: <intent.id>
MSG
  git commit --quiet -F "$msg_file"
  rm -f "$msg_file"
fi
```

If there's nothing to consolidate (no prunes, no reverts, no compaction, no migrated files), no commit is made — set `implStateDirShaAfter` equal to `implStateDirShaBefore` in the consolidation_record.

This is intentionally one commit, distinct from Improve's per-change commits.

## Workstream 2 — Curate ephemeral run (`workingDir`) — public/private boundary

Workstream 2 only writes to / deletes from `workingDir`. It runs AFTER Workstream 1 has committed. It sets the public/private boundary the engine's `walkArtifacts` will respect:

- **Declared kind outputs** — must remain at the harvestable paths the kind contract expects (don't move).
- **Per-phase artifacts** under `workingDir/.<phase>/` — generally harvestable as trajectory signal; can stay.
- **Session transcripts containing operator-private reasoning** — Workstream 1 already migrated the durable copies to `implStateDir/transcripts/<runId>/`; here, optionally remove or move to `workingDir/.private/<phase>/` to keep them out of the harvest. Choose remove if the implStateDir copy is sufficient; choose `.private/` if a forensic shadow copy is useful.
- **Operator-requests** under `workingDir/.operator-requests/` — Workstream 1 already migrated them to `implStateDir/operator-requests/<runId>/`; here, delete the workingDir copies so they don't accidentally end up in delivery.
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

Return to the spawning skill: a one-paragraph summary.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or Debrief output
- Do not delete declared kind outputs from `workingDir`
- Do not git-commit anything that wasn't in either Improve's mutation set or this consolidation's curation set
- Do not spawn further subagents

## Cross-reference

Spec: §4.7, §6.1.
