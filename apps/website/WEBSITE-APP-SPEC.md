# WEBSITE-APP-SPEC

> Canonical specification of the jinn.network apex site — the landing page, the docs
> tree, and the machine-readable surfaces compiled from it.
>
> **What this doc is.** A model of *what* the site shows, *what* a visitor can do, and
> *how* the site surfaces things that need attention. Spec, not implementation. It is the
> sibling of [`../../packages/indexer/explorer/EXPLORER-APP-SPEC.md`](../../packages/indexer/explorer/EXPLORER-APP-SPEC.md)
> and [`../operator-console/OPERATOR-APP-SPEC.md`](../operator-console/OPERATOR-APP-SPEC.md) and follows
> the same modelling discipline. Changes go through CODEOWNERS review; see
> [`../../spec/2026-04-28-canonical-docs.md`](../../spec/2026-04-28-canonical-docs.md).
>
> **What this doc is not.** It is not the copy itself, not the positioning, and not the
> deploy runbook. Copy derives from the canonical documents:
> [`../../THESIS.md`](../../THESIS.md) §3 and §4 for what Jinn is, what exists today and
> what is direction; [`../../GLOSSARY.md`](../../GLOSSARY.md) for record, holder, offer and
> price; [`../../GROWTH.md`](../../GROWTH.md) §3 for the call to action; and the root
> [`../../README.md`](../../README.md) for Colophon. The protocol is written only in
> [Jinn-Network/spec](https://github.com/Jinn-Network/spec).
> The web property this site belongs to is designed in
> [`../../docs/superpowers/specs/2026-08-03-devx-surface-design.md`](../../docs/superpowers/specs/2026-08-03-devx-surface-design.md)
> (§4). That design's information architecture (§5) has two doors into the task
> marketplace, which is parked; §2.2 and §2.3 below replace it for this site. Voice and
> posture are [`../../BRAND.md`](../../BRAND.md); tokens are
> [`../../DESIGN.md`](../../DESIGN.md). Deploy facts are [`README.md`](README.md).
>
> **The story the site tells (2026-10-12).** Jinn is an open protocol and network for work
> and the data it produces. The protocol, the published checker and Colophon's sealed
> benchmark claims exist today. Buying and selling records is the direction, not a working
> market. The task marketplace is parked. The site says each of these as what it is, and
> offers a visitor only what exists: no stub pages and no notice of something to come.

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
  - nav items: `Docs` (`/docs`), `Protocol` (external, the specification repository),
    `Colophon` (external); active-route detection is prefix-match. The explorer is not a
    nav item: it is a record of the parked network, linked only where a page says so
    (§2.2)
  - repository link — the GitHub icon link to `Jinn-Network/mono`
- **Actions**
  - navigate — via nav item or wordmark
  - open search — the docs search dialog (§2.3)
- **Collections** — none
- **State messages** — none. There is no theme toggle: the site is dark-only (§3.3).

### 2.2 Landing router

The apex page (`/`). Its job is to say what Jinn is today, to a visitor who has never
heard of it, and route them to one of three doors. It persuades; it does not transact.

It shows one line per idea and leaves the detail to the docs. A release date, a runtime
version or a test network's history belongs on a docs page, not in a visible line here. Where
the page needs more than a line, the line stays visible and the detail opens beneath it.

- **Static**
  - the hero: one headline that leads from the gap (BRAND.md "Lead from structure, not
    from fear") and one sentence with the canonical noun, "an open protocol and network
    for work and the data it produces", what anyone can do with a record (check it from
    its own bytes, with their own tools), and that the protocol takes no fee and there is no
    Jinn token
  - the checker run: the passing output the published checker prints for the public claim
    that `/docs/check-a-claim` checks, abridged from that page, with the claim named. It is
    the page's one picture of a record being checked. When the docs page changes its
    claim or its pinned checker version, this changes with it
  - how a record moves: five steps (Record, Check, Offer, Find, Buy), one line and one
    icon each. The first four are in the protocol today. The fifth is marked as direction
    and says, in its own line, that buying records is the direction, not a working market.
    A holder offering a record, free or priced, is said here
  - the first application: Colophon, named and linked, with what it does and what it does
    not offer (no hosted service, account or billing)
  - where things stand: three short lists, kept apart. *Exists today* (the protocol,
    Colophon's checker, Colophon's sealed claims), *Direction* (a market in records; the
    next application's records) and *Parked* (the task marketplace)
  - the caveats: the "what this does not yet prove" list. Every caveat is always visible
    as a one-line statement; its explanation and its linked source open beneath it. One
    always-visible line under the list links every source, so the page carries them
    without script. The section is not optional and no caveat is dropped: a surface that omits its own gap is
    less Legible, not more.
- **Collections**
  - doors: exactly three. *Check a claim* (`/docs/check-a-claim`), *Find a claim*
    (external, Colophon's listing) and *Build on the protocol* (`/docs/protocol`). Each
    carries a title, one sentence of scope, and a short status label. They are
    **navigation**, not calls to action, and each leads to something that works today. A
    door for something parked or not yet built is out of model.
- **Actions**
  - **bring a claim**: the single call to action, in the hero, an outbound link to the
    part of Colophon's site that says how a claim is brought today. No lifecycle.
    GROWTH.md §3 names "Bring a claim" as the single call to action on every outward
    surface, so there is exactly one button element on this page. A second ask is a
    GROWTH.md amendment, not a UI change.
  - enter a door: navigate to `/docs/check-a-claim` or `/docs/protocol`, or leave for
    Colophon's listing. The hero's "Check a claim" link is this action, not a second ask.
  - open a caveat: show or hide that caveat's explanation and source. Any number may be
    open at once. Lifecycle: `closed -> open -> closed`; nothing persists.
  - outbound links: the specification repository, the published checker, Colophon, this
    repository, `/llms.txt`, and the explorer. No lifecycle. Every explorer link is
    labelled, in its own words, as the record of what ran on the parked network; it is
    never offered as a live network.
- **State messages**: none. Nothing on this page can fail.

### 2.3 Docs tree

The reading surface (`/docs/**`), rendered by Fumadocs over MDX in `content/docs/`.

- **Static**
  - current page — title, description, body, table of contents
  - sidebar tree: derived from the file tree and the `meta.json` ordering files
  - search query
- **Collections**
  - pages: six. `index` (what exists, what is direction, what is parked);
    `check-a-claim` (the one thing a stranger can run today: the published checker over a
    published claim); `protocol` (where the protocol is written and how to build on it);
    `task-marketplace` (the parked marketplace, named as parked, with where its design and
    its record live); `machine/index`; `community`. Order comes from the `meta.json`
    files, not from the filesystem. A page exists only for something that exists: a page
    that says its subject is not written yet is out of model, and so is a page that walks
    a parked flow as if it were live.
  - search results — title, description, and heading matches, ranked by the search client
- **Actions**
  - navigate — sidebar, in-page links, table of contents
  - search — opens the dialog, queries the static index (`/api/search`), selects a result.
    The index is built at build time and queried entirely in the browser; there is no
    search server.
  - copy — the prompt block's clipboard action (§2.4)
- **State messages**
  - no search results — the dialog's empty state
  - unknown path — the 404 page

**Docs are authored, not mirrored.** These pages are new content written for readers
outside the repository. The site never renders or copies the repository's internal
`docs/`, `spec/`, or `log/` trees; where the detail lives in-repo, a page links out to
GitHub and says in one line what is there. A page that restates an internal document is a
page that will rot against it.

**Commands are checked, pinned and published.** A command on a docs page is one a stranger
can run today, exactly as written. It names an exact published version, and no page tells a
visitor to install or run a package that is not published. `test/content.test.mjs` asserts
the pin and the package; the `check-a-claim` commands were run as written before they were
committed.

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
| `/docs/check-a-claim` | Run the published checker over a published claim |
| `/docs/protocol` | Where the protocol is written, and how to build on it |
| `/docs/task-marketplace` | The parked task marketplace, named as parked |
| `/docs/machine` | Machine-surface index |
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
- **Verb discipline.** The verbs are `CLAUDE.md` "External Communication". The protocol
  takes no fee and no part in payment, so it is never the subject of a payment verb:
  payment for a priced record *goes straight to the holder, outside the protocol*. A
  holder *offers* a record; anyone can *check* and *find* one. "Paid", "pays",
  "compensation", "proven", "guaranteed", "co-founder", "team" and "executive" are
  asserted absent by `test/content.test.mjs`.
- **What exists and what is direction stay separate.** Wherever buying or selling records
  appears, the same passage says it is the direction, not a working market. Nothing
  presents posting a task, running an operator, staking, escrow or settlement as
  something a visitor can do today. `test/content.test.mjs` asserts that no parked
  command, package or route appears in the site's copy.
- **No em dashes in copy.** Asserted over the copy sources by `test/content.test.mjs` and
  over the rendered pages and machine surfaces by `test/build-output.test.mjs`.

### 3.5 Link integrity

`scripts/check-links.mjs` runs in CI and fails on any internal link that does not resolve
to a real page, and on any reappearance of the retired document-root paths (§2.5). The
repository's own history is the motivation: the 2026-07-23 audit found 220 references to a
single deleted path. Nothing on this surface is prose-only.

## 4. Open questions

Unresolved spec questions, not implementation work.

- **Onboarding artifacts (DevX §6).** The pasteable prompts, the installable plugin, and
  the MCP server were designed for the two doors this site no longer has. They are not
  built and the site does not mention them. Whether any of them returns for the protocol
  or for Colophon is open.
- **Generated reference (DevX §7.3).** The site has no reference page. The schemas are
  published by [Jinn-Network/spec](https://github.com/Jinn-Network/spec), and whether this
  site should ever render them, or only link them, is open.
- **Deploy.** Deploys are manual (`vercel deploy --prod`). Moving them into CI is a
  follow-up; the trade is between a green-CI gate on the apex domain and the current
  ability to ship without one.
- **The canonical line on a surface with no room for the qualifier.** `BRAND.md`'s
  canonical line ends "sold straight by whoever holds it". The site's description says
  "offered" there, and the landing page says a holder offers a record, because a link preview
  cannot also say that selling records is the direction. Whether the canonical line itself
  should carry the softer verb while the market is direction is a `BRAND.md` question,
  raised in [Discussion #4903](https://github.com/Jinn-Network/mono/discussions/4903).
- **Which explorer address.** The site links `explorer.jinn.network`; the root
  [`../../README.md`](../../README.md) links the indexer's own address. Both resolve today.
  Which one is the lasting address for the record of what ran is open.
