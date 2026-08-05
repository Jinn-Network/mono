# WEBSITE-APP-SPEC

> Canonical specification of the jinn.network apex site — the landing page, the docs
> tree, and the machine-readable surfaces compiled from it.
>
> **What this doc is.** A model of *what* the site shows, *what* a visitor can do, and
> *how* the site surfaces things that need attention. Spec, not implementation. It is the
> sibling of [`../../packages/indexer/explorer/EXPLORER-APP-SPEC.md`](../../packages/indexer/explorer/EXPLORER-APP-SPEC.md)
> and [`../../client/OPERATOR-APP-SPEC.md`](../../client/OPERATOR-APP-SPEC.md) and follows
> the same modelling discipline. Changes go through CODEOWNERS review; see
> [`../../spec/2026-04-28-canonical-docs.md`](../../spec/2026-04-28-canonical-docs.md).
>
> **What this doc is not.** It is not the copy itself, not the positioning, and not the
> deploy runbook. Copy derives from the platform architecture
> ([`../../docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md`](../../docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md) §11)
> and the platform one-pager
> ([`../../docs/positioning/2026-07-29-jinn-platform-one-pager.md`](../../docs/positioning/2026-07-29-jinn-platform-one-pager.md)).
> The surface this site belongs to is designed in
> [`../../docs/superpowers/specs/2026-08-03-devx-surface-design.md`](../../docs/superpowers/specs/2026-08-03-devx-surface-design.md)
> (§4 the web property, §5 the information architecture). Voice and posture are
> [`../../BRAND.md`](../../BRAND.md); tokens are [`../../DESIGN.md`](../../DESIGN.md).
> Deploy facts are [`README.md`](README.md).

## 1. Modelling discipline

The site is a set of **surfaces** — top-level concepts a visitor works with. Each surface
is described along four axes:

- **Static** — point-in-time values shown to the visitor.
- **Collections** — lists of data items the surface owns, with item shape and ordering.
- **Actions** — verbs the visitor can invoke against the surface.
- **State messages** — notices the surface raises when it needs the visitor's attention.

A field belongs to exactly one surface. A surface may have zero entries on an axis, but
this document must say so — silence is ambiguous.

**Divergence from the explorer spec (deliberate, and the largest one).** The explorer has
a data source: it polls an indexer, renders freshness, and degrades when the indexer is
behind. **This site has no data source at all.** Every page, the search index, and the
`llms*.txt` corpus are build-time outputs of the repository's own content tree
(`next.config.mjs` sets `output: 'export'`). There is no runtime server, no fetch, no
polling, no freshness surface, and no degraded state. The predecessor static brochure did
fetch live network counts from the indexer; that behavior is **removed**, because a
build-time site cannot have a stale-data state and the counts are the explorer's job.

The site holds no keys, signs nothing, connects to no wallet, and mutates no on-chain
state. Every Action is a view-state change, a clipboard write, or a link. A proposed
Action that writes to a chain, a wallet, or any remote is out of model.

## 2. Surfaces

### 2.1 Chrome

The persistent shell: the Fumadocs nav bar over both the landing page and the docs tree.

- **Static**
  - wordmark — the vessel sigil plus Instrument Serif italic "jinn"; transcribed from
    `docs/design/jinn-design-system/project/assets/logo-wordmark.svg`, not redrawn; links
    to `/`
  - nav items — `Build` (`/docs/build`), `Operate` (`/docs/operate`), `Explorer`
    (external); active-route detection is prefix-match
  - repository link — the GitHub icon link to `Jinn-Network/mono`
- **Actions**
  - navigate — via nav item or wordmark
  - open search — the docs search dialog (§2.3)
- **Collections** — none
- **State messages** — none. There is no theme toggle: the site is dark-only (§3.3).

### 2.2 Landing router

The apex page (`/`). Its job is to say what Jinn is and route the visitor to one of two
doors. It persuades; it does not transact.

- **Static**
  - the identity paragraph — DR-2026-07-30 §11, the ratified newcomer paragraph
  - the loop — five steps (Request, Execute, Evaluate, Deliver, Publish)
  - the boundary — what the platform is responsible for, and what is a product built on it
  - the caveats — the "what this does not yet prove" list, carried from §11 with its
    source linked. This section is not optional and does not shrink: a milestone surface
    that omits its own gap is less Legible, not more.
- **Collections**
  - doors — exactly two: *Build on Jinn* (`/docs/build`) and *Run an operator*
    (`/docs/operate`). Each carries a title, one sentence of scope, and one line of honest
    status. They are **navigation**, not calls to action.
- **Actions**
  - **join the community** — the single call to action, an outbound link to the Telegram
    group. No lifecycle. GROWTH.md §3 binds every outward surface to one CTA until the v0
    gate produces a result, so there is exactly one button element on this page. Adding a
    second ask is a GROWTH.md amendment, not a UI change; the proposal that would license
    it is
    [`../../docs/proposals/2026-08-04-growth-cta-amendment-DRAFT.md`](../../docs/proposals/2026-08-04-growth-cta-amendment-DRAFT.md).
  - enter a door — navigate to `/docs/build` or `/docs/operate`
  - outbound links — explorer, repository, the source spec, `/llms.txt`. No lifecycle.
- **State messages** — none. Nothing on this page can fail.

### 2.3 Docs tree

The reading surface (`/docs/**`), rendered by Fumadocs over MDX in `content/docs/`.

- **Static**
  - current page — title, description, body, table of contents
  - sidebar tree — derived from the file tree and the `meta.json` ordering files; the two
    doors are top-level folders
  - search query
- **Collections**
  - pages — eleven at v1: `index`; `build/{index, quickstart, request-from-your-app,
    custody, consume-evidence, implement-the-platform}`; `operate/index`; `machine/index`;
    `reference/index`; `community`. Order within a folder comes from that folder's
    `meta.json`, not from the filesystem.
  - search results — title, description, and heading matches, ranked by the search client
- **Actions**
  - navigate — sidebar, in-page links, table of contents
  - search — opens the dialog, queries the static index (`/api/search`), selects a result.
    The index is built at build time and queried entirely in the browser; there is no
    search server.
  - copy — the prompt block's clipboard action (§2.4)
- **State messages**
  - not yet written — every page that is a stub carries a **dated** notice naming what it
    will contain and what is accurate to read instead. This is honesty discipline, not
    apology: the notice states the gap and points at the truth. It carries no action.
  - no search results — the dialog's empty state
  - unknown path — the 404 page

**Docs are authored, not mirrored.** These pages are new content written for readers
outside the repository. The site never renders or copies the repository's internal
`docs/`, `spec/`, or `log/` trees; where the detail lives in-repo, a page links out to
GitHub and says in one line what is there. A page that restates an internal document is a
page that will rot against it.

### 2.4 Prompt block

The one composed component the site owns (`components/prompt-block.tsx`): a block of text
meant to be lifted whole — a shell command, or a prompt handed to an agent.

- **Static** — a label and the literal text
- **Collections** — none
- **Actions**
  - **copy** — writes the block's text to the clipboard.
    Lifecycle: `idle → copied → idle` (2s), with `failed` as the terminal alternative when
    the Clipboard API is unavailable or refuses (insecure origin, denied permission). The
    reset timer runs from either outcome. `failed` is a real rendered state, not a silent
    no-op — a copy button that does nothing when clicked is worse than one that says it
    could not.
- **State messages** — the `failed` label is the message; there is no separate banner.

Composed from the shadcn `Button` primitive plus native `pre`/`code`, per the frontend
rule that UI primitives come from shadcn and are composed rather than reinvented. It is
not a snowflake: no custom control is authored, only an arrangement of one.

### 2.5 Machine surfaces

What an agent reads instead of the HTML pages. Not a nav entry; a first-class deliverable.

- **Static**
  - `/llms.txt` — the index: one line per docs page, with its URL and description
  - `/llms-full.txt` — every docs page body, concatenated
  - `/api/search` — the static search index the docs dialog queries
- **Collections** — the same page set as §2.3, by construction
- **Actions** — retrieval only
- **State messages** — unknown path → 404

All three are compiled from the same `content/docs/` tree the HTML pages are built from
(`lib/source.ts`). There is no separately maintained agent copy, so divergence between the
human and machine surfaces is structurally impossible rather than merely discouraged.

**What deliberately does not live here.** The protocol document root — profile, schema,
record, and task-profile documents, and their digest manifest — is **not** served by this
site. DR-2026-08-04 moved the identifier origin to `spec.jinn.network`. The apex serves
only the product site. There is therefore no `/profiles`, `/records`, `/schemas`,
`/prompts`, `/task-profiles`, or `/manifest.json` route, and no header or rewrite
machinery for one. `scripts/check-links.mjs` fails the build if any of those paths
reappear.

## 3. Cross-cutting concerns

### 3.1 Routes

| Route | Surface |
| --- | --- |
| `/` | Landing router (§2.2) |
| `/docs` | Docs tree index (§2.3) |
| `/docs/build/**` | Door 1 pages |
| `/docs/operate/**` | Door 2 pages |
| `/docs/machine` | Machine-surface index |
| `/docs/reference` | Generated reference (placeholder at v1) |
| `/docs/community` | Community links |
| `/llms.txt`, `/llms-full.txt` | Machine surfaces (§2.5) |
| `/api/search` | Static search index (§2.5) |
| anything else | 404 |

### 3.2 Design tokens: three layers, one bridge

`styles/colors_and_type.css` and `styles/foundations.css` are **byte-identical copies** of
`docs/design/jinn-design-system/project/`, never edited. The copy is guarded:
`.github/scripts/website-design-tokens.test.mjs` fails CI on any drift. This follows the
explorer's precedent (`packages/indexer/explorer/src/styles/`) with the guard added, which
the explorer does not have — its `colors_and_type.css` has already drifted from the source.

`styles/theme.css` is the one editable file in that directory. It is a bridge, not a
palette: every value is a `var(--…)` pointing back at a copied token. It maps the design
system onto the two consumers that do not know about it — Tailwind v4's `@theme` scale
(which is also how shadcn components resolve `bg-primary`, `bg-accent`, `border-border`,
`ring-ring`) and Fumadocs' `--color-fd-*` variables.

Import order in `app/globals.css` is load-bearing and must not be reordered:

1. `tailwindcss` — preflight and the utility engine
2. the two design-system copies — canonical variables and the element baseline
3. `fumadocs-ui/css/neutral.css` + `preset.css` — docs chrome and prose
4. `styles/theme.css` — the bridge, last, so it wins over 2 and 3

Naming is ported from `client/src/dashboard/spa/tailwind.config.ts`: shadcn's semantic
names plus the brand-only tones with no shadcn equivalent (`sunken`, `elevated`, `dim`,
`gold`, `wane`, `vow`). Source variables use the canonical design-system names, so the
SPA's local aliases `--accent-sky` / `--accent-gold` appear here as `--accent` / `--gold`.
No `tailwind.config.ts` exists; Tailwind v4 is CSS-first.

Two collisions between the layers are handled in `theme.css` rather than by editing the
copies:

- the copies' `@import` of Google Fonts is hoisted away by the CSS bundler, so the two
  families are re-pointed at self-hosted `next/font` faces. Same faces, own origin.
- the copies set element-level display sizes (`h1` at 88px serif), which is right for the
  landing page and wrong inside docs prose where Fumadocs' typography owns the scale. The
  element defaults are scoped out of the docs reading column.

### 3.3 Dark only

The site ships one theme. The design system is dark-first ("the protocol lives in a deep
blue night"), the explorer is dark-only, and shipping one narrative means the three CSS
layers need one reconciliation instead of two. The theme switcher is disabled, not hidden.
The design system's `[data-theme="light"]` block remains in the copies, unused.

Under BRAND.md's headless posture this is a **narrative** choice, not a protocol one: a
fork may re-skin it. It is recorded here rather than left implicit.

### 3.4 Content non-negotiables, enforced

- **No emoji.** Asserted over `content/`, `app/`, and `components/` by
  `test/content.test.mjs`.
- **No decorative gradients.** The design system's `.texture-*` helpers are available but
  unused; the site's only surfaces are flat fills and hairline borders.
- **Softened-brutalist corners.** Tailwind's radius scale is re-pointed at
  `--radius-1/2/3`; nothing is square by default and nothing is a pill outside status
  chips.
- **Show, don't narrate.** No caption, legend, or footnote whose only job is to restate
  what the page already displays or to describe where a link goes. If a term needs
  explaining, it gets a tooltip; prose is reserved for empty states and error states,
  where plain words are the content.
- **Verb discipline.** Operators *earn*; the protocol *escrows*, *settles*, *records*.
  "Paid", "pays", "compensation", "proven", and "guaranteed" are asserted absent by
  `test/content.test.mjs`.

### 3.5 Link integrity

`scripts/check-links.mjs` runs in CI and fails on any internal link that does not resolve
to a real page, and on any reappearance of the retired document-root paths (§2.5). The
repository's own history is the motivation: the 2026-07-23 audit found 220 references to a
single deleted path. Nothing on this surface is prose-only.

## 4. Open questions

Unresolved spec questions, not implementation work.

- **Onboarding artifacts (DevX §6).** The pasteable prompts, the installable plugin, and
  the MCP server are designed but not built. When the prompts ship they become a fourth
  surface with their own digest-bound identity, and the two doors gain a copy block above
  the prose. What that does to the single-CTA constraint is the subject of the growth
  amendment draft, not of this spec.
- **Generated reference (DevX §7.3).** `/docs/reference` is a placeholder. The generator —
  Zod schemas to JSON Schema to pages, with golden fixtures as the examples — does not
  exist. Whether the generated pages live in this tree or are emitted into it at build
  time is open.
- **Deploy.** Deploys are manual (`vercel deploy --prod`). Moving them into CI is a
  follow-up; the trade is between a green-CI gate on the apex domain and the current
  ability to ship without one.
- **The two doors as CTAs.** Door polish is bounded by GROWTH.md §3 until the v0 gate.
  See the proposal draft named in §2.2.
