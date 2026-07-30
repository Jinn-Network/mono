# Jinn website redesign — platform positioning

- **Version:** 1.0
- **Date:** 2026-07-30
- **Author:** Ritsu (brainstorming session with Claude)
- **Status:** Proposed

## Context

The live site at jinn.network (`apps/website/index.html`) tells the personal-agent story from the 2026-07-07 positioning spine ("an agent that gets better as more people use it"). The [2026-07-29 platform one-pager](../../positioning/2026-07-29-jinn-platform-one-pager.md) repositions Jinn as **an open protocol and market for work and the evidence that work creates**, coordinating three market roles (work demand, work-and-evidence supply, evidence demand).

Decision made in this session: **the one-pager supersedes the spine as the story jinn.network tells.** This spec defines the website that tells it.

## Decisions

| Question | Decision |
|---|---|
| Positioning | Full repositioning — platform/market story replaces the personal-agent story |
| Primary reader | Ecosystem/strategic reader — the site's job is to make the wager understood, not to convert one role |
| CTA | Two tiers: primary = Telegram; evidence links (explorer, GitHub) promoted into the body |
| Scope | One page. No thesis page — long-form stays in `docs/positioning/` (linked from footer via GitHub); the homepage *is* the argument, compressed |
| Reference pattern | thegraph.com structure (roles cards, live stats, 3-step how-it-works), ethereum.org contrast sections, olas.network live-stat flywheel |
| Stack | Unchanged: single static `index.html`, no framework, manual `vercel deploy --prod` |
| Visual system | Unchanged: existing tokens (deep-blue ground, gold accents, Instrument Serif + JetBrains Mono, softened-brutalist radii). This redesign changes what the page says, not how Jinn looks |

## Copy rules

1. **No term appears before a cold reader can parse it.** The reader needs zero prior Jinn context. "Evidence" is replaced on-page by the concrete thing it is — *the record of how the work was done*. Every abstract noun from the one-pager (evidence, provenance, substrate, corpus) either becomes a plain phrase or gets a concrete example in the same sentence.
2. **Say "AI agents" out loud.** The one-pager is protocol-agnostic but assumes agents as primary performers; the homepage leads with agents because that is what a cold visitor instantly understands.
3. Standing rules apply: `BRAND.md` non-negotiables (no emoji, no decorative gradients, plain words on money), no "paid/pays" for protocol actions (performers **earn** OLAS), "show, don't narrate" (no helper-text cruft).
4. Copy source of truth is the one-pager; check copy changes against it. `apps/website/README.md` pointer updates from the spine to the one-pager.

## Page sections (scroll order)

1. **Header** — sigil + wordmark, "Testnet" chip. Unchanged from current site.

2. **Hero** — H1: **"Open work that compounds."**
   Sub: *"Jinn is an open market for work done by AI agents. Every job delivers a result to whoever asked — and leaves a verifiable record of how it was done, which anyone can build on."*
   Primary CTA: Join the Telegram. Secondary quiet link: "Watch the network live →" (explorer).

3. **Live network strip** — 4 real counts fetched from the indexer: **tasks posted, attempts, SolverNets running, operators** (`tasksPosted`, `attempts`, `solverNetsRunning`, `everAttemptedOperators`). Each number links to the relevant explorer route. A metric renders only when its value is above zero; if none are, or the fetch fails, the strip shows the plain "Watch the network live →" explorer link. No spinners, no zeros, no loading states.

4. **How it works** — the loop as a horizontal HTML/CSS visual: `request → execute → evaluate → outcome + record → reuse`. Caption: *"A normal marketplace ends at result and payment. Jinn also keeps the record — so the next job, and everyone else's, starts smarter."* (This absorbs the one-pager's "What makes Jinn different" section — same idea, rendered once.)

5. **Three roles** — cards in The Graph's ecosystem-roles pattern. Each: title, one plain sentence, concrete examples, one action.
   - **Get work done** — "Post a task and fund it. An agent picks it up, does it, and the result is checked before you receive it. Patches, reports, datasets, forecasts." → Telegram.
   - **Put your agent to work** — "Run an agent that performs tasks. Work that passes verification earns OLAS." → Telegram.
   - **Build on the work records** — "Every job leaves a public trace: what was asked, what the agent did, what it produced, how it was judged. Use those records to benchmark models, score performers, train agents, or distill skills." → Explorer.

6. **Open by design** — the strategic wager as an ethereum.org-style contrast: *Closed systems* (each project learns only from its own work) vs *Jinn* (projects pool the records of their work; benefits flow back to every participant). Ends with the wager sentence from the one-pager. Includes one honest line on the tradeoff: work that must stay private is a poor fit, and that is deliberate.

7. **Built on Jinn** — platform boundary. One sentence on what Jinn itself is responsible for (coordinating open work, keeping the records, making them usable), then the applications list (benchmarking platforms, reputation systems, skill factories, dataset builders, harness optimizers, agent-memory products…) as a compact grid. Frames everything beyond the boundary as applications, not Jinn.

8. **Closing CTA** — one line + Telegram button.

9. **Footer** — sigil; links: explorer, GitHub repo, the one-pager on GitHub.

**Cut from the current site:** the terminal demo, the trust/scrubbing section, and the OLAS-earning block — all personal-agent-story surfaces. Performer earning is one plain sentence in the "Put your agent to work" card.

## Diagrams

The loop (section 4) and closed-vs-pooled contrast (section 6) are built as HTML/CSS (bordered boxes, arrows, mono type) in the same visual family as the current site's terminal card. No image assets.

## Live stats implementation

One small inline `<script>` — the only JavaScript on the page — client-side-fetches the counts from the same indexer endpoint the explorer uses. Fail-silent per section 3 above.

Verified live 2026-07-30:

- **Endpoint:** `GET https://jinn-indexer-production.up.railway.app/explorer/network` — **REST returning JSON, not GraphQL** (`packages/indexer/explorer/src/lib/api.ts` is the reference for response shapes). Responds `200` with `access-control-allow-origin: *`, so a cross-origin fetch from jinn.network works with no proxy.
- **Current values:** `tasksPosted: 1208`, `attempts: 125`, `solverNetsRunning: 8`, `everAttemptedOperators: 6`.
- **`verdicts` is currently `0`** and is therefore excluded from the metric set. The above-zero filter makes adding it back safe whenever it starts counting.
- **Explorer routes for the number links:** `/` (tasks, attempts), `/solvernets`, `/operators`.

## Domain model (per the frontend spec rule)

One read-only page.

- **State:** live network counts (read-only, derived from the indexer; render-or-omit).
- **State messages:** none. The stats-fetch failure state is expressed structurally (strip renders the explorer link instead of numbers), not as a message.
- **Collections:** none. The stats strip is a fixed set, not a paginated collection.
- **Actions:** outbound links only (Telegram, explorer, GitHub) — no lifecycle.

## Out of scope / same-PR housekeeping

- **Spine supersession:** `docs/positioning/2026-07-07-jinn-positioning-spine.md` gets a superseded-by note pointing at the one-pager (per the spine's own rule that derived surfaces and spine must not contradict).
- **README update:** `apps/website/README.md` copy-source pointer moves to the one-pager; domain-model paragraph updates to match this spec.
- **One-pager committed:** `docs/positioning/2026-07-29-jinn-platform-one-pager.md` (filename typo `platfrom` corrected on commit) — previously untracked.
- **Not in scope:** multi-page site, per-role landing pages, docs site, blog, analytics, dark/light toggle, nav menu. Revisit per-role pages when there are product surfaces to route to.

## Success criteria

1. A visitor with zero Jinn context can say what Jinn is after the hero, and what the three ways in are after the roles section.
2. Every number on the page is a real network number linking to the explorer, or absent.
3. Copy checks clean against the one-pager and `BRAND.md` non-negotiables.
4. Page remains a single static HTML file deployable by the existing manual flow.
