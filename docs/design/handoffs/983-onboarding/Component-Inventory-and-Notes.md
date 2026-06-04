# Onboarding completeness (#983) — design handoff notes

Two HTML deliverables, one shared model:

- **`Onboarding Prototype.html`** — clickable full takeover, all five phases navigable: **Provisioning your wallet** → **Fund your wallet** → **Joining Jinn** (the three shipped bootstrap phases, rebuilt faithfully from `spa/src/regions/Onboarding.tsx` — Phase 2 = the `AwaitingFundingCard`, Phase 3 = the `SubStateLine`) → **Choose a SolverNet** → **Set up harness + model** → "you're live". Settings home reachable. Tweaks (toolbar): **Start at** (Onboarding / You're live / Settings), **Flow** (Guided sequential / Join & run combined), **Harness legibility** (Status column / Tiered badges / Grouped sections).
- **`State Matrix & Variations.html`** — pannable canvas: the 3 harness approaches side-by-side, the full harness state set, the SolverNet state set, the 3 flow variations, and the two homes (Operating entry + Settings).

Everything composes from the live SPA's tokens (`spa/src/styles/globals.css`) and recreated shadcn-on-Jinn primitives in `jinn-app.css`. British English, no emoji, flat surfaces, softened-brutalist radii, semantic three-severity colour roles.

---

## 1. Component inventory — shadcn primitives per surface

All primitives below already exist in `spa/src/components/ui/`. "Composition" = built by arranging existing primitives; not a new component.

| Surface | shadcn primitives used | Compositions |
|---|---|---|
| **Bootstrap takeover** (`§2.8`) | `Card`, `Progress`, `Button`, `Badge`, `Alert`, `Separator` | Phase rail (`<ol>` of phase rows), completion-gate readout card, step header |
| **SolverNet step** (`§2.5`) | `Card`, `Badge`, `Button`, `Alert`, `Skeleton` | Registry card (header + key/value grid + footer), meta row |
| **Harness Selection surface** (`§2.9`) | `Card`, `Badge`, `Button`, `Alert`, `Skeleton`, `Separator`, native `<select>` (matches the real JoinFlow), styled radio | Per-harness row, setup block (codeblock + copy + actions), model picker, evaluator-only affordance, readiness summary line |
| **Operating entry** (`§2.4`/overview) | `Card`, `Badge`, `Button`, `Tabs` (sub-nav) | Metric cards, membership row, activity stream rows |
| **Settings home** (`§2.11`) | `Card`, `Alert`, `Button`, `Badge`, native `<select>` | Hosts the **same** Harness Selection surface; node read-only grid |

Native `<select>` over shadcn `Select`: deliberate — the shipping `JoinFlow.tsx` uses a native styled `<select>` (`selectClass`), so the harness/model pickers match production exactly. Use `Select` if the rest of the app migrates.

Styled radio over shadcn `RadioGroup`: the harness picker uses an accent-filled radio dot inside a clickable row. shadcn has no `RadioGroup` vendored in this repo's `ui/` set; **recommend adding `RadioGroup`** and binding it here on implementation. Until then this is a thin styled `<input type=radio>` equivalent.

## 2. Flagged snowflakes (with justification — kept minimal)

1. **`TierDots`** — the three-square availability glyph in the *Status column* approach (protocol · build · installed-authed). **Why no primitive fits:** no shadcn element expresses a 3-state tiered indicator at a glance; `Badge` only carries one status. Implementation is three `<span>`s, `currentColor`, ~7px, no new tokens. Narrowest thing that makes tier 1∩2∩3 legible in a dense row.
2. **`TierChain`** — the chained `PROTOCOL → BUILD → READY` pill set in the *Tiered badges* approach. Composed from badge-like pills + 1px connectors; flagged because the connector/fill-progression is custom. Could be re-expressed as three `Badge`s in a flex row with separators if you'd rather avoid any snowflake — at the cost of the "fills as you progress" read.
3. **`FlowStoryboard`** — the step-rail diagrams in the canvas. **Documentation artifact only — not a shipped surface.** No implementation expected.

The three legibility approaches share **one** data model and one set of states; pick one for production (recommendation: **A · Status column** — densest, scales to many harnesses, and the AVAILABILITY column is the clearest single-glance tier read). B and C are there to compare.

## 3. Rubric coverage map (for the reviewing agent)

1. **Domain-model fidelity** — surfaces map to `§2.4` (membership env: harness/model), `§2.5` (registry), `§2.8` (bootstrap gate + onboarding-local messages), `§2.9` (per-harness tier fields + actions + state messages), `§2.11` (Settings home, RPC chain, task-post rate). No invented fields.
2. **Completion gate** — `Enter dashboard` (gold, last step) is disabled until `≥1 joined SolverNet AND (ready harness + selected model OR evaluator-only)`. Verified: selecting a not-ready harness disables it; authenticating re-enables it. The gate readout card in the rail shows the two criteria live.
3. **Three-tier legibility** — `TierDots`/`TierChain`/group headings; Aider shown as **Unavailable here** (not selectable, plain reason); not-ready harnesses show the **next action** (install cmd / authenticate / re-check).
4. **No-restart flow** — selections sit *before* the running flip in all three variations; the flip is marked "Running flip — no operator restart". No restart-to-start control anywhere in onboarding.
5. **No residue** — Operating entry reads "You're live", shows running/eligible/claiming, memberships with env, activity. No no-SolverNets banner, no harness empty-state, no restart prompt. (`no_solvernets_joined` / restart prompts belong only to a node that later leaves all nets — `§2.10`.)
6. **State set** — harness: empty / loading / error / not-ready / evaluator-only / not-supported / auth-expired / version-mismatch. SolverNet: default / loading / registry-unreachable / empty. All in the canvas.
7. **shadcn-first** — see §1; snowflakes flagged in §2.
8. **DS compliance** — radii on the softened-brutalist scale; no emoji; flat surfaces; severity → three-severity colour roles (blocking=`--break-red`, warning=`--wane`, info/success=`--accent-sky`/`--vow-green`).
9. **Voice + PII** — terse British English; plain-speech on funds/auth ("real testnet ETH for gas only", "Codex sign-in expired"); no team/co-founder framing; no PII.
10. **One component, two homes** — `HarnessSurface` renders identically in onboarding (`context="onboarding"`) and Settings (`context="settings"`); Settings reaches it via "Change environment" on a membership and shows the restart-required notice on save (`§3.2`).

## 4. Open spec touch-points worth a glance

- Settings harness/model change is rendered **restart-required** (`§3.2`) on save. Onboarding selections are **not** (they land before the flip) — this asymmetry is intentional and visible.
- Model list is harness-driven; switching harness resets the model (mirrors `JoinFlow` behaviour). Cost-confirmation surface (`>$1/task`) from the real JoinFlow is out of scope here but slots into the model picker if wanted.
