---
id: DR-2026-09-21
title: The board's front door — submit a locator, cold-verify, list
date: 2026-09-21
verb: Decide
status: proposed, from design issue #3993; ratified on code-owner approval of this record
owning-docs: packages/benchmark-product/PUBLIC-BUNDLE.md, EXTERNAL-VERIFICATION.md, spec/2026-08-13-colophon-self-serve.md
---

# DR-2026-09-21: The board's front door — submit a locator, cold-verify, list

## Context

A claimant who has locally published a public bundle still cannot list it.
Step 8 of the path — lock, run, bring back, bundle, publish, anyone verifies,
**list** — is operator-only: two reports reached `colophon-claims/site` by
hand. `publish` in `PUBLIC-BUNDLE.md` is local immutable emission, not
hosting; a bundle URL is something the claimant hosted afterwards. The site
is a Next.js App Router static export. No API, no runtime fetch, no
transformation of bundle bytes. Ingest today is a local manifest walk, not a
cold run of the published checker the bundle pins.

[DR-2026-09-04](./2026-09-04-colophon-surrounds-the-run.md) decision 5 keys a
board on suite identity. Decision 7 named this fork and held it out of the
claimant-path build train. The Stage 1 spec
(`docs/superpowers/specs/2026-09-21-board-front-door-design.md`) rules the
forks; this record condenses them. The verifier is never cut. The published
checker is `@colophon-claims/check`; `@colophon-claims/verify` remains a
permanent passthrough alias so every sealed `verification.command` keeps
resolving.

## Decisions

1. **One locator, several syntaxes.** The claimant hands the site one string
   that resolves to a Colophon public-bundle directory, or a zip/tarball of
   one. Three syntaxes, one product: an `https:` URL of a bundle directory
   (GET `{url}/bundle.json`, then every path it names; directory autoindex is
   not required); an `https:` URL of a zip or tarball whose top-level
   directory or archive root is that bundle (GitHub release assets are this
   syntax, not a second product); `owner/repo@ref:path` GitHub-tree sugar
   (resolve `ref` to an exact commit OID, fetch that tree, require
   `bundle.json` there; a moving branch is claimant convenience, the listing
   is of the resolved bytes). Fail-closed: `https:` only; `http:` to a
   non-public origin, `file:`, and credential-bearing URLs refuse; private,
   loopback, link-local, CGNAT, multicast, unspecified, and similar
   destinations refuse; auth-gated GitHub trees and private release assets
   refuse; the resolved tree must contain `bundle.json` at its root after
   unpack. Not three products. Not upload or email: those put bytes on
   Colophon's machine before a public locator exists, skip the host step that
   lets anyone fetch what the checker saw, and require a server or a
   privileged inbox.

2. **The site stays static.** The front door is a GitHub issue form on
   `colophon-claims/site` (one locator field, optional proposed slug, optional
   claimant note that is not copied onto the board) plus a workflow that
   fetches, checks, projects, and opens an ingest PR. No API, no ISR, no
   middleware, no server, no runtime fetch, no form on colophon.claims.
   Site mutation remains a separate gate (self-serve §4.2 / §10). A later
   `colophon board submit` opens that same issue; it is not a second door.

3. **The listing gate is a cold published checker.** Fetch the locator into
   an ephemeral workspace. Read `claim-package.json` `verification.command`
   from those bytes; absent or unparseable is `unknown-format` before npx.
   Run that exact command against the fetched directory, `--yes` because this
   is CI (the self-serve exception for non-interactive callers; the human
   quickstart does not gain `--yes`), `npx --cache` pointed at an empty temp
   directory. Do not rewrite the sealed package name; a line that names
   `@colophon-claims/verify` is the pin the bundle sealed. Success (exit 0,
   and the tool's own report says the checks passed) is the listing gate. On
   success, existing ingest is the **projector** into `data/reports/<slug>.json`
   plus byte-exact `public/reports/<slug>/bundle/`. Ingest may still
   sanity-check the manifest. Checker pass plus ingest refusal is a projector
   bug: fail closed, comment both, do not list. Do not skip the checker
   because ingest would have passed. Do not skip ingest because the checker
   passed. Do not refuse because the venue is self-run, because
   `leaderboardSubmitReady` is false, or because the claimant is unknown.
   Named refusals, commented on the submission issue, no silent skip:
   `fetch-failed`, `blocked-origin`, `unknown-format` (including a bundle the
   checker would accept but ingest cannot project — no second, unprojected
   listing channel), `check-failed` (checker stdout and stderr, truncated to
   a stated byte cap), `duplicate-identity`, `slug-collision`,
   `mutation-refused`, `npm-unavailable` (no fallback to ingest-only).

4. **One board per official suite.** A bundle whose sealed method carries a
   conforming suite protocol object keys on `suiteProtocolId`, whatever its
   coverage. Catalog ids are exactly `SUITE_PROTOCOL_IDS`. Every coverage
   (`full`, `ten_task`, `one_task`, `custom`) is listed on that one board.
   Coverage is a row fact, like `execution_conformance`: every row shows
   both, and any row short of `full` carries a visible marker. Neither axis
   splits a suite board; hiding non-conforming or subset runs would be a
   ranking choice. The board header carries the two-axis comparability
   reminder, so a subset row beside a full row is shown, not ranked. A
   method with no suite protocol object keys on the SHA-256 of the locked
   method document bytes. Method digest is **not** equivalent to
   suite×coverage: the locked document also names solver, host, arms, and
   pins, so a universal digest key would give each configuration its own
   one-row board and fragment official suites per solver. That reading
   contradicts DR-2026-09-04 decision 5. The first successfully checked
   listing whose key is new creates that board. No operator registers
   boards. Board URLs: `/boards/<protocol>` for official suites (example
   `/boards/terminal-bench-2.1`); `/boards/method/<64-hex>` for digest keys.
   A human title derived from `suiteProtocolDisplayName` or the claim's
   method id is paint, not the key. Bundles that wear an official suite but
   do not project `suiteComparability` refuse `unknown-format` rather than
   guess a coverage. Grandfathered reports re-project from existing
   `public/reports/<slug>/bundle/` bytes; a bundle that cannot project a
   key, or for a suite its coverage, stays on `/reports/<slug>/` until a
   human resolves it. The reason for one board per suite is usability: one
   place per suite for a reader to look (the operator's direction of
   2026-09-23 on #4715). The split key this record first proposed is under
   Alternatives rejected.

5. **A listing is a fact row, newest first.** The row copies what the bundle
   already seals. Score is whatever the claim package presents
   (`headline`, `comparison`, or `qualification`); do not invent a single
   numeric board score. A comparison-shaped claim has no headline; the row
   shows the comparison. Attach the claim's own limitation sentences on the
   row; full text lives on the report page. Date prefers a timestamp the
   bundle seals; fall back to ingest time labeled "listed at". On a suite
   board the row shows coverage and execution conformance from
   `suiteComparability`, with a visible marker on any row short of `full`.
   Venue is `venueHonesty.venue` from the
   sealed disclosure, not who filed the GitHub issue. Today's value is
   `"self-run"`. The three DR-2026-09-04 independence lines are quoted from
   the sealed disclosure, not rewritten into a traffic-light:

   1. Who controlled the machine.
   2. Whether pinning held.
   3. Whether costs were independently seen.

   On today's self-run bundles those are the corresponding `LOCAL_VENUE_LIMITS`
   sentences. Same-origin bundle link is `/reports/<slug>/bundle/`, the
   byte-exact copy ingest already writes. The claimant's locator is provenance
   in `data/reports/<slug>.json`, not identity, and is not required to stay up
   for the listing to remain checkable. Default order is the row's date,
   newest first: sealing time, or listing time where the bundle seals none.
   The page is built in that order, so it renders without script. A reader
   may re-sort by any column except the score, in the browser, using the
   page's own script (no external requests), with keyboard-operable column
   headers. The score is not a sort key: it is the claim's own projection,
   not one number. Score-ranking and run-count-ranking are declined. Run
   count may appear on the board **header** as a fact (how many checked
   bundles this board lists) without ordering rows by it. Suite board headers
   also carry the two-axis comparability reminder, so a subset row beside a
   full row is shown, not ranked. No "best score." No sparkline.
   Board pages reuse the `/reports` sentence: Colophon does not rank reports
   against each other. `/reports`
   stays the chronological ledger; `/boards` sits above it as the grouping
   by suite, or by method where there is no suite. Listing means the
   published checker, at the line this bundle
   pins, passed against the bytes now at `/reports/<slug>/bundle/`. A passing
   check does not prove the producing venue was honest, that distinct keys are
   independent parties, that isolation was strong, or that costs were
   independently settled.

6. **The git tree is the registry.** `data/reports/<slug>.json` plus
   byte-exact `public/reports/<slug>/bundle/` is the listing. No second
   registry, database, or Project field. Duplicate identity is the lowercase
   SHA-256 of fetched `bundle.json` (ingest JSON carries `bundleSha256`), not
   the slug. Slug is the durable URL path. Claimant may propose a URL-safe
   bounded slug; if free, use it; if taken by the same identity,
   `duplicate-identity`; if taken by a different identity, or omitted /
   invalid, assign `sha256-` plus the first 12 hex characters of the bundle
   identity, extending the prefix until unique. Never replace an existing
   slug. Ingest already refuses replacement; the workflow must not pass
   `--force`. Mutation of an existing report URL is `mutation-refused`.
   Blob-hosting of huge bundles, and Git LFS, are not designed here.

7. **Green append-only ingest PRs auto-merge.** Required checks: the
   cold-verify job (re-run on the PR against the committed copy) and the site
   build. When those are green and the diff is append-only listing files (new
   `data/reports/<slug>.json`, new `public/reports/<slug>/`, no edits to
   existing report URLs), auto-merge. Listing is the merge. A human on the
   site repo may merge an already-green append-only PR whose auto-merge
   failed; that is repair, not a second gate. Silent human filter of a green
   listing is not allowed. If the site repo cannot auto-merge without a human,
   Permissionless is not met and the follow-on issue is not done. Two locators
   of the same `bundle.json` digest: first merge wins, second refuses
   `duplicate-identity`. Two locators, different identities, same proposed
   slug: first merge wins the slug, second gets the digest fallback.

8. **Follow-on builds are filed after this record is ratified**, as
   sub-issues of #3973, not implemented here. Named, triage-complete payloads
   live in the Stage 1 spec §11:

   - **11.1** `feat(site)`: submission issue form, cold-verify workflow,
     ingest-on-success PR. Lands in `colophon-claims/site`. Label
     `human-surface`.
   - **11.2** `feat(site)`: board pages keyed by suite, or by method digest.
     Lands in `colophon-claims/site`. Label `human-surface`.
   - **11.3** `feat(site)`: listing row fields as ruled. Lands in
     `colophon-claims/site`. Label `human-surface`.
   - **11.4** `feat(benchmark-product)`: `colophon board submit <locator>`
     opens the GitHub door. Lands in `packages/benchmark-product`. File after
     11.1 is listed-on-the-board in production, not in parallel as a second
     door. It does not upload bytes, run ingest, or write the site repo.

   Not filed from this design: the Colophon venue independence service
   (DR-2026-09-04 decision 2; named so row fields are ready, not designed);
   blob-hosting or Git LFS (file only after git pain is measured); rewriting
   historical `@colophon-claims/verify` lines (the alias stays).

9. **This record is the design artifact** follow-on `human-surface` site
   issues consume. Board pages are a new domain model on `colophon-claims/site`
   and land with it: a Board is keyed state plus a collection of listings in
   sealing-time order, and its one action is the reader's re-sort by any
   column except the score, in the browser, with no request, no mutation,
   and no failure state (submit lives on GitHub); a Listing row is sealed
   facts, with coverage and conformance on a suite board, plus a same-origin
   bundle href, and has no actions; Submission is not a site-page component.
   Empty boards do not exist. No helper-text
   cruft restating the numbers; the non-ranking sentence is the claim
   boundary, the same class `/reports` already prints. Tooltips may explain
   "self-run" and the three independence lines.

## What this does not yet prove

- That `colophon-claims/site` branch protection can auto-merge a machine
  ingest PR. 11.1's acceptance includes proving it or changing the settings;
  this record cannot prove a private repo's rules.
- That every historical bundle in `public/reports/` projects a board key.
  Grandfathering fails closed per decision 4.
- That a Colophon-controlled venue will exist, or what bytes it will seal
  into the three independence lines. Rows are shaped for it; the service is
  not designed.
- That npm will be available at listing time. `npm-unavailable` refuses
  rather than falling back to ingest-only.
- That the claimant's locator remains up. The site's byte-exact copy is what
  remains checkable.
- That a reader will not take a subset row for a full-suite result. One board
  per suite puts them side by side; the header reminder and the row marker
  state the difference, and they cannot make a reader read it.

## Consequences

- Step 8 of the claimant path exists, and it does not require an operator to
  copy a folder.
- `colophon-claims/site` gains a workflow, an issue form, board routes, and
  ingest fields (`bundleSha256`, board key, venue projection, locator
  provenance). The export remains static.
- Ingest stays the projector. The published checker becomes the listing gate.
  The two must not drift.
- Official suite boards will mix models, harnesses, claimants, and
  coverages. That is the point: one place per suite for a reader to look.
  Coverage and conformance are on every row, and no row is ordered by score.
- Custom methods appear without a catalog change. The catalog remains how you
  bind an official suite, not how you display one.
- Auto-merge of append-only listing PRs is a site-repo settings change. The
  follow-on issue names it.
- Git history of `public/reports/` continues to grow. Blob-hosting remains a
  later, measured issue.
- This path is CODEOWNERS. Issue #3993 parks for human approval of the
  record; it does not implement.

## Alternatives rejected

- **Three locator products** (separate URL, release-asset, and repo-path
  flows). Hosting choice is not a Colophon product fork. `publish` already
  emitted one directory.
- **Upload / email-the-folder.** Requires a server or a privileged inbox;
  skips the public-host step; the site's copy would become the only copy.
  Permissionless fails; Legible fails.
- **Ingest's local manifest walk as the listing gate.** Would claim "this
  checked" while having run a private projector, not the published checker.
- **Trust the claimant's pasted verify receipt.** Anyone can paste.
- **Always key boards on method-document digest.** Fragments official suites
  per solver. Contradicts DR-2026-09-04 decision 5.
- **Split key: `(suiteProtocolId, coverage)` for official named slices,
  method digest for official `custom` coverage.** Considered and declined.
  It was this record's decision 4 as first proposed (spec §6.3 option A).
  The operator's direction of 2026-09-23 on #4715 declined it for
  usability: one place per suite for a reader to look. The split key kept
  incomparable coverages off one page, but a reader had to know which
  coverage board to open for a suite, and each official `custom` run sat on
  its own digest board, apart from its suite. The caveat: a subset row now
  sits beside a full row. What the split key carried by separation, the
  board header's two-axis comparability reminder and the coverage fact on
  every row, with its marker short of `full`, now carry on the page, in an
  order that is sealing time and never score. They state the difference;
  they cannot make a reader read it.
- **A suite board that ignores coverage** (spec §6.3 option C as first
  drafted). Without coverage on each row, a subset row would read as a
  full-suite result, and a method with no suite id would have no board.
  Taken instead as directed: coverage moves from the key onto every row,
  and a method with no suite protocol object keeps its digest board.
- **Operator-registered boards.** Privileged shortcut and a governance
  surface. First checked listing creates the key.
- **Score-ranking.** A leaderboard. PRODUCT.md forbids it. Neutral forbids
  structurally benefiting the high scorer with position.
- **Run-count as default order.** Ranks claimants by volume. Count belongs
  on the header as a fact, not as a sort.
- **A second registry / database / Project field.** A listing that exists
  only in a store the export does not serve is an unverifiable claim.
- **Locator-only (site stores a URL, fetches at view time).** Runtime fetch
  from the exported site is forbidden; claimant bytes can change after
  listing.
- **Silent human filter of a green listing.** Permissionless forbids it.
  Repair merge of an already-green append-only PR remains allowed.
- **Filing `colophon board submit` in parallel with 11.1.** Would be a
  second door before the GitHub door works.
- **Designing blob-hosting or the venue service in this record.** Named,
  not designed. Known LoCoMo git weight is not a design of hosting.

## Ratification

Proposed 2026-09-21 from design issue #3993. Stage 1 ruled the forks in
`docs/superpowers/specs/2026-09-21-board-front-door-design.md`. This record
condenses those rulings. Revised 2026-09-23 to the operator's direction
on #4715: decision 4 keys a board on the suite alone, and the split key is
recorded under Alternatives rejected. Ratified on code-owner approval of
this record by the operator credential that did not author it.

## Amends

- [DR-2026-09-04](./2026-09-04-colophon-surrounds-the-run.md) decision 7:
  this fork is now designed, not merely named. Cuts-then-builds order of
  that decision otherwise stands; the board's front door is no longer an
  undesigned hold.
- Does not amend: the verifier (DR-2026-09-04 decision 6; `@colophon-claims/verify`
  alias stays); what `publish` means (local emission, not hosting); suite
  knowing-decisions (named protocol identity, two-axis comparability, exports
  as derived artifacts). Does not design the Colophon-controlled venue
  (DR-2026-09-04 decision 2).
