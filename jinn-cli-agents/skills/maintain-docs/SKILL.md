---
name: maintain-docs
description: Maintain documentation freshness and coverage. Use after code changes
  (post-change mode), for periodic health checks (audit mode), or to verify specific
  docs (verify mode). Activates when docs are stale, outdated, need syncing with code,
  or when asked to audit/verify documentation. Handles updating existing docs and
  creating new ones.
allowed-tools: Read Edit Grep Glob Bash
---

# Documentation Maintenance

Keep docs in sync with code. Three modes based on your context.

## Documentation References

| Topic | Reference |
|-------|-----------|
| Doc metadata schema | All docs use YAML frontmatter with `related_code`, `last_verified`, etc. |
| Purpose-based structure | `docs/reference/`, `docs/runbooks/`, `docs/context/`, `docs/guides/` |
| Code standards | [docs/guides/code-spec.md](docs/guides/code-spec.md) |
| Blood written rules | [docs/reference/blood-written-rules.md](docs/reference/blood-written-rules.md) |

## Exclusions

These directories are **excluded** from documentation maintenance:
- `docs/site/` - Marketing/website content, separate workflow
- MCP tools (`gemini-agent/mcp/tools/`) - Self-documenting via code schemas, no separate docs needed

---

## Mode 1: Post-Change (After Coding)

**When:** You just finished implementing code changes.

### Step 1: Identify Changes

```bash
git diff --name-only HEAD~1   # Last commit
git diff --name-only main     # Full branch
```

### Step 2: Find Affected Docs

```bash
# Using the helper script
git diff --name-only | ./skills/maintain-docs/scripts/find-affected-docs.sh

# Or manually for a specific file
grep -rl "your-changed-file.ts" docs/ --include="*.md"
```

### Step 3: Decide - Update or Create?

```
Changed Code
    │
    ▼
Existing doc references this file?
    │
    ├─ YES → Update existing doc (Step 4a)
    │
    └─ NO → Should a doc exist? (Step 4b)
```

### Step 4a: Update Existing Doc

1. Read the doc and your changed code
2. Check accuracy: signatures match? paths valid? examples work?
3. If accurate: update `last_verified` date only
4. If stale: edit inline + update `last_verified`
5. If major rewrite needed: create beads issue

### Step 4b: Decide If New Doc Needed

| You Created... | Create Doc? | Where |
|----------------|-------------|-------|
| New CLI script | YES | `docs/runbooks/` |
| New architecture pattern | YES | `docs/context/` |
| New user workflow | YES | `docs/guides/` |
| New error codes | APPEND | `docs/reference/error-codes.md` |
| New MCP tool | NO | Code is self-documenting |
| Internal refactor | NO | - |
| Bug fix | NO | - |
| Test changes | NO | - |

**If creating new doc, use this template:**

```yaml
---
title: [Short Title]
purpose: reference | runbook | context | guide
scope: [worker, gemini-agent, mcp, deployment]
last_verified: YYYY-MM-DD
related_code:
  - path/to/your/new/file.ts
keywords: [search, terms]
when_to_read: "When this doc is useful"
---

# [Title]

[Content...]
```

### Step 5: Commit Doc Changes

```bash
git add docs/
git commit -m "docs: [Update|Add] X for changes in Y"
```

---

## Mode 2: Audit (Periodic Health Check)

**When:** Scheduled maintenance, after major refactors, or "how healthy are our docs?"

### Scan for Issues

Use the helper scripts in `scripts/`:

```bash
# Stale docs (not verified in 30+ days)
./skills/maintain-docs/scripts/find-stale-docs.sh 30

# Broken references (related_code points to deleted files)
./skills/maintain-docs/scripts/find-broken-refs.sh
```

**Note:** Exclude `docs/site/` from audits (marketing content, separate workflow).

### Prioritize

| Priority | Condition |
|----------|-----------|
| CRITICAL | Related code deleted, doc now wrong |
| HIGH | Reference doc stale >30 days |
| MEDIUM | Context doc stale >60 days |
| LOW | Missing metadata |

### Create Issues

```bash
bd create --title="docs: [issue description]" --type=task --priority=2
```

### Output Format (Audit Report)

```
## Documentation Health Report

### Summary
- Total docs: X (excluding docs/site/)
- Verified (< 30 days): Y
- Stale (> 30 days): Z
- Broken references: N

### Critical Issues
| Doc | Issue | Priority |
|-----|-------|----------|
| path/to/doc.md | Related code deleted | CRITICAL |

### Stale Docs
| Doc | Last Verified | Days Stale |
|-----|---------------|------------|
| path/to/doc.md | 2024-12-01 | 60 |

### Actions Created
- beads-xxx: docs: Update X
- beads-yyy: docs: Fix broken ref in Y
```

---

## Mode 3: Verify (Quick Check)

**When:** PR review, spot-checking specific docs, pre-merge validation.

### For a Specific Doc

1. Read the doc
2. Read all files in `related_code`
3. Check:
   - [ ] File paths exist
   - [ ] Function signatures match
   - [ ] Examples compile
   - [ ] Terminology consistent
4. Update `last_verified` if passes

### For a PR

```bash
# Find docs affected by PR changes
gh pr view --json files -q '.files[].path' | ./skills/maintain-docs/scripts/find-affected-docs.sh
```

---

## Quick Reference

| Code Location | Likely Doc Location |
|---------------|---------------------|
| `worker/orchestration/*.ts` | `docs/context/`, `docs/reference/job-*.md` |
| `scripts/*.ts` | `docs/runbooks/` |
| `config/*.ts` | `docs/reference/environment-*.md` |
| `gemini-agent/mcp/tools/*.ts` | No docs needed (self-documenting) |

## Edge Cases

| Situation | Action |
|-----------|--------|
| No docs reference changed files | Check if NEW doc is needed (see Step 4b) |
| Doc exists but no `related_code` | Add `related_code` field with relevant files |
| Multiple docs reference same file | Update all affected docs |
| Code deleted entirely | Remove doc or mark as deprecated |
| Audit finds no issues | Report "All docs healthy" with summary stats |
| Verify fails | Create beads issue with specific failures |

## Checklist

- [ ] Affected existing docs reviewed
- [ ] New docs created where needed
- [ ] `last_verified` dates updated
- [ ] `related_code` includes new dependencies
- [ ] Dead references removed
