# Operator SPA — shadcn Thoroughness Plan

**Date:** 2026-05-21
**Status:** Draft
**Predecessor:** [2026-05-21-shadcn-migration.md](2026-05-21-shadcn-migration.md) (delivered via [PR #451](https://github.com/Jinn-Network/mono/pull/451))
**Spec dependency:** [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md), [`BRAND.md`](../../../BRAND.md), [`DESIGN.md`](../../../DESIGN.md)

---

## Why this plan exists

PR #451 landed the **substrate** (17 vendored shadcn primitives, token mapping, `cn` helper, path alias) and migrated the **six visible cards on `/overview`** plus a couple of operator sub-route surfaces. It claimed "phases 0–6 complete."

It wasn't. A direct survey of the SPA after merge:

```bash
# Source files (excluding tests and the vendored ui/ tree) that still
# carry inline style={{...}} blocks:
$ find client/src/dashboard/spa/src -name "*.tsx" ! -name "*.test.tsx" \
    ! -path "*/components/ui/*" -type f | xargs grep -l "style={{" | wc -l
58

# …out of:
$ find client/src/dashboard/spa/src -name "*.tsx" ! -name "*.test.tsx" \
    ! -path "*/components/ui/*" -type f | wc -l
69
```

**58 of 69 non-UI source files (84%) still compose with `style={{}}` instead of shadcn primitives.** The migrated cards on `/overview` are real, but they're a thin layer — the launcher flow, operator catalogue, configuration, captures tab, leaderboard, build page, onboarding region, and AppShell chrome were untouched or only partially touched.

The earlier plan's prompt to "migrate the X card to shadcn" produced surface compliance: the agent wrapped existing markup in `<Card>` + `<Button>` but left the section-by-section inline grids, the colour vars in JSX, the bespoke `j-surface-secondary`/`j-label`/`j-card` classes, and the per-component styled `<span>` ladders. The result reads as shadcn-shaped but isn't: behaviour, a11y, focus management, and visual rhythm are still hand-rolled in every file.

This plan exists to drive that work to actual completion. Three deliverables:

1. **§A. The agent prompt** — the exact instructions to paste into a session whose job is "thoroughly replace components with shadcn." Includes hard-banned patterns and grep-based self-verification.
2. **§B. The component inventory** — every prominent SPA component, grouped by surface, with inline-style debt count and current pain.
3. **§C. The migration plan** — sequenced phases (one PR per phase), per-file definition of done, verification matrix.

Section D is a tracking checklist to amend as each phase ships.

---

## §A. The agent prompt

> Paste this verbatim as the first message of any session whose task is to migrate a non-trivial component to shadcn. Pin it; do not summarise it; do not assume it is internalised.

```markdown
You are migrating an existing operator-dashboard component to **shadcn-ui
primitives**. shadcn primitives live in `client/src/dashboard/spa/src/components/ui/`
and are *vendored, not installed* — read them when you need to understand
what variants exist.

## What "thoroughly" means

You are NOT wrapping. You are NOT layering shadcn on top of existing
markup. You are REPLACING the component from the root JSX down. The
output JSX tree should look as if you typed it from scratch with the
shadcn vocabulary in your head, not as if you edited an old file in
place. If you find yourself preserving a `<div className="…">` whose
purpose is "be a card", you are layering — stop and use `<Card>`.

## Hard-banned patterns inside `client/src/dashboard/spa/src/**` (outside `components/ui/`)

After your migration the following ripgrep / grep checks **must all
return zero hits in the file you touched**. Run them yourself before
claiming the file is done.

1. **No inline styles.**
   ```
   rg 'style=\{\{' <file>
   ```
2. **No legacy `j-` utility classes.** These are the pre-shadcn brand
   utility set (`j-surface-*`, `j-card`, `j-card-bare`, `j-label`,
   `j-display`, `j-mono`, `j-rule`, `j-notification*`). Replace each
   with either a shadcn primitive or a tailwind utility against the
   shadcn token (`bg-card`, `border-border`, `text-muted-foreground`).
   ```
   rg '"j-(surface|card|label|display|mono|rule|notification)' <file>
   ```
3. **No raw `var(--*)` brand tokens in JSX className strings.** The
   tailwind config maps `--bg` → `background`, `--fg` → `foreground`,
   `--accent-sky` → `primary`, `--break-red` → `destructive`,
   `--vow-green` (no direct shadcn map — use a Badge variant). If you
   reach for `text-[var(--accent-sky)]`, you missed the mapping —
   `text-primary` is the move.
   ```
   rg 'var\(--' <file>     # JSX hits only; tailwind config + globals.css are fine
   ```
   (Exception: a single `var(--vow-green)` is acceptable when no shadcn
   token maps cleanly, but you must justify it in a comment.)
4. **No bespoke `<button>` elements.** Every clickable thing is a
   `<Button>` (any variant) or a shadcn primitive that renders its own
   trigger (`DropdownMenuTrigger`, `DialogTrigger`, `SheetTrigger`,
   `AlertDialogTrigger`, `TooltipTrigger`). The only allowed escape is a
   `<Button asChild>` wrapping a `<Link>` from `wouter`.
   ```
   rg '<button\b' <file>   # zero hits
   ```
5. **No bespoke status pills / chips / tags.** Every chip-shaped
   element is a `<Badge variant="…">`. The shipped variants are
   `default | secondary | destructive | warning | success | outline |
   pill`. If you need a new tone, add a variant to
   `components/ui/badge.tsx` — don't inline-style.
6. **No raw `<table>` / `role="table"`.** Use `<Table>` and parts.
7. **No bespoke `<dialog>` / modal scaffolding.** Use `<Dialog>` for
   structural modals or `<AlertDialog>` for destructive confirmations.
8. **No bespoke select / dropdown / popover.** Use shadcn `<Popover>`,
   `<DropdownMenu>`, or `<Tabs>` depending on intent.
9. **No `title=` attributes for non-trivial copy.** Wrap the element in
   a `<Tooltip>` so screen readers and keyboard users get the info too.

## The shadcn vocabulary you have

All of these are vendored under `client/src/dashboard/spa/src/components/ui/`.
Open the file when you need the variant list.

| Primitive | When to use |
|---|---|
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Any surface that needs a border + padding + heading |
| `Button` (`default` / `destructive` / `outline` / `secondary` / `ghost` / `link`, sizes `default` / `sm` / `lg` / `icon`) | Every clickable thing |
| `Badge` (`default` / `secondary` / `destructive` / `warning` / `success` / `outline` / `pill`) | Status, role, severity, qualifier |
| `Table` + parts (`TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableFooter`, `TableCaption`) | Tabular data |
| `Tooltip` (+ `TooltipProvider`, `TooltipTrigger`, `TooltipContent`) | Hover/focus reveal for truncated values, disabled-button reasons |
| `ScrollArea` (+ `ScrollBar`) | Any scrollable region |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`, `DialogTrigger` | Structural modal forms |
| `AlertDialog` + parts | Destructive confirmations only |
| `Sheet` + parts (`side="right" | "left" | "top" | "bottom"`) | Side drawers, edit-in-place |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | In-surface category switch |
| `DropdownMenu` + parts | Action menus, narrow-viewport navs |
| `Popover` + parts | Lightweight non-modal overlays |
| `Alert` + (`AlertTitle`, `AlertDescription`) variants `default` / `info` / `warning` / `blocking` / `success` | Inline notices, error states |
| `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormDescription`, `FormMessage` + `Input`, `Label` | Anything with text inputs (react-hook-form + zod under the hood) |
| `Progress` | Bootstrap / wizard progress bars |
| `Separator` (`orientation="horizontal" | "vertical"`) | In-card section dividers |
| `Toaster` from `sonner.tsx` | Transient action confirmations (auto-dismiss) |

Icons come from `lucide-react`. Use them. A `Pencil` next to "Edit", a
`Plus` next to "Join more", a `ChevronRight` next to a drill-in row —
these are not decoration, they're affordance.

## Process

1. **Read the file end to end.** Do not begin writing until you have
   read every line.
2. **Read the file's `.test.tsx` sibling end to end.** Note every
   testId, role, aria-label, and text assertion. These are your DoD
   anchors — they must keep passing.
3. **Plan the JSX tree on paper (mental or scratch) before opening
   Edit.** Identify the outer surface (usually `<Card>`), the section
   boundaries (each becomes either nested content blocks separated by
   `<Separator>` or its own `<Card>` if visual independence is
   warranted), the interactive surfaces (each becomes a `<Button>` of
   some variant), and the data displays (each becomes `<Table>`, `<dl>`,
   or `<Badge>`).
4. **Write the file in one pass, top to bottom, with the shadcn
   vocabulary.** Do NOT iteratively edit the old file — that's how
   "wrapping" sneaks in. Use the `Write` tool with the full new
   content. If you need to keep one logical helper (e.g., `formatRole`,
   a memoised filter), copy it verbatim into the new file, but every
   piece of JSX is rewritten.
5. **Self-verify with grep before claiming done.** Run each of the
   nine banned-pattern checks above against the file. If any returns
   non-zero, you are not done.
6. **Run the file's vitest.** `yarn vitest run <path>` from
   `client/`. Fix mismatches by adjusting JSX, not by deleting
   assertions. The only acceptable test edit is replacing a
   className-string assertion with a testId / role / variant
   assertion — and only when the new shape is genuinely better.
7. **Run typecheck.** `cd client/src/dashboard/spa && yarn tsc --noEmit`.
8. **Run the full SPA suite.** `cd client && yarn vitest run
   src/dashboard/spa/src/`. If your change broke a sibling file's
   test (because you removed a class it asserted against), fix the
   sibling too — don't paper over it.
9. **Build and serve from this worktree.** `cd client && yarn build`
   (the full one, not just `build:spa` — it must roll the SPA into
   `dist/dashboard/`). Kill any running daemon: `pgrep -f 'node
   dist/bin/jinn.js run' | xargs -r kill -9`. Restart:
   `node dist/bin/jinn.js run`. Hard-refresh the browser. Confirm
   the file's surface renders correctly and that the broader page
   it's in still composes.
10. **Capture before/after screenshots** in the PR body.

## What "done" looks like for a single file

- All nine banned-pattern grep checks return zero hits.
- The file's `.test.tsx` passes with no skipped tests.
- The full SPA vitest suite passes.
- `yarn tsc --noEmit` from the SPA dir is clean.
- `yarn build` from `client/` succeeds and the new bundle lands in
  `client/dist/dashboard/assets/`.
- A browser smoke at `http://127.0.0.1:7331` shows the migrated surface
  rendering without regression vs the before screenshot.
- The diff in your PR shows a near-total rewrite of the JSX tree,
  not a sprinkling of `<Button>` and `<Card>` over an unchanged
  structure.

## What "done" does NOT look like

- "I wrapped the section in a `<Card>`." (You wrapped. You did not
  replace.)
- "I added `<Badge>` for the state cell." (Cell yes; the rest of the
  table headers / row borders / empty state are still inline-styled.)
- "Tests pass." (Tests passing is necessary, not sufficient. Grep
  checks are the sufficient condition.)
- "I matched the existing visual exactly." (You may have. You may
  also have kept inline styles to do it. Run the grep.)
- Any `style={{}}` block remaining in the file under any
  justification. There is no justification. If the design tokens
  shadcn ships don't cover the case, the right move is to add a
  variant to a `components/ui/*.tsx` file or to extend the tailwind
  config — never to inline-style.

## Asking for help vs. inventing

If a primitive you need genuinely doesn't exist in `components/ui/`:

- **First**, check `components.json` aliases and the existing
  primitives — shadcn's vocabulary is wider than first impression.
- **Second**, check whether the case is actually a variant of an
  existing primitive (e.g., a "warning" Alert variant rather than a
  new `WarningCard`).
- **Third**, if the case is genuinely novel, vendor a new primitive
  from [ui.shadcn.com](https://ui.shadcn.com), or hand-write a
  minimal one in `components/ui/`. Add it once, use it everywhere.
- **Never** inline-style around the gap.
```

---

## §B. Component inventory

The numbers below are **inline `style={{` occurrences per file** as of
this plan's authoring (commit `8027dded` on `next`). They are the
debt-load proxy; the actual work per file is bigger because each
inline block tends to come with its own `j-*` class, `var(--*)` token,
or hand-rolled `<button>`.

### B.1 Configuration / launcher core (heavy)

| File | `style={{` | Notes |
|---|---:|---|
| `pages/configuration/NetCard.tsx` | 57 | The largest single offender — full membership-edit surface |
| `pages/configuration/JoinedNetCard.tsx` | 46 | Edit-in-place flow; plan calls for a `<Sheet>` drawer |
| `pages/operator-catalog/JoinFlow.tsx` | 44 | Multi-step join wizard; `<Dialog>` + `<Form>` |
| `pages/configuration/PluginPicker.tsx` | 23 | Pickable list — `<Command>` or `<DropdownMenuCheckboxItem>` |
| `pages/configuration/CostEstimatePanel.tsx` | (lower) | Numbers panel — `<Card>` + `<Table>` |

### B.2 Onboarding region

| File | `style={{` | Notes |
|---|---:|---|
| `regions/Onboarding.tsx` | 38 | PR #451 made a targeted pass; full split into per-step components still pending |
| `regions/AwaitingFundingCard.tsx` | 16 | Drip status panel; `<Card>` + `<Progress>` + `<Alert>` |
| `regions/Agent.tsx` | 13 | Embedded xterm agent panel; mostly chrome — `<Card>` shell |
| `regions/LoadingScreen.tsx` | 10 | Full-screen spinner; `<Card>` + token-only utilities |

### B.3 Launcher flow

| File | `style={{` | Notes |
|---|---:|---|
| `pages/Launcher.tsx` | 24 | Hub page; cards + `<Tabs>` for in/out states |
| `pages/launcher-create/Step5ReviewLaunch.tsx` | 22 | Review surface; `<Card>` + `<Table>` for invariants |
| `pages/launcher-create/Step2ReviewContract.tsx` | 21 | Contract preview; `<Card>` + `<Badge>` |
| `pages/launcher-launched/GeneratorPanel.tsx` | 18 | 1049 LOC monster; multiple sub-cards |
| `pages/launcher-create/StepShell.tsx` | 17 | Shared wizard shell; `<Progress>` + `<Card>` |
| `pages/launcher-launched/StatusHeader.tsx` | 16 | Status pill row; `<Badge>` heavy |
| `pages/launcher-launched/TasksPanel.tsx` | 12 | Task list — same `<Table>` shape as ActivityCard |
| `pages/launcher-launched/PauseRetireDialog.tsx` | 12 | Already dialog-shaped; `<AlertDialog>` |
| `pages/launcher-create/Step4ConfigurePricing.tsx` | 10 | Form — `<Form>` + `<Input>` |
| `pages/launcher-create/Step1Define.tsx` | (lower) | Form |
| `pages/launcher-launched/SpendPanel.tsx` | (lower) | Stats — `<Card>` + `<Table>` |

### B.4 Operator catalogue + sub-routes

| File | `style={{` | Notes |
|---|---:|---|
| `pages/operator/OperatorDataMarket.tsx` | 33 | Donation toggle + facts grid; `<Card>` + `<Switch>` (new vendor) + `<Tooltip>` |
| `pages/operator-catalog/RegistryCatalog.tsx` | 29 | Catalogue grid; `<Card>` per item + `<Badge>` for tags |
| `pages/operator-catalog/HermesPrecheckPanel.tsx` | 9 | Pre-check status; `<Alert>` + `<Badge>` |
| `pages/operator/NetworkTab.tsx` | 10 | RPC settings; `<Card>` + `<Form>` |
| `pages/operator/MembershipsTab.tsx` | (lower) | Hosts `NetCard` — fixes follow that one |

### B.5 Captures / execution-data tab

| File | `style={{` | Notes |
|---|---:|---|
| `captures/CapturesTab.tsx` | 35 | Row list + detail pane; `<Card>` + `<ScrollArea>` + `<Sheet>` for detail |
| `captures/CaptureDrillIn.tsx` | 11 | Detail view; `<Card>` + `<dl>` + `<Badge>` |
| `captures/HarnessIdCard.tsx` | 11 | ID card — `<Card>` + `<Badge>` |
| `captures/CapturesList.tsx` | (lower) | Row list; `<Button variant="ghost">` rows |
| `captures/RedactionDiff.tsx` | (lower) | Diff view — heavy custom CSS, may need a `<Card>` + a minimal new primitive |

### B.6 Build page

| File | `style={{` | Notes |
|---|---:|---|
| `pages/build/ShapeCatalogue.tsx` | 13 | Catalogue grid; `<Card>` per item |
| `pages/build/PublishedPluginsPanel.tsx` | 13 | Table view; `<Table>` + `<Badge>` |
| `pages/build/MyArtifactsPanel.tsx` | 13 | Artifact list; `<Table>` + `<Tooltip>` |
| `pages/Build.tsx` | (lower) | Page shell; mostly composition |

### B.7 Leaderboard

| File | `style={{` | Notes |
|---|---:|---|
| `pages/leaderboard/TrainLeaderboardTable.tsx` | 11 | `<Table>` + `<Badge>` for verified |
| `pages/leaderboard/FrozenLeaderboardTable.tsx` | 11 | Same shape as Train |
| `pages/leaderboard/VerifiedBadge.tsx` | (lower) | A literal `<Badge>` already — port it |
| `pages/leaderboard/Leaderboard.tsx` | (lower) | Page shell; `<Card>` + `<Tabs>` |

### B.8 Shell + chrome

| File | `style={{` | Notes |
|---|---:|---|
| `shell/AppShell.tsx` | (lower) | Three-region grid — replace inline `style={{display:'grid',...}}` with tailwind utilities |
| `shell/Header.tsx` | (lower) | Identity pill + dropdown; `<Button>` + `<DropdownMenu>` |
| `shell/TopTabs.tsx` | (lower) | Already wouter Links; convert to `<Tabs>`-styled link list using `Button asChild` |
| `shell/AgentRail.tsx` | (lower) | xterm container; minimal chrome — `<Card>` outer |
| `components/SectionCard.tsx` | 12 | **Wrap deprecate** — every site should migrate off this onto `<Card>` directly; once empty, delete |
| `components/PanelCard.tsx` | (lower) | Same pattern as SectionCard — deprecate after consumers move |
| `components/ConfigField.tsx` | (lower) | Form helper — replace with `<FormField>` + `<Input>` |
| `components/InlineHelp.tsx` | (lower) | Tooltip-like — replace with `<Tooltip>` or `<Popover>` |
| `components/RestartPill.tsx` | (lower) | `<Badge variant="warning">` |
| `components/EventStreamList.tsx` | (lower) | Stream list — `<ScrollArea>` + row items |

### B.9 Top-level pages (composition layers)

| File | `style={{` | Notes |
|---|---:|---|
| `pages/Overview.tsx` | (lower) | The dashboard-action-notice → `<Alert>` already done in PR #451; outer grid still inline — convert to tailwind |
| `pages/Operator.tsx` | (lower) | `<OperatorSubNav>` + outlet; mostly grid |
| `App.tsx` | (lower) | Router + providers; add `<TooltipProvider>` + `<Toaster>` at root so descendants don't redeclare |

---

## §C. The migration plan

### C.1 Principles

1. **One surface per PR.** A surface = a single user-meaningful page or a self-contained region. The PR diff should be reviewable in one sitting (target: < 500 changed lines, hard cap: 800).
2. **Smallest leaves first within a surface.** Within a phase, migrate child components before the parent that composes them. This avoids two passes on the same file.
3. **Delete legacy primitives the moment they have zero consumers.** `SectionCard.tsx`, `PanelCard.tsx`, `InlineHelp.tsx`, `RestartPill.tsx`, `ConfigField.tsx` all get retired in their consumer's phase.
4. **Retire `j-*` classes incrementally.** After each phase, run the grep across the SPA tree and report the residual hit count in the PR body. The series is done when the count is zero.
5. **Add to `components/ui/` only when a new shape is genuinely needed.** Each addition is its own commit within the PR with a justification.
6. **Test discipline.** Existing testIds, roles, and aria-labels survive. The only acceptable test edits replace className-string assertions with testId / role assertions.
7. **Restart + smoke discipline.** Every PR boots the daemon from this worktree and confirms the surface visually. The PR body includes before/after screenshots.

### C.2 Net-new shadcn primitives to vendor

Driven by the inventory, not aspiration. Each lands in its own commit within the first PR that needs it.

- `Switch` — for the donation on/off toggle in `OperatorDataMarket.tsx` and any other binary settings (Phase C.4).
- `Command` — for the `PluginPicker.tsx` searchable multi-select (Phase C.1).
- `Accordion` — only if the operator catalogue grows nested categories (Phase C.4); skip until needed.
- `Skeleton` — for the dashboards' loading states; replaces the current "Loading…" text (Phase C.2 or C.8).
- `Toaster` (already vendored) — actually mount it in `App.tsx` and migrate the inline `dashboard-action-notice` band from `<Alert>` to `toast()` calls (Phase C.8).

### C.3 Phase sequencing

| # | Phase | Files | Estimated size | New primitives | Closes |
|---|---|---|---|---|---|
| 1 | **Configuration core** | `NetCard.tsx`, `JoinedNetCard.tsx`, `PluginPicker.tsx`, `CostEstimatePanel.tsx`, `ConfigField.tsx` (delete) | Heavy (~700 LOC diff) | `Command` | The biggest single debt-load (57 + 46 + 23 inline styles in three files) |
| 2 | **Captures + execution-data** | `CapturesTab.tsx`, `CapturesList.tsx`, `CaptureDrillIn.tsx`, `HarnessIdCard.tsx`, `RedactionDiff.tsx` | Heavy (~600 LOC) | None | The whole captures route, finally on `<Sheet>` for detail per the original plan |
| 3 | **Launcher create wizard** | `LauncherCreate.tsx`, `StepShell.tsx`, `Step1Define.tsx` through `Step5ReviewLaunch.tsx` | Heavy (~800 LOC) | None | The full create flow; `<Form>` + `<Progress>` end-to-end |
| 4 | **Launcher launched + operator catalogue** | `LauncherLaunched.tsx`, `Launcher.tsx`, `GeneratorPanel.tsx`, `StatusHeader.tsx`, `TasksPanel.tsx`, `SpendPanel.tsx`, `PauseRetireDialog.tsx`, `RegistryCatalog.tsx`, `JoinFlow.tsx`, `HermesPrecheckPanel.tsx` | Heavy — may split into 4a/4b | None | The launcher post-launch surface + the operator-side catalogue browse/join |
| 5 | **Operator sub-routes finish** | `OperatorDataMarket.tsx`, `NetworkTab.tsx`, `MembershipsTab.tsx` (composition only after phase 1) | Medium (~400 LOC) | `Switch` | Closes the `/operator/*` sub-tree |
| 6 | **Build + Leaderboard** | `Build.tsx`, `ShapeCatalogue.tsx`, `PublishedPluginsPanel.tsx`, `MyArtifactsPanel.tsx`, `Leaderboard.tsx`, `TrainLeaderboardTable.tsx`, `FrozenLeaderboardTable.tsx`, `VerifiedBadge.tsx` | Medium (~500 LOC) | `Skeleton` | The two read-only pages |
| 7 | **Onboarding finish** | `Onboarding.tsx` split into per-step components, `AwaitingFundingCard.tsx`, `Agent.tsx`, `LoadingScreen.tsx` | Heavy (~600 LOC) | None | The full first-run experience — gets the design pass the original plan deferred |
| 8 | **Shell + chrome + deletion sweep** | `App.tsx` (add `<TooltipProvider>` + `<Toaster>`), `AppShell.tsx`, `Header.tsx`, `TopTabs.tsx`, `AgentRail.tsx`, `Overview.tsx` (action-notice → `toast()`), delete `SectionCard.tsx` / `PanelCard.tsx` / `InlineHelp.tsx` / `RestartPill.tsx`, retire `j-*` classes from `globals.css`, retire raw `var(--*)` from `OPERATOR-APP-SPEC.md` references | Medium (~400 LOC, net deletes) | None | Final cleanup; the SPA reaches zero `style={{` outside test fixtures and `components/ui/` is the only place classes live |

### C.4 Per-file definition of done

For every `.tsx` touched in a phase, the PR must show:

- **Zero** hits for `style={{`.
- **Zero** hits for `j-(surface|card|label|display|mono|rule|notification)`.
- **Zero** hits for `var(--` inside JSX className strings (CSS files and the tailwind config keep theirs).
- **Zero** raw `<button>` elements.
- All existing testIds preserved.
- `.test.tsx` sibling passes without `skip` or `todo`.
- `yarn vitest run src/dashboard/spa/src/` from `client/` passes the full SPA suite.
- `yarn tsc --noEmit` from `client/src/dashboard/spa/` clean.
- Daemon-side `yarn typecheck` from `client/` clean.
- `yarn build` from `client/` produces a fresh bundle in `client/dist/dashboard/`.
- The browser at `http://127.0.0.1:7331` renders the surface visually identical or better. PR body has before / after screenshots.

### C.5 Verification matrix (run before opening every PR)

```bash
# 1. Hard-banned patterns (run against the files touched in this PR):
for f in <files-changed>; do
  echo "== $f =="
  rg -n 'style=\{\{' "$f" || true
  rg -n '"j-(surface|card|label|display|mono|rule|notification)' "$f" || true
  rg -n 'var\(--' "$f" || true
  rg -n '<button\b' "$f" || true
done
# All blocks above should print only "== file ==" headers, no hits.

# 2. SPA suite:
cd client && yarn vitest run src/dashboard/spa/src/

# 3. SPA typecheck:
cd client/src/dashboard/spa && yarn tsc --noEmit

# 4. Daemon-side typecheck:
cd client && yarn tsc --noEmit

# 5. Production bundle:
cd client && yarn build
ls client/dist/dashboard/assets/index-*.js   # confirm new hash

# 6. Browser smoke:
pgrep -f 'node dist/bin/jinn.js run' | xargs -r kill -9
cd client && node dist/bin/jinn.js run &
sleep 5 && curl -s http://127.0.0.1:7331/ | grep -oE 'index-[A-Za-z0-9-]+\.js'
# Open browser, hard-refresh, screenshot the migrated surface.
```

### C.6 Bundle budget

PR #451 took the SPA from 750 KB / 195 KB gzip → 965 KB / 266 KB gzip. The remaining phases should net to **+0 KB or smaller** — they remove inline-styled JSX (smaller), add a handful of new shadcn primitives (modest growth), and benefit from gzip deduplication of repeated utility classes. Each PR reports its delta. If a phase blows budget by >50 KB raw, audit the new primitives.

### C.7 Tests + a11y discipline

- Each phase adds at least one a11y assertion per migrated component (e.g., a `getByRole('button', { name: /…/i })` instead of a testId-only lookup).
- Each phase runs `axe` against the relevant route once and reports residual violations in the PR body. (Vendor `@axe-core/react` in phase 1 if not already present.)
- Each phase preserves Playwright E2E coverage. The `funding-sequence.e2e.test.ts` repair in PR #451 is the template.

---

## §D. Tracking checklist

Amend this section as each phase ships; do not delete the checkbox once
ticked.

- [ ] **C.1 — Configuration core** (PR #__)
- [ ] **C.2 — Captures + execution-data** (PR #__)
- [ ] **C.3 — Launcher create wizard** (PR #__)
- [ ] **C.4 — Launcher launched + operator catalogue** (PR #__)
- [ ] **C.5 — Operator sub-routes finish** (PR #__)
- [ ] **C.6 — Build + Leaderboard** (PR #__)
- [ ] **C.7 — Onboarding finish** (PR #__)
- [ ] **C.8 — Shell + chrome + deletion sweep** (PR #__)
- [ ] **Final audit**: full SPA tree returns zero hits on all four
  banned-pattern checks. Delete this plan's "Why this plan exists"
  framing and link to the resulting design conventions doc.

---

## Risks & non-goals

| Risk | Mitigation |
|---|---|
| The volume of files is large enough that an agent may "scope-slip" back to wrapping | The §A prompt's grep self-verification is the gate; reviewers spot-check by running it locally |
| Some surfaces (RedactionDiff, GeneratorPanel) have legitimately bespoke layout needs | Vendor new primitives or extend variants; never inline-style. If the case truly defies shadcn, document it in a comment and isolate the deviation |
| Bundle growth from over-vendoring primitives | Track per-PR delta. If we're tempted to vendor a primitive used in exactly one place, inline the small primitive logic in that file instead — but it still uses tailwind utilities against shadcn tokens, never inline styles |
| A migrated component breaks a sibling test that asserted a class name | Acceptable to update sibling tests in the same PR; document each in the PR body |
| Visual drift between phases | Each PR ships before/after screenshots; reviewers veto if the surface regresses |

**Non-goals:**

- Rebranding. Tokens, lexicon, voice stay canonical via `BRAND.md` /
  `DESIGN.md`.
- Replacing `wouter`, `@tanstack/react-query`, `@tanstack/react-table`.
- A dark-mode/light-mode toggle (the SPA is dark-only by design).
- Storybook. We have vitest + Playwright; Storybook is out of scope until the team explicitly wants it.

---

## Definition of done — series

- All eight tracking checkboxes ticked.
- `find client/src/dashboard/spa/src -name "*.tsx" ! -name "*.test.tsx" ! -path "*/components/ui/*" | xargs rg -l 'style=\{\{'` returns no files.
- `find … | xargs rg -l '"j-(surface|card|label|display|mono|rule|notification)'` returns no files.
- `globals.css` has no remaining `.j-*` rule blocks.
- `OPERATOR-APP-SPEC.md` references `<Card>` / `<Button>` / `<Badge>` etc. by name where appropriate (not the legacy `.j-surface-*` classes).
- A new `docs/design/operator-spa-shadcn-conventions.md` captures the team conventions: how to pick a variant, when to use Tooltip vs Popover, how to extend Badge tones, when to vendor a new primitive vs. inline.
