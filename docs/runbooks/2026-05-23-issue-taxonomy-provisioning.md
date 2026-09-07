# Issue taxonomy provisioning (2026-05-23)

**Runbook owner:** Captain
**Status:** authoritative post-state until DR-2026-05-20-b lands on disk (forward reference — that DR file + the matching handbook.md / CLAUDE.md / issue-template revisions ship via #424 / PR #433 on the sibling canon-revision branch).

This runbook records what was provisioned in the GitHub UI on `Jinn-Network` as part of the DR-2026-05-20-b taxonomy redesign, and how to re-derive it. It is the source of truth for the post-state until the matching canon revision merges.

## 1. Issue Types provisioned

Nine org-level Issue Types are enabled on `Jinn-Network`:

- `feat` — feature work.
- `fix` — bug fix.
- `refactor` — architecture / migration.
- `spike` — research / exploration.
- `chore` — deps, CI, dev tooling, taxonomy / provisioning work.
- `docs` — documentation.
- `test` — test-only.
- `incident` — hotfix sub-flow.
- `design` — design-only session whose output is a spec or DR.

GitHub's per-org Issue Type cap was not hit (all nine fit). Each Issue Type maps 1:1 to the work-shape taxonomy in the engineering handbook (lands via PR #433).

To re-verify from the CLI:

```bash
gh api graphql -f query='
  query($login: String!) {
    organization(login: $login) {
      issueTypes(first: 20) { nodes { name } }
    }
  }
' -f login=Jinn-Network
```

Expected: nine names in the list above.

## 2. Project fields provisioned

Three single-select fields on the "Jinn engineering" Project (v2), project number `1` on `Jinn-Network`:

- **Blocked on** — `Nothing` / `Human` / `Another issue`. Default for new items: `Nothing`.
- **Effort** — `Low` / `Medium` / `High`. Default for new items: `Medium`.
- **Priority** — `P0` / `P1` / `P2` / `P3` / `P4`. Default for new items: `P2`.

The ready queue consults the **Blocked on** field; only items with `Blocked on = Nothing` are pickup-eligible. **Priority** and **Effort** are ranking / surfacing inputs (see [`docs/engineering/handbook.md`](../engineering/handbook.md) §Routing axes — Project fields).

To re-verify from the CLI:

```bash
gh project field-list 1 --owner Jinn-Network --format json | jq '.fields[] | {name, dataType, options: .options.options // null}'
```

Expected: each of the three field names appears with `dataType = SINGLE_SELECT` and the option list above.

## 3. Board-grouping verdict — sub-issue parent vs Epic field

GitHub Projects (v2) added native sub-issue support in 2026; the question is whether the board can group / roadmap by sub-issue parent, in which case the Project's `Epic` field is redundant and can be retired.

**Captain action:** open the board in the browser and inspect the grouping options:

```bash
gh project view 1 --owner Jinn-Network --web
```

On the board view, click the group-by selector. Record the verdict here:

- [ ] **Verdict — board grouping by sub-issue parent works:** retire the `Epic` Project field. Run the deletion via the GitHub UI (Project settings → Fields → Epic → Delete) and record the date and Captain handle below.
- [ ] **Verdict — board grouping by sub-issue parent does NOT work:** retain the `Epic` field as a documented derived projection (it duplicates the sub-issue parent for the sole purpose of board grouping). Record that decision below.

Recorded verdict: _(Captain fills this in after inspection.)_

## 4. Labels retired

The following labels were retired as part of the cutover. The list is explicit; the migration script in §5 consumes this list verbatim from a bash array near the top of the file.

- `sprint:2026-05-18`
- `sprint:2026-05-25`
- `sprint:sprint-1`
- `sprint:sprint-2`
- `agent:opus`
- `agent:ritsu.kai2000@gmail.com`
- `bug`
- `enhancement`
- `documentation`

Notes:

- `priority:*` labels were absent at cutover (no-op — no labels matching `priority:*` existed on `Jinn-Network/mono`).
- `epic:*` labels are retained pending the board-grouping verdict in §3. The DR-2026-05-18 convention already retired them; if §3 verdict is "retire Epic field", a follow-up sweep can also retire the `epic:*` labels.
- The retirement is **delete**, not rename, because the legacy values do not map forward: `sprint:2026-05-18` is a date value that belongs on the Project Iteration, not on a renamed label.

To re-verify which labels exist:

```bash
gh label list --repo Jinn-Network/mono --json name --limit 200 | jq -r '.[] | .name' | sort
```

Expected after a successful run of `scripts/migrate-issue-taxonomy.sh retire-labels --apply -y`: none of the nine labels above appear in the list.

## 5. Re-runnable backfill SOP

Backfill is owned by `scripts/migrate-issue-taxonomy.sh` — a single bash script with five subcommands, a global `--dry-run` default, and an explicit `--apply` flag.

Subcommands:

- `list-missing-type` — read-only; lists open Issues with no Issue Type.
- `backfill-type` — for each open Issue without an Issue Type, suggest a type from (a) the legacy default labels `bug` → `fix`, `enhancement` → `feat`, `documentation` → `docs`, or (b) the Issue body's `## Run-mode` line if it matches one of the nine shapes. Issues with neither signal are surfaced for hand-assignment. The `--apply` mutation path is intentionally deferred — see "Manual apply path" below for the explicit GraphQL mutation shape an operator runs by hand.
- `list-missing-fields` — read-only; lists open Issues on Project 1 missing any of the three single-select fields.
- `backfill-fields` — suggests defaults `Blocked on: Nothing`, `Effort: Medium`, `Priority: P2`. The `--apply` mutation path is intentionally deferred — see "Manual apply path" below for the explicit GraphQL mutation shape an operator runs by hand.
- `retire-labels` — deletes the nine labels from §4 via `gh label delete`. Absent labels are treated as success.

Execution order, with the rate-limit window in mind (the GraphQL quota was exhausted during the discovery pass that produced this runbook — batches must respect the quota):

```bash
# 1. Dry-run pass to audit what will change.
bash scripts/migrate-issue-taxonomy.sh list-missing-type
bash scripts/migrate-issue-taxonomy.sh list-missing-fields
bash scripts/migrate-issue-taxonomy.sh retire-labels

# 2. Apply, one subcommand at a time, with a rate-limit window between batches.
bash scripts/migrate-issue-taxonomy.sh backfill-type --apply     # suggests; mutation path deferred — see below
bash scripts/migrate-issue-taxonomy.sh backfill-fields --apply   # suggests; mutation path deferred — see below
bash scripts/migrate-issue-taxonomy.sh retire-labels --apply -y
```

The script runs a GraphQL rate-limit probe (`{ rateLimit { remaining resetAt } }`) before each mutation batch. If `remaining < 200`, it prints the `resetAt` time and exits 0 cleanly — re-run after the window. The dry-run path performs no batching (no mutations are issued). The `--apply` paths for `backfill-type` and `backfill-fields` are currently deferred to the "Manual apply path" sections below; when those paths land in-script, the documented intent is chunks of 25 items with a 30s sleep between chunks, with each batch independently resumable because every subcommand is idempotent (assignments are checked before mutation, label deletes treat-absent-as-success). The `retire-labels --apply` path is in-script today and is naturally per-label-idempotent — absent labels are treated as success — so an interrupted run can simply be re-invoked.

### Manual apply path — Issue Type backfill

The `backfill-type --apply` mutation path is deferred in-script because it requires a two-step ID resolution (org Issue Type name → ID, plus Issue number → node ID) that the operator typically runs once and then loops. The mutation shape:

```bash
# Step 1: resolve org-level Issue Type IDs once.
gh api graphql -f query='
  query($login: String!) {
    organization(login: $login) {
      issueTypes(first: 20) { nodes { id name } }
    }
  }
' -f login=Jinn-Network | jq '.data.organization.issueTypes.nodes'

# Step 2: for each Issue (e.g. #425), resolve its node ID and assign the type.
ISSUE_NODE_ID="$(gh issue view 425 --repo Jinn-Network/mono --json id --jq .id)"
TYPE_ID="<the id for 'chore' from step 1>"
gh api graphql -f query='
  mutation($issueId: ID!, $typeId: ID!) {
    updateIssueIssueType(input: {issueId: $issueId, issueTypeId: $typeId}) {
      issue { number issueType { name } }
    }
  }
' -f issueId="$ISSUE_NODE_ID" -f typeId="$TYPE_ID"
```

Run `bash scripts/migrate-issue-taxonomy.sh backfill-type` (no `--apply`) first to get the suggested-type list, then loop the mutation above per Issue.

### Manual apply path — Project (v2) field backfill

The `backfill-fields --apply` mutation path is deferred in-script for the same reason: it requires a one-time resolution of project ID + field IDs + option IDs (per field), then a loop over items. The mutation shape:

```bash
# Step 1: resolve project + field + option IDs once.
gh project field-list 1 --owner Jinn-Network --format json \
  | jq '.fields[] | select(.name == "Blocked on" or .name == "Effort" or .name == "Priority")
                  | {name, id, options: .options.options}'

# Step 2: for each item missing a field value, set it.
PROJECT_ID="<projectV2 id>"
ITEM_ID="<item id>"
FIELD_ID="<single-select field id>"
OPTION_ID="<option id for the desired value (e.g. Nothing / Medium / P2)>"
gh api graphql -f query='
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId,
      itemId: $itemId,
      fieldId: $fieldId,
      value: { singleSelectOptionId: $optionId }
    }) { projectV2Item { id } }
  }
' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$FIELD_ID" -f optionId="$OPTION_ID"
```

Run `bash scripts/migrate-issue-taxonomy.sh list-missing-fields` to get the per-item / per-field gap list, then loop the mutation above per gap. Skip-if-already-set is enforced by the read-check above; running the mutation against an already-set value is harmless.

**DR gate:** This runbook depends on DR-2026-05-20-b being ratified. The DR was ratified at commit `b28e59d4` (lands on disk via PR #433); the gate is cleared.
