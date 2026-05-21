# Operator SPA — Progressive shadcn Migration Plan

**Date:** 2026-05-21
**Status:** Draft
**Predecessor:** [2026-05-21-operator-app-ui-reshuffle.md](2026-05-21-operator-app-ui-reshuffle.md) (delivered via [PR #449](https://github.com/Jinn-Network/mono/pull/449))
**Spec dependency:** [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md), [`BRAND.md`](../../../BRAND.md), [`DESIGN.md`](../../../DESIGN.md)

---

## Why

The IA reshuffle landed the right *information architecture* and the right *tokens*. The composition layer is still hundreds of inline `style={{...}}` blocks across the SPA. Adding behaviour (a dropdown, a confirmation dialog, a tooltip, a sortable column) means writing the accessibility, keyboard handling, focus management, and ARIA from scratch every time. That's the wrong shape of work — and it's why so many small UX paper cuts have piled up around the dashboard.

[shadcn-ui](https://ui.shadcn.com) is the right substrate: Radix primitives for behaviour and a11y, tailwind for composition, vendored source files so we own the code, and CSS variables so the design tokens we just established stay canonical. The dashboard SPA already ships `tailwindcss@3.4`, `clsx`, and `tailwind-merge` ([`client/src/dashboard/spa/package.json`](../../../client/src/dashboard/spa/package.json)) — 80% of the prerequisite work is done.

This is a **progressive** migration. We're not rewriting; we're swapping one surface at a time, starting where the next batch of UX work is going to land (Activity), and only touching a surface when we have to.

## What we get

- **Behaviour for free** — `Tooltip`, `Popover`, `Dialog`, `Sheet`, `DropdownMenu`, `Command` (palette), `Tabs`, `Toast`, `AlertDialog`, `ScrollArea`, `Table` (with `@tanstack/react-table`), all keyboard-navigable, all WAI-ARIA compliant.
- **One composition pattern** — `className={cn(...)}` instead of `style={{ ... }}` blocks that paste-duplicate across components.
- **Owned code, not a library** — shadcn vendors source into `components/ui/`. We can edit it. No version-pinning, no runtime dependency on a UI vendor's design opinions.
- **Tokens stay protocol** — shadcn's CSS variables (`--background`, `--card`, `--popover`, `--primary`, …) map to our existing `globals.css` tokens. Brand stays canonical; shadcn is the implementation.

## What we don't get (and won't pretend to)

- **A new design.** shadcn is a substrate, not a design system. `BRAND.md` and `DESIGN.md` stay canonical — the look comes from us. We're not "themeing shadcn"; we're consuming Radix behaviour and tailwind composition with our tokens.
- **A free pass on testing.** Every migrated component still needs its existing test coverage to pass.
- **A free pass on bundle size.** Each shadcn component drags one or more Radix subtrees with it. We add components we actually use; we don't add the kitchen sink.

## Non-goals

- Replacing `wouter` (router stays).
- Replacing `@tanstack/react-query` (already integrated).
- Replacing existing CSS classes (`.j-surface-*`, `.j-notification--*`, etc.) — these stay during the transition and only get retired when no consumer is left.
- Rebranding. Tokens stay; lexicon stays; voice stays.

## Token strategy

shadcn ships a default OKLCH palette in `components.json`-generated CSS. We override it before any shadcn install:

```css
/* globals.css — append after the existing :root block */
:root {
  /* shadcn token mapping → our brand tokens */
  --background:          var(--bg);
  --foreground:          var(--fg);
  --card:                var(--bg-elevated);
  --card-foreground:     var(--fg);
  --popover:             var(--bg-elevated);
  --popover-foreground:  var(--fg);
  --primary:             var(--accent-sky);
  --primary-foreground:  var(--bg-sunken);
  --secondary:           var(--bg-elevated);
  --secondary-foreground:var(--fg-muted);
  --muted:               var(--bg-elevated);
  --muted-foreground:    var(--fg-muted);
  --accent:              var(--bg-elevated);
  --accent-foreground:   var(--accent-sky);
  --destructive:         var(--break-red);
  --destructive-foreground: var(--fg);
  --border:              var(--border);
  --input:               var(--border);
  --ring:                var(--accent-sky);
  --radius:              var(--radius-2);
}
```

This means: **`<Button>` looks like our buttons. `<Card>` looks like our cards. `<Badge>` looks like our chips.** No re-theming required after vendor-install.

## Migration order

Phase 0 is the substrate; phases 1–6 are component migrations. Each phase opens its own PR, sized for one sitting.

| # | Phase | Scope | Closes |
| --- | --- | --- | --- |
| 0 | shadcn-init | `components.json`, `lib/utils.ts` (cn helper), token mapping, vendor `Button`, `Card`, `Badge` | — |
| 1 | Activity card | Port `ActivityCard.tsx` to shadcn `Card`, `Table` (+ @tanstack/react-table), `Badge`, `Button`, `Tooltip` | — |
| 2 | Node Health card | Port `NodeHealthCard.tsx` to `Card`, `Button`, `Tooltip`. `AlertDialog` for Stop when it un-comments | — |
| 3 | Wallet card | Port `WalletCard.tsx` to `Card`, `Button`, `Badge`. Investigate `Tooltip` over Master / Safe truncation | — |
| 4 | AppShell + Notifications | `Toast` for the inline `dashboard-action-notice` band, `Alert` for blocking notification rows | — |
| 5 | Operator sub-routes | `Tabs` for `/operator/execution-data` Donation vs Artifacts; `Form` primitives for `/operator/security`; `DropdownMenu` for the SubNav | — |
| 6 | Onboarding region | Heaviest surface — multi-step bootstrap flow; `Stepper` (vendored or built from primitives), `Dialog`, `Progress` | — |

## Phase 0 — shadcn-init

**Goal:** the substrate is ready; no SPA visual change yet.

### Files touched

- `client/src/dashboard/spa/components.json` (new) — shadcn config.
- `client/src/dashboard/spa/src/lib/utils.ts` (new) — `cn` helper (`clsx` + `tailwind-merge`).
- `client/src/dashboard/spa/src/styles/globals.css` — append the shadcn token mapping block.
- `client/src/dashboard/spa/tailwind.config.ts` — add `darkMode: 'class'`, extend theme with shadcn defaults that reference CSS variables.
- `client/src/dashboard/spa/src/components/ui/{button,card,badge}.tsx` (new) — vendored.

### Steps

1. **Write `components.json`**:
   ```json
   {
     "$schema": "https://ui.shadcn.com/schema.json",
     "style": "default",
     "rsc": false,
     "tsx": true,
     "tailwind": {
       "config": "tailwind.config.ts",
       "css": "src/styles/globals.css",
       "baseColor": "slate",
       "cssVariables": true
     },
     "aliases": {
       "components": "@/components",
       "utils": "@/lib/utils",
       "ui": "@/components/ui"
     }
   }
   ```
2. **Add path alias** in `tsconfig.json` + `vite.config.ts`: `@/*` → `src/*`. This unlocks shadcn's standard import shape without forcing relative-path gymnastics.
3. **Write `src/lib/utils.ts`** — the canonical 4-line cn helper.
4. **Extend `tailwind.config.ts`** — `darkMode: 'class'`, theme.extend.colors mapped to CSS vars (background/foreground/card/etc.), theme.extend.borderRadius using `--radius`.
5. **Append the token-mapping block** to `globals.css` (see above).
6. **Vendor `Button`, `Card`, `Badge`** via `npx shadcn@latest add button card badge` (run from `client/src/dashboard/spa/`).
7. **Verify visual unchanged** — build the SPA, deploy to the running daemon, walk every route, confirm no token-mapping regressions.

### Acceptance

- `yarn vitest --run src/dashboard/spa/src` passes (no behaviour change).
- `yarn run tsc --noEmit` clean.
- Manual: render `<Button>Test</Button>` somewhere temporarily — it should look like the sky-bordered ghost button pattern we already have. Roll back the test render before commit.

## Phase 1 — Activity card

**Goal:** prove the migration shape on the most complex card we currently have. ActivityCard is a good first target because: it has a real Table (sortable later), Badges (the role chips), Buttons (Join more / Edit), and a left-rail list that maps cleanly to shadcn primitives.

### Files touched

- `client/src/dashboard/spa/src/pages/overview/ActivityCard.tsx` — rewrite using shadcn primitives.
- `client/src/dashboard/spa/src/pages/overview/ActivityCard.test.tsx` — adjust selectors only if testIds drift.
- New shadcn vendors: `Table`, `Tooltip`, `ScrollArea`, plus `@tanstack/react-table` as a dependency.

### Component mapping

| Today | After |
| --- | --- |
| `<section className="j-surface-secondary">` | `<Card>` |
| Eyebrow label `Activity` | `<CardHeader>` with `<CardTitle>` |
| Joined list `<button>` rows | `<ScrollArea>` + `<Button variant="ghost" data-state>` with active-state ring |
| Tasks `<div role="table">` grid | `<Table>` + `<TableHeader>` / `<TableBody>` / `<TableRow>` / `<TableCell>` |
| State chips | `<Badge variant>` with `destructive` / `outline` / `secondary` per task state tone |
| Role chips | `<Badge variant="outline">` |
| `Edit →` settings link | `<Button variant="link">` |
| `Join more SolverNets` | `<Button variant="outline">` |
| Plugin row hover | `<Tooltip>` showing the full specifier (the existing `title=` attribute) |

### Steps

1. **Vendor primitives**: `npx shadcn add table tooltip scroll-area`. Install `@tanstack/react-table` (peer dep).
2. **Rewrite `ActivityCard`** — drop the inline `style={{}}` blocks, drop the manual `role="table"` grid in favour of `<Table>`, drop the manual aria-current bookkeeping in favour of `data-state="active"`.
3. **Sortable columns** — opt-in. The `@tanstack/react-table` setup unlocks sorting per column. Default sort by `stateUpdatedAt` desc (current order); columns expose toggle on header click.
4. **Tooltips on truncated values** — `requestId` truncation (`trunc(t.requestId)`) becomes a `<Tooltip>` so the operator can see the full id without copying out.
5. **Tests** — assert the new shape via testIds (`activity-tasks-table`, `activity-joined-row-*`, `activity-settings-edit`) — they should be preserved across the migration. Add a sortable-column test if we ship that step in this phase.

### Acceptance

- All ActivityCard tests pass.
- The visible card layout matches the pre-migration screenshots (no rendered diff in pixel terms beyond minor padding shifts from `<Card>` defaults).
- Bundle size delta logged in PR body (likely +30–50KB gzip for the Table + react-table).
- `aria-rowcount` / `aria-colcount` present on the table (free with shadcn `<Table>`).

## Phase 2 — Node Health card

**Goal:** port `NodeHealthCard.tsx` to shadcn. Lower-stakes than Activity, but useful because it unblocks the `AlertDialog` confirmation pattern we'll want everywhere.

### Files touched

- `client/src/dashboard/spa/src/pages/overview/NodeHealthCard.tsx`
- `client/src/dashboard/spa/src/pages/overview/NodeHealthCard.test.tsx`

### Component mapping

| Today | After |
| --- | --- |
| `<section className="j-surface-secondary">` | `<Card>` |
| `GhostButton` (the local primitive) | `<Button variant="outline" size="sm">` |
| `<StatusDot>` (8px circle) | `<Badge variant="dot">` (vendor a custom variant if needed) |
| `title=` attribute on disabled buttons | `<Tooltip>` |
| Stop button (currently commented out) | `<AlertDialog>` confirmation step when it un-comments |

### Steps

1. **Vendor `alert-dialog`** if not already.
2. **Rewrite `NodeHealthCard`**.
3. **Add a `Stop` confirmation flow** — when Stop un-comments, route it through `<AlertDialog>` so the operator confirms before the daemon exits. This kills the "did I click that on purpose?" regret state.

### Acceptance

- All NodeHealthCard tests pass.
- The Restart busy-state still clears as soon as the admin endpoint resolves (current behaviour from `fix(node-health): clear Restarting state + drop idle state-message`).

## Phase 3 — Wallet card

### Files touched

- `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx`
- `client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`

### Notes

- Identity row's truncated addresses (Master / Safe) get `<Tooltip>` with the full address — that retires the `title=` attribute pattern.
- "Change password" stays a `<Button variant="ghost">` jumping to `/operator/security`. When daemon-side `POST /v1/security/change-password` lands, this becomes an `<AlertDialog>` inline form.
- The commented-out "per role" drill-down becomes a `<Popover>` over the gas balance once daemon-side per-role balances land (#430).

## Phase 4 — AppShell + Notifications

### Files touched

- `client/src/dashboard/spa/src/shell/AppShell.tsx`
- `client/src/dashboard/spa/src/notifications/components/NotificationsList.tsx`
- `client/src/dashboard/spa/src/notifications/components/NotificationItem.tsx`

### Notes

- The inline `dashboard-action-notice` band moves to `<Toast>` (`sonner` or shadcn's `useToast`) — auto-dismiss timers are handled by the toast primitive instead of our `noticeTimerRef`.
- Each notification row becomes `<Alert variant={severity}>` — `destructive` / `default` / `default` with custom border tint.
- The empty "No active notices." row stays a thin `<Alert variant="default">` (or is removed if `<Toast>` covers the discoverability question).

## Phase 5 — Operator sub-routes

### Targets

- `/operator/execution-data` Donation / Artifacts tabs → `<Tabs>`.
- `/operator/security` password form → shadcn `<Form>` primitives (react-hook-form + zod under the hood).
- `OperatorSubNav` left rail → could move to a `<DropdownMenu>` on narrow viewports.
- `JoinedNetCard` Edit-in-place flow → `<Sheet>` (right-side drawer) instead of inline expand.

## Phase 6 — Onboarding region

### Notes

This is the largest surface and the highest-stakes migration (it's the first-run experience). It gets its own design pass first — `Onboarding.tsx` today is monolithic; a shadcn rewrite is a good moment to split it into per-step components.

Vendor needs: `<Progress>`, possibly `<Stepper>` (community or hand-built from primitives), `<Dialog>` for confirmation steps, `<Alert>` for blocking states.

## Cross-cutting tasks

- **Bundle audit** — after each phase, log the bundle size delta in the PR body. The SPA is currently 750KB gzipped 195KB; we want to keep an eye on the trajectory.
- **A11y audit** — each migration is also an a11y opportunity. After Activity, run `axe` against `/overview` and report violations as part of the PR.
- **Token-token drift** — if shadcn's defaults change in a way that doesn't map cleanly to our tokens, surface it as a Discussion. Don't silently re-style; the brand stays canonical.
- **Tests** — each phase preserves the existing test count + signatures. Test-id surfaces (`activity-card`, `wallet-card`, `node-health-card`, etc.) stay constant.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Visual regression as we rewrite cards | One PR per card; manual smoke + screenshot in PR body. Tokens are mapped before phase 1 so the look stays stable. |
| Bundle bloat from Radix peer deps | Track size delta per PR; cap at +200KB total uncompressed for the full series. If we blow the budget, audit which Radix subtrees we can drop. |
| Two patterns coexisting during migration | Acceptable — every component is either fully migrated or fully on the old pattern. No half-migrated components. |
| Existing `.j-surface-*` CSS becoming dead code mid-migration | Leave it. Retire only when no consumer is left (probably after phase 4 or 5). |
| Shadcn defaults drift between major versions | We vendor the source — we own the version. No runtime upgrade pressure. |
| Form primitives (react-hook-form + zod) introduce a new validation pattern | Acceptable — they're industry standard. Only used where there's a real form (Onboarding, password change, RPC settings). |

## Definition of done — series

- Every card on `/overview` is shadcn-based.
- Every page on `/operator/*` is shadcn-based.
- The Onboarding region is shadcn-based.
- The legacy `.j-surface-*` and inline-style patterns are removed.
- Test counts are at least at parity with the start of the series; ideally up (each migration adds a11y / behaviour tests).
- A `docs/design/operator-spa-shadcn-conventions.md` short doc captures the team conventions that emerged (how we pick variants, how we colour severity, when to use Tooltip vs Popover, etc.).

## Sequencing

Phases 1–4 can run in any order after Phase 0. Phase 5 wants Phases 1–4 to land first because the patterns it introduces (Tabs, Form, DropdownMenu, Sheet) cite earlier choices. Phase 6 should be last; Onboarding is the highest-stakes surface and benefits from us being comfortable with the substrate.

Suggested cadence: one phase per working week. The full series takes ~6 weeks of part-time work alongside other engineering.

---

**Once Phase 0 is approved, implementation begins with [executing-plans](../../../.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/executing-plans/SKILL.md) on Phase 1: Activity card.**
