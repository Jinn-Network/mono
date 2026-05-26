# 2026-05-26 — Snapshot schema-drift check: detect single-field renames (#597)

**Status:** design
**Issue:** [Jinn-Network/mono#597](https://github.com/Jinn-Network/mono/issues/597)
**Follow-up to:** [#585](https://github.com/Jinn-Network/mono/issues/585)
**Shape:** `feat` · **Effort:** Low

## Approach

Extend `fetchProjectSnapshot` in `packages/eng-loop/src/dispatcher/project-snapshot.ts` with a per-field schema-drift check that runs *after* the existing all-four-fields-null catastrophic backstop. For each of the four single-select Project fields (`status`, `priority`, `effort`, `blockedOn`), count the Issue items whose value resolved to `null`. If any single field is null for **every** Issue (and `issueCount >= SCHEMA_DRIFT_MIN_ISSUE_COUNT`), throw `ProjectFieldSchemaError` naming the suspect field. The existing all-fields-null check stays as the first branch — it produces a clearer message ("all four labels likely renamed") and continues to fire on a freshly-created project where nothing has been triaged into the Status column either.

## False-positive avoidance

**Restrict the per-field check to `Status`.** Of the four fields, only `Status` is auto-set on issue creation: `gh project item-add` (and the project's auto-add workflow) populate it with the "Todo" option, and the rest of the queue lifecycle moves it through `In Progress / In Review / Done`. The other three (`Priority`, `Effort`, `Blocked on`) legitimately stay `null` on a freshly-triaged board until a human fills them in, so a per-field null-everywhere check on those would fire constantly during normal operation. Renames of `Priority` / `Effort` / `Blocked on` remain caught by the existing all-four-null backstop (a board where Status *is* set but the other three are renamed will collapse those three to null on every triaged Issue, but Status will still be non-null, so the all-fields check correctly does *not* fire — that case devolves to a single-field rename surfacing as "no ready issues", which is the same silent-halt the issue body cites). This is a known residual gap and is documented in the error class docstring; the operator-visible recovery path (`gh project field-list 1 --owner Jinn-Network --format json`) covers it. The issue body offered "restrict to Status" *or* "require a large N for the other three" as alternatives; restricting to Status is preferred because it has zero false-positive surface and matches the bootstrapping contract (`Status` is the only field the platform writes on our behalf), where any N-based heuristic on the other three can still fire on a sprint-start board that's been freshly bulk-imported.

## `ProjectFieldSchemaError` extension

The constructor gains a `field` parameter (typed as `'Status' | 'Priority' | 'Effort' | 'Blocked on' | 'all'`) carried as a public readonly property so callers (loop-level logs, future operator-app surfaces) can branch on which field drifted without parsing the message. The `'all'` discriminant is used by the existing catastrophic-case branch; per-field detections pass the specific label. The message format becomes `ProjectFieldSchemaError: field '<Status>' returned null for all <N> Issues (threshold: 3+). Likely renamed in the Project — re-run \`gh project field-list 1 --owner Jinn-Network --format json\` to discover the current label and update the snapshot query.` for the per-field case, with the existing all-fields message preserved verbatim for the catastrophic case so existing tests / log scrapers keep matching.

## Test cases for the plan stage

1. **Status-only null across N=3 Issues** — other three fields populated — throws `ProjectFieldSchemaError`, error's `field === 'Status'`, message includes `'Status'` and the count.
2. **Status null across N=2 Issues** — below threshold — does *not* throw (small-board guard).
3. **All-untriaged board** (N=5 Issues, *only* Status set to `Todo`, other three null on all) — does *not* throw (per-field check restricted to Status; the other three legitimately null).
4. **All-fields-null catastrophic case** (N=3, every field null on every Issue) — still throws via the existing branch, `field === 'all'`, original message preserved.
5. **Mixed Status** (N=3 Issues, 2 with `Status: 'Todo'`, 1 with `Status: null`) — does *not* throw (per-field check requires *every* Issue null).
6. **PRs/DraftIssues with null Status are ignored** — N=2 Issues both with Status set + 3 PRs/Drafts with Status null — does not throw (existing Issue-only filter holds for the per-field check too).
7. **`Priority`/`Effort`/`Blocked on` individually null across all Issues** — does *not* throw via the per-field check (explicitly documents the residual gap; the all-fields backstop is the only catch for these).
8. **Error carries `field` property** — assertion against `err.field` for each of the cases above.
