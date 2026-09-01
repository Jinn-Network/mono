# gh taxonomy reference — file-issue skill

> **Prerequisite:** This recipe assumes the DR-2026-05-20-b Project fields
> (`Blocked on`, `Effort`, `Priority`) are provisioned on the "Jinn engineering"
> Project. They are confirmed provisioned as of 2026-05-21. If re-running after
> a field rebuild, re-discover field and option ids at run time (Step 4).

---

## Step 1 — Repo + Project constants

| Constant | Value |
|----------|-------|
| Repo | `Jinn-Network/mono` |
| Project number | `1` |
| Project owner | `Jinn-Network` |
| Project node id | `PVT_kwDODh3-Ac4BXYaI` (for `item-edit --project-id`) |

If `gh project item-list 1 --owner Jinn-Network` errors with "project not
found", the number has changed. Rediscover it:

```bash
gh project list --owner Jinn-Network --format json
```

Read the `number` and `id` fields from the matching `"Jinn engineering"` entry.

---

## Step 2 — Create the issue with its Issue Type

### Check gh version

```bash
gh --version
```

As of 2026-05-21 the installed version is **2.78.0**. Despite being above 2.63,
`gh issue create` in this build does **not** expose a `--type` flag — the flag
did not ship to the `issue create` subcommand in the `gh` CLI at this version.
Use the **GraphQL mutation** path below for all Issue Type assignment.

### Discover Issue Type node ids (do this at run time)

```bash
gh api graphql -f query='
{
  organization(login: "Jinn-Network") {
    issueTypes(first: 20) {
      nodes { id name }
    }
  }
}'
```

The nine types and their node ids as of 2026-05-21:

| Issue Type | Node id |
|------------|---------|
| `chore`    | `IT_kwDODh3-Ac4BvpyJ` |
| `fix`      | `IT_kwDODh3-Ac4BvpyK` |
| `feat`     | `IT_kwDODh3-Ac4BvpyL` |
| `refactor` | `IT_kwDODh3-Ac4CAgNe` |
| `spike`    | `IT_kwDODh3-Ac4CAgNf` |
| `docs`     | `IT_kwDODh3-Ac4CAgNg` |
| `test`     | `IT_kwDODh3-Ac4CAgNh` |
| `incident` | `IT_kwDODh3-Ac4CAgNi` |
| `design`   | `IT_kwDODh3-Ac4CAgNm` |

> Node ids are more stable than names but can change if a type is deleted and
> recreated. Always re-query if a mutation returns an error on the issueTypeId.

### Write the body to a temp file, then create + assign Issue Type in one mutation

```bash
# Write body to a temp file
BODY_FILE=$(mktemp /tmp/issue-body-XXXXXX.md)
cat > "$BODY_FILE" << 'BODY'
**Context.** ...

**Impact.** ...

**Acceptance criteria.**
- [ ] ...

**Files/components.** ...
BODY

# Resolve repo node id (stable; re-query if uncertain)
REPO_ID=$(gh api graphql -f query='
  { repository(owner: "Jinn-Network", name: "mono") { id } }
' --jq '.data.repository.id')

# Set ISSUE_TYPE_ID to the node id from the table above, e.g.:
ISSUE_TYPE_ID="IT_kwDODh3-Ac4BvpyK"   # fix

TITLE="<title>"

# Create the issue and assign Issue Type atomically
RESULT=$(gh api graphql -f query='
mutation($repoId: ID!, $title: String!, $body: String!, $issueTypeId: ID!) {
  createIssue(input: {
    repositoryId: $repoId,
    title: $title,
    body: $body,
    issueTypeId: $issueTypeId
  }) {
    issue {
      number
      url
    }
  }
}' \
  -f repoId="$REPO_ID" \
  -f title="$TITLE" \
  -f body="$(cat "$BODY_FILE")" \
  -f issueTypeId="$ISSUE_TYPE_ID")

ISSUE_URL=$(echo "$RESULT" | jq -r '.data.createIssue.issue.url')
ISSUE_NUMBER=$(echo "$RESULT" | jq -r '.data.createIssue.issue.number')

echo "Created: $ISSUE_URL  (#$ISSUE_NUMBER)"
rm "$BODY_FILE"
```

Capture `$ISSUE_URL` and `$ISSUE_NUMBER` for Steps 3–5.

---

## Step 3 — Add the issue to the Project

Use `--format json` and extract the item id with `jq` (verified working
2026-07-02):

```bash
ITEM_ID=$(gh project item-add 1 --owner Jinn-Network --url "$ISSUE_URL" --format json | jq -r '.id')
echo "Item id: $ITEM_ID"
```

> **Do not** parse plain-text output. With the currently installed gh CLI,
> `gh project item-add` without `--format json` prints **nothing** to stdout
> (no `Added item: PVTI_...` line), so grepping for `PVTI_...` yields an empty
> `ITEM_ID`. The failure then surfaces one step later: every
> `gh project item-edit` call fails with
> `GraphQL: Could not resolve to a node with the global id of ''`.
> If you see that error, the item id extraction is the culprit — use the
> `--format json | jq -r '.id'` path above.

---

## Step 4 — Discover field and option ids

Run once per session (or whenever you suspect a field was rebuilt):

```bash
gh project field-list 1 --owner Jinn-Network --format json
```

From the JSON, extract the three routing fields. As of 2026-05-21 they are:

### Blocked on

Field id: `PVTSSF_lADODh3-Ac4BXYaIzhTdqRo`

| Option name | Option id |
|-------------|-----------|
| `Nothing`       | `122744bf` |
| `Human`         | `a20d20ac` |
| `Another issue` | `e3e1b0c4` |

> **Note:** The SKILL.md vocabulary lists this option as `Another issue #N`
> (with a number suffix). The actual provisioned option name is `Another issue`
> (no `#N`). Use the option name exactly as stored (`Another issue`) when
> selecting by name; refer to the prerequisite issue number in the issue body
> instead.

### Effort

Field id: `PVTSSF_lADODh3-Ac4BXYaIzhTdqRw`

| Option name | Option id |
|-------------|-----------|
| `Low`    | `ef2a043d` |
| `Medium` | `6539eb71` |
| `High`   | `081839fa` |
| `XHigh`  | `(added after board provisioning)` |
| `Max`    | `(added after board provisioning)` |

> `XHigh` and `Max` are added to the board via the field settings UI; re-discover their option ids at run time (see the prerequisite note).

### Priority

Field id: `PVTSSF_lADODh3-Ac4BXYaIzhTdqSM`

| Option name | Option id |
|-------------|-----------|
| `P0` | `bee7af67` |
| `P1` | `f9ecca2e` |
| `P2` | `847a3c62` |
| `P3` | `3ccfaa6f` |
| `P4` | `9b48afe5` |

> The provisioned field has `P0`–`P4`. SKILL.md lists all five tiers; `P4` is
> a valid option that can be set directly in GitHub.

To parse these dynamically in a script:

```bash
FIELDS=$(gh project field-list 1 --owner Jinn-Network --format json | jq '.fields')

# Blocked on
BLOCKED_FIELD_ID=$(echo "$FIELDS" | jq -r '.[] | select(.name == "Blocked on") | .id')
get_blocked_option() {
  echo "$FIELDS" | jq -r --arg name "$1" \
    '.[] | select(.name == "Blocked on") | .options[] | select(.name == $name) | .id'
}

# Effort
EFFORT_FIELD_ID=$(echo "$FIELDS" | jq -r '.[] | select(.name == "Effort") | .id')
get_effort_option() {
  echo "$FIELDS" | jq -r --arg name "$1" \
    '.[] | select(.name == "Effort") | .options[] | select(.name == $name) | .id'
}

# Priority
PRIORITY_FIELD_ID=$(echo "$FIELDS" | jq -r '.[] | select(.name == "Priority") | .id')
get_priority_option() {
  echo "$FIELDS" | jq -r --arg name "$1" \
    '.[] | select(.name == "Priority") | .options[] | select(.name == $name) | .id'
}
```

---

## Step 5 — Set each field

One call per field. Use the item id from Step 3 and the project node id from
Step 1. Replace `<blocked-option-id>`, `<effort-option-id>`, and
`<priority-option-id>` with the ids resolved in Step 4.

```bash
PROJECT_ID="PVT_kwDODh3-Ac4BXYaI"

# Blocked on
gh project item-edit \
  --id "$ITEM_ID" \
  --project-id "$PROJECT_ID" \
  --field-id "$BLOCKED_FIELD_ID" \
  --single-select-option-id "<blocked-option-id>"

# Effort
gh project item-edit \
  --id "$ITEM_ID" \
  --project-id "$PROJECT_ID" \
  --field-id "$EFFORT_FIELD_ID" \
  --single-select-option-id "<effort-option-id>"

# Priority
gh project item-edit \
  --id "$ITEM_ID" \
  --project-id "$PROJECT_ID" \
  --field-id "$PRIORITY_FIELD_ID" \
  --single-select-option-id "<priority-option-id>"
```

### Full dynamic sequence (copy-pasteable)

```bash
# Prerequisites: ITEM_ID, ISSUE_URL set from Steps 2–3; FIELDS set from Step 4.

PROJECT_ID="PVT_kwDODh3-Ac4BXYaI"

BLOCKED_FIELD_ID=$(echo "$FIELDS" | jq -r '.[] | select(.name == "Blocked on") | .id')
EFFORT_FIELD_ID=$(echo "$FIELDS"  | jq -r '.[] | select(.name == "Effort") | .id')
PRIORITY_FIELD_ID=$(echo "$FIELDS" | jq -r '.[] | select(.name == "Priority") | .id')

# Set BLOCKED_VALUE, EFFORT_VALUE, PRIORITY_VALUE to the chosen option names:
#   Blocked on: "Nothing" | "Human" | "Another issue"
#   Effort:     "Low" | "Medium" | "High" | "XHigh" | "Max"
#   Priority:   "P0" | "P1" | "P2" | "P3" | "P4"
BLOCKED_VALUE="Nothing"
EFFORT_VALUE="Low"
PRIORITY_VALUE="P1"

BLOCKED_OPT=$(echo "$FIELDS" | jq -r --arg v "$BLOCKED_VALUE" \
  '.[] | select(.name == "Blocked on") | .options[] | select(.name == $v) | .id')
EFFORT_OPT=$(echo "$FIELDS" | jq -r --arg v "$EFFORT_VALUE" \
  '.[] | select(.name == "Effort") | .options[] | select(.name == $v) | .id')
PRIORITY_OPT=$(echo "$FIELDS" | jq -r --arg v "$PRIORITY_VALUE" \
  '.[] | select(.name == "Priority") | .options[] | select(.name == $v) | .id')

gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id "$BLOCKED_FIELD_ID" --single-select-option-id "$BLOCKED_OPT"

gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id "$EFFORT_FIELD_ID" --single-select-option-id "$EFFORT_OPT"

gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id "$PRIORITY_FIELD_ID" --single-select-option-id "$PRIORITY_OPT"

echo "Filed: $ISSUE_URL (#$ISSUE_NUMBER) — Blocked on: $BLOCKED_VALUE, Effort: $EFFORT_VALUE, Priority: $PRIORITY_VALUE"
```

---

## Step 5.5 — Verify the issue-to-PR link (PR blockers)

`addBlockedBy` resolves only Issue nodes; a pull-request node id fails with
`Could not resolve to Issue node with the global id of 'PR_…'`. When the real
prerequisite is an open PR, an issue must stand for it — the PR carries
`Closes #N`, and the native edge points at `#N`.

`closedByPullRequestsReferences` is the query that proves the link exists (it
is the inverse of a PR's `closingIssuesReferences`):

```bash
# Which PRs will close this issue?
gh api graphql -f query='
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      closedByPullRequestsReferences(first:10,includeClosedPrs:true){
        nodes{ number state url }
      }
    }
  }
}' -F owner=Jinn-Network -F name=mono -F number=<N> \
  --jq '.data.repository.issue.closedByPullRequestsReferences.nodes'
```

An empty array means the PR body has no `Closes #N` for this issue — add it
(`gh pr edit <pr> --body-file …`) before relying on the edge, or the dependent
never auto-unblocks when the PR merges.

The mirror check, from the PR side:

```bash
gh api graphql -f query='
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      closingIssuesReferences(first:10){ nodes{ number url } }
    }
  }
}' -F owner=Jinn-Network -F name=mono -F number=<PR> \
  --jq '.data.repository.pullRequest.closingIssuesReferences.nodes'
```

---

## Step 6 — Commit (for contributors adding this file)

```bash
git add .claude/skills/file-issue/references/gh-taxonomy.md
git commit -m "$(cat <<'EOF'
docs(autopilot): gh taxonomy reference for the file-issue skill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
