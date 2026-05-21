# Operator App — UI/IA Reshuffle Brief

> A handoff brief for a fresh Claude Code instance picking up UI work on top of the operator-app spec-alignment stack. Read this end-to-end before touching anything.

## TL;DR

The data model is right. The information architecture is wrong. The dashboard surfaces ~11 stacked sections of equal visual weight with no narrative, duplicates the same concern (harness/SolverNet state) in 3+ places, and buries the operator's "what should I do next" under reference data. Your job is to reshuffle the layout and interaction patterns until an operator can land on `/overview` and *immediately understand* their node's state — not scroll through 800 pixels of inline-styled cards.

Be bold. The previous six-phase pass got the **components** right. You're getting the **composition** right.

## Frustration is justified

Operator's words on landing here: *"still a fucking mess somehow."*

That's after a six-phase refactor that:
- retired three duplicated banners
- separated Funds from Rewards from OLAS
- promoted Identity and Harness Readiness out of "Advanced details"
- decomposed `/operator` into four sub-routes
- killed the "Drifting / Waning" participation-health surface
- mounted a global Notifications surface

Each phase was structurally correct per `client/OPERATOR-APP-SPEC.md`. The dashboard is still a wall of stacked cards. The components are right; the assembly is wrong.

**Don't treat this as "polish a working UI."** Treat it as: the model is canon, the IA is broken, redraw it.

## What's canon (do not change)

- **[`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md)** — the data model. 13 components × four axes (static / streams / actions / state messages). 12-kind Notifications taxonomy. Three severity tiers. This is the contract. **Do not invent new components, new notification kinds, or new state-message categories.** Do propose spec extensions via discussion if you find a real gap.
- **[`BRAND.md`](../../../BRAND.md)** — voice + headless-brand posture. Lexicon (vessel, vow, summon, smoke, seer, wane) is protocol-level immutable.
- **[`DESIGN.md`](../../../DESIGN.md) + [`DESIGN.json`](../../../DESIGN.json)** — visual tokens. OKLCH palette, type scale, radii, spacing, motion. **You must use these tokens.** The current SPA largely doesn't — it uses inline styles with hardcoded `var(--bg-elevated)` etc. The mapping from `DESIGN.json` to SPA components is one of your jobs.
- **The six PRs in flight** (#426, #428, #431, #434, #436, #439) — leave their branches alone. Your work branches off the integration branch.

## What's shipped — and what you'll see when you walk the app

Six phases against the spec, all currently visible on the integration branch:

| Phase | PR | Surface |
|---|---|---|
| 1 — Notifications surface | #426 | Global `<NotificationsList>` mounts in `AppShell` above main. 12-kind canonical taxonomy. Severity-ordered. Currently empty in production state (most kinds need daemon-side fields tracked as #440 / #441 / #442). |
| 2 — Identity + Harness promoted | #428 | `IdentityCard` and `HarnessStatusPanel` render above the fold on `/overview` (no longer under "▸ Advanced details"). |
| 3 — Funds + Rewards split | #431 | New `FundsCard` (ETH only, per-role drill-down stub, Top up + Change password) and `RewardsCard` (claimable + claimed lifetime + Claim). Replaces the fused "Wallet" tile. `HeroStats` slimmed accordingly. |
| 4 — Real SSE stream on Activity | #434 | `/overview/activity`'s Recent section consumes `useEventStream` via a shared `<EventStreamList>`. Live indicator. |
| 5 — `/operator` decomposed | #436 | `/operator` redirects to `/operator/memberships`. Four sub-routes (Memberships, Registry, Network, Security) + existing `/operator/execution-data` (Data Donation lives here now). `OperatorSubNav` left-rail. |
| 6 — LiveNowBand retired | #439 | The BEHAVIOUR/Drifting banner is gone. Helpers preserved in `liveNowState.ts` for HeroStats's compact status tile. |

Spec gaps explicitly tracked (not your job to fix, but to be aware of):
- **#430** — daemon-side per-role ETH balances → unblocks Funds drill-down
- **#438** — should there be a §2.14 "Output Stats" component for the aggregate metrics?
- **#440** — daemon harness-readiness rollup on `/v1/status`
- **#441** — daemon `lastPasswordRotationAt` field
- **#442** — wire `claim_failed` from SSE stream
- **#443** — offline signal during bootstrap (regression of #335)
- **#444** — severity color tokens for `NotificationItem` (← partially yours; design-token adoption is part of this work)

## What you're authorized to change

- **Layout and information architecture** of any operator-facing route.
- **Visual hierarchy** — what's loud, what's quiet, what recedes into reference data.
- **Interaction patterns** — disclosures, transitions, hover states, focus order.
- **Empty states** — current ones are functional and bland.
- **Design-token adoption** — replace inline `style={...}` blocks with token-driven CSS where it improves consistency.
- **Component composition** — merging / splitting visual components (not data components — those are spec-bound).
- **Onboarding / Bootstrap UI** — see `regions/Onboarding.tsx`. Not touched by phases 1–6 but probably needs the same treatment.
- **AppShell chrome** — header, top tabs, AgentRail (the right-side rail; default-off; behind `JINN_ENABLE_EMBEDDED_AGENT=1`).

## What you are NOT authorized to change

- **The 13-component model** in `client/OPERATOR-APP-SPEC.md`. If you find the model is wrong, write a Discussion proposing a spec change — don't change behaviour silently.
- **The 12 canonical notification kinds.** Add or rename only via spec change.
- **Daemon-side API shape.** All your changes are SPA-only.
- **The six open PRs.** They stay as-is to keep responding to Ritsu's review.
- **`PRINCIPLES.md`, `SPEC.md`, `THESIS.md`, `BRAND.md`, `GROWTH.md`, `GLOSSARY.md`** — canonical root docs. Need CODEOWNERS + Discussion to change.

## Concrete audit findings — start here

These are observations from a live walk through the integration branch's SPA. They are **starting points**, not a plan; you should re-walk and form your own view.

### `/overview` — overloaded and undifferentiated

When you land on it (testnet, real operator state, harness mismatch warning active), you see (in vertical order):
1. **Header row** — jinn operator wordmark / TESTNET / RPC HEALTHY / MASTER address
2. **Top nav tabs** — DASHBOARD / SETTINGS (and conditionally LAUNCHER)
3. **SOLUTIONS DELIVERED `20`** stat tile (left)
4. **STATUS · ATTENTION** with "Selected Harness 'hermes-agent' does not support prediction.v1 restoration Tasks." + RESTART button (right)
5. **FUNDS** card — `0.0087 ETH · 1d runway`, PER ROLE button, last password cycle, TOP UP + CHANGE PASSWORD
6. **REWARDS** card — `0.0000 JINN claimable`, CLAIMED `0 JINN`, last claim never, CLAIM (disabled)
7. **NETWORK · SWE-rebench v2** stat row — TASKS 26 / ACTIVE 0 / SOLUTIONS 20 / VERDICTS 0 / SETTLED FAIL 1 / LOCAL ERR 12
8. **SOLVING ON · LIVE** — "SWE-rebench v2 · Roles · SOLVER EVALUATOR · Waiting for the next available run. · CHANGE →"
9. **IN FLIGHT · 0** — "No tasks in flight."
10. **RECENT · 0 · ● live** — "No recent activity yet."
11. **IDENTITY** — AGENT #5879 / CHAIN Base Sepolia / SAFE 0x26e9..0638
12. **HARNESS STATUS ●** — MODE TRAIN / CODE DIGEST dfac37063b9e0786…
13. **▸ ADVANCED DETAILS** — disclosure with "No additional details available." inside

That's eleven sections. They are visually indistinguishable from each other. Every card has the same border-radius, same padding, same eyebrow style, same background. Nothing rises to the operator's attention; everything competes equally.

The same concern (harness/SolverNet mismatch) appears in **four** places:
- The STATUS tile (#4): "Selected Harness 'hermes-agent' does not support prediction.v1 restoration Tasks."
- The SOLVING ON card (#8): "Waiting for the next available run."
- The HARNESS STATUS card (#12): MODE TRAIN
- Implicit in the NETWORK card (#7): SETTLED FAIL `1` + LOCAL ERR `12` colored gold/red

If `harness_not_ready` had a real daemon-side input (it doesn't yet — #440), it'd ALSO show as a Notifications row at the top. That would be five surfaces for the same fact.

The operator cannot answer **"what should I do right now"** without scrolling through 800px of stacked cards and parsing them as a human.

### `/overview/activity` — the only clean surface

Two sections, well-spaced, clearly labelled, ● live indicator on the stream. Currently empty (no events). This is the cleanest page in the SPA and shows what the rest could look like. Use it as a reference, not an outlier.

### `/operator/memberships` — sparse but functional

Left-rail nav with four small text links (Memberships / Registry / Network / Security), main area shows one membership card with EDIT button. Big empty space below. Active nav indicator (`aria-current`) is a thin highlight on the link — easy to miss.

### `/operator/registry` — empty and uninviting

"DISCOVER · 0 DISCOVERABLE · LAST REFRESHED..." with "No unjoined SolverNets available." That's it. Functional. Tells the operator nothing about what a SolverNet is, why they might want to discover one, or what's next. Empty state is a missed opportunity.

### `/operator/network` — good content, lots of empty space

Chain (locked), RPC URL with HEALTHY badge and a really useful SHARED RPC notice with links to Tenderly/Alchemy/QuickNode. The page works. But the right column is empty and the bottom 60% of viewport is dead space.

### `/operator/security` — form-only

Password rotation form (CURRENT / NEW), Rotate password button, DANGER ZONE tag. No context, no last-rotated info surfaced inline (though `lastPasswordRotationAt` will be a real field per #441). Page feels like a 1995 admin panel.

### `/operator/execution-data` — two unrelated pages mashed

Data Donation block AT TOP (toggle, eligible runs, peer datasets, IPFS DONATION ON pill, big Donation-is-on explainer paragraph) + Execution Data artifact browser BELOW (sidebar of artifacts, detail pane on right). These are two different concerns sharing a route. Should one be on a dedicated `/operator/data-donation` route, or should they integrate visually?

### `/launcher` — clean empty state

"No SolverNets created yet" + Create SolverNet button. Spare but readable. Probably the best-tuned empty state in the SPA.

### What the cards have in common

Every card on every route uses:
- `background: var(--bg-elevated)`
- `border: 1px solid var(--border)`
- `borderRadius: '10px'`
- `padding: '20px 24px'`
- Eyebrow: `text-transform: uppercase, letter-spacing: 0.14em, font-size: 11px, color: var(--fg-muted)`
- Body font: JetBrains Mono

This is the codebase's de facto pattern. It's consistent, which is good. It also means **nothing rises or recedes** — everything is the same visual weight. That's the deepest IA problem: the dashboard has no rhythm.

### What the SPA does NOT use from `DESIGN.json`

The design system defines:
- Severity tones (`--break-red`, `--accent-gold`, `--accent-sky`, `--vow-green`)
- Tonal ramps (50/100/200/.../900)
- Shadow tokens
- Motion tokens
- Radii beyond just `10px` (`--radius-1` 4px, `--radius-2` 6px, `--radius-3` 10px, `--radius-pill`)
- Spacing scale

Most of these are unused. NotificationItem renders without severity color — Ritsu specifically called this out in [#444](https://github.com/Jinn-Network/mono/issues/444).

## What good looks like

A useful target picture, not a literal mockup:

1. **Above-the-fold answer** to "what's happening, what do I do" — at most two visual elements own the operator's attention on landing. A status banner (blocking notice if any) and a primary "next thing" card. Everything else is reference, accessed by scroll or by nav.
2. **Visual rhythm** — at least three weights of surface (primary / secondary / reference) using radii + elevation + color tone. The current single-weight grid is the problem.
3. **One source of truth per concern** — the harness/SolverNet attention state is rendered exactly once, prominently. If it's in the Notifications row, it's not also on a card. If it's on a card, it's not also a notification. Pick.
4. **Empty states that orient, not just inform** — Registry empty state should explain *what discovery is* and *what joining a SolverNet means for the operator*, not just say "0 discoverable." Same for Memberships empty, Launcher empty.
5. **Notifications panel has a visible home** — even when empty. Otherwise the operator never learns it's there.
6. **Severity is visible** — `--break-red` for blocking, `--accent-gold` for warning, `--accent-sky` (or quieter) for info. Currently nothing.
7. **AdvancedDetails empty disclosure removed.** It's a stale "▸ Advanced details" button with nothing inside.
8. **Identity has a narrative**, not just labels. The operator's master / agent / Safe / service-id / agent-id are *related* — they're the operator's chain of authority. Reflect that visually.
9. **`/operator/security` orients the operator.** Today it's just a form. Add context: what is the keystore, what does rotating do, when was it last rotated (when #441 lands), what happens to in-flight work during rotation.

## Setup

### Create the worktree + branch

```bash
cd /Users/gcd/Repositories/main/mono
git fetch origin
git worktree add ../jinn-mono_worktrees/operator-app-ui-reshuffle \
  integration/operator-app-spec-alignment-review
cd ../jinn-mono_worktrees/operator-app-ui-reshuffle
# Then open a fresh Claude Code instance in this directory.
```

The integration branch carries all six phases plus their post-review fixes. The current state of `next` does **not** have this work yet.

### Branch naming

`feat/operator-app-ui-reshuffle` or split per concern (`refactor/overview-information-architecture` / `refactor/operator-app-design-tokens` / etc.). The work probably wants multiple PRs.

### Running the SPA against the live daemon

The daemon is running at `http://127.0.0.1:7331` from `/Users/gcd/Repositories/main/mono/.claude/worktrees/upbeat-vaughan-3a570b/`. Build the SPA in the new worktree, copy `client/dist/dashboard/` over the running daemon's serving dir:

```bash
cd client
yarn install --immutable
yarn build
rm -rf /Users/gcd/Repositories/main/mono/.claude/worktrees/upbeat-vaughan-3a570b/client/dist/dashboard
cp -R dist/dashboard \
  /Users/gcd/Repositories/main/mono/.claude/worktrees/upbeat-vaughan-3a570b/client/dist/
# Hard-reload Chrome on 127.0.0.1:7331
```

### If the dashboard gets stuck on "Starting jinn"

The `jinn_ui_token` cookie expires (one-shot from spawn, ~24h TTL). The on-disk token is canonical at `~/.jinn-client/ui-token`. To fix:

```js
// In Chrome DevTools console, on the http://127.0.0.1:7331 tab:
document.cookie = `jinn_ui_token=${TOKEN}; path=/; max-age=31536000; SameSite=Lax`;
```

…where `TOKEN` is the contents of `~/.jinn-client/ui-token`. Then hard-reload.

This is a paper cut worth filing as a separate Issue — the "Starting jinn" screen should distinguish 401-from-expired-cookie from genuine bootstrap-in-progress.

### Pre-existing test failures (do not try to fix)

- `test/daemon/claim-readiness-gate.test.ts`, `test/daemon/daemon.test.ts` — fail with EADDRINUSE because the operator's daemon is on port 7331. Pure environment issue.
- `HeroStats.test.tsx`, `JoinFlow.test.tsx` — some long-standing pre-existing failures.

If you don't introduce *new* failures, those are fine.

## Workflow recommendations

### Skills to invoke

This work is design-shaped. Use:

- **`impeccable`** — frontend interface audit + improvement. Calibrated for exactly this kind of "the UI is still crap" remit. It'll catch alignment, visual hierarchy, typography rhythm, anti-patterns, motion, responsive behavior.
- **`brainstorming`** — to scope what to fix first before writing any code. Don't skip this.
- **`writing-plans`** — once you have a scope, write a phased implementation plan to `docs/superpowers/plans/2026-05-21-operator-app-ui-reshuffle.md`.
- **`design:design-system`** — for the design-token adoption work.
- **`design:design-critique`** — for evaluating proposals against `DESIGN.md` and `BRAND.md`.
- **`design:accessibility-review`** — WCAG 2.1 AA audit. The operator app has real ergonomic problems (notification severity is announced inconsistently, OperatorSubNav active state is subtle, AdvancedDetails empty state is a phantom button).
- **`test-driven-development`** — when refactoring components, write the visual / behavior test first.
- **`subagent-driven-development`** — to execute the plan once written.

### Phase shape (suggested, not prescribed)

Probably wants 3–4 PRs:

1. **Design-token adoption.** Replace inline-style hardcoded values with `DESIGN.json` tokens across all components. No layout changes. Closes [#444](https://github.com/Jinn-Network/mono/issues/444). Sets up the foundation for everything else.
2. **Overview IA rebuild.** Re-rank, re-group, re-style the eleven sections. Establish visual hierarchy. This is the biggest single value delivery.
3. **`/operator/*` sub-routes polish.** Empty states, page breathing room, sidebar nav active state, integration of Data Donation vs Execution Data on `/operator/execution-data`.
4. **AppShell + Notifications surface visibility.** When the Notifications panel is empty, can the operator still tell it exists? Header chrome treatment. Top-tab refinement.

Each phase is a PR. Each PR is small enough to review in one sitting.

### What to commit your design intent to

Before any code: **commit a written brief or design audit to disk** describing what you'll change and why. This is the artifact a reviewer can engage with before you've burned a thousand commits on visual tweaks. The `brainstorming` skill produces this as a spec doc.

## Failure modes — things that have bitten me

1. **wouter, not react-router-dom.** Imports, NavLink/active-state idioms, all different. The plan I wrote for the six phases had this wrong; the implementer corrected it. Save the next debug cycle.
2. **Stale `.js` shadow files** in `client/src/dashboard/spa/src/`. The SPA accumulated compiled `.js` files from a `noEmit: false` era; they shadow `.tsx` source in Vite resolution. Sweep with `find ... -name "*.js" -delete` whenever you delete or rename a `.tsx`.
3. **Blind cast of `/v1/status` to a custom type.** The daemon returns `unknown`; the SPA frequently casts it to a hand-rolled interface and accesses fields blindly. When the field doesn't exist, you get `undefined.foo` at runtime. Adapter pattern (`mapStatusToDeriveInput` in `useNotifications.ts` is the worked example) is the safe shape.
4. **`yarn build` is required between every SPA edit.** The daemon serves the bundled SPA from disk. `yarn vitest` doesn't rebuild. Re-build before re-loading Chrome.
5. **The daemon's `jinn_ui_token` cookie can expire mid-session.** See setup notes above.
6. **HeroStats's compact status tile** at the top of Overview is a separate surface from the retired LiveNowBand banner. It still uses `deriveLiveNow` + `LIVE_NOW_STATE_LABEL` to render "WORKING / DRIFTING" copy. Whether this tile is *also* "participation health under another name" is an open question — pinned for spec discussion via [#438](https://github.com/Jinn-Network/mono/issues/438). Tread carefully if you reshape it.

## Definition of done

A reasonable bar to clear before opening any PR:

- An operator landing on `/overview` for the first time can articulate (without scrolling) what their node is doing right now, whether anything is wrong, and what their next action is.
- A returning operator with an in-flight task gets a coherent picture of progress, not eleven equal-weight cards.
- The four `/operator/*` sub-routes each feel like *one page about one thing*, with breathing room.
- Severity colors are visible. Blocking notifications are unmissable. Info notifications are quiet.
- `DESIGN.md` tokens are the source of truth; inline-style hardcoded literals are the exception, not the rule.
- Vitest suite passes (modulo pre-existing failures). New components have new tests.
- Each PR has a coherent scope and a story; reviewers can engage in one sitting.

You don't need to do everything in one go. You do need to make the dashboard *visibly less of a mess* with your first PR.

## When you're done

Open the PR against `integration/operator-app-spec-alignment-review` if it's still alive, or `next` if all six phases have merged by then. Tag the brief in the PR body. Close the relevant follow-up Issues from [#444](https://github.com/Jinn-Network/mono/issues/444), [#438](https://github.com/Jinn-Network/mono/issues/438) (if you settle the spec question), or any of the IA-shaped paper cuts you formalised along the way.

---

**Canonical references:** [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md), [`BRAND.md`](../../../BRAND.md), [`DESIGN.md`](../../../DESIGN.md), [`docs/superpowers/plans/2026-05-20-operator-app-spec-alignment.md`](../plans/2026-05-20-operator-app-spec-alignment.md), [`spec/2026-04-28-canonical-docs.md`](../../../spec/2026-04-28-canonical-docs.md).
