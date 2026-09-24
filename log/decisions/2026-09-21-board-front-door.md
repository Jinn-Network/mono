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
hand, and one of them, the LoCoMo judge report, is listed today. `publish`
in `PUBLIC-BUNDLE.md` is local immutable emission, not
hosting; a bundle URL is something the claimant hosted afterwards. The site
is a Next.js App Router static export. No API, no runtime fetch, no
transformation of bundle bytes. Ingest today is a local manifest walk, not a
cold run of the published checker the bundle pins.

[DR-2026-09-04](./2026-09-04-colophon-surrounds-the-run.md) decision 5 keys a
board on suite identity. Decision 7 named this fork and held it out of the
claimant-path build train. The Stage 1 spec
(`docs/superpowers/specs/2026-09-21-board-front-door-design.md`) rules the
forks; this record condenses them. The verifier is never cut. In this
repository the checker package is `@colophon-claims/check`, and
`@colophon-claims/verify` is kept as its permanent passthrough alias so every
sealed `verification.command` keeps resolving. Neither in-tree package is
published yet: on npm, checked 2026-09-24, `@colophon-claims/check` exists
only as `0.0.0`, a name reservation published 2026-09-23, and the working
published reader is `@colophon-claims/verify@0.2.1`, published 2026-09-01.

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
   listing channel; ingest projects `/1`, `/5`, `/7` and `/8` only, and a
   `/7` or `/8` bundle that seals no `presentation.json` reading record
   refuses, because the issue form cannot supply one), `check-failed`
   (checker stdout and stderr, truncated to a stated byte cap), `duplicate-identity`, `slug-collision`,
   `mutation-refused`, `npm-unavailable` (no fallback to ingest-only).

   The projector is the site's single-bundle ingest,
   `scripts/ingest-report.mjs`; the site's grouped ingest, which takes
   three `/2` and `/4` bundles of one run, is out of scope. Today nothing
   `colophon publish` emits passes both the checker and that ingest (spec
   §6.2 step 5). `/10` is the default, and the only format the CLI and the
   web app produce: its claim pins
   `npx @colophon-claims/verify@0.2.1 <bundle-dir>`, a published release
   that predates `/10` and refuses it at manifest parse, so it refuses
   `check-failed` before ingest runs, and ingest does not project `/10`
   either. `/2`, `/4` and `/6` pass the published line they pin, and
   ingest refuses them `unknown-format`. No `/7`, `/8` or `/10` closure
   allows a `presentation.json` member, so every `/7` or `/8` bundle that
   passes the checker seals no reading record, and ingest refuses it.
   `publish` refuses to emit `/5`, the one format both can accept.
   Follow-on 11.8 is the work that lets a bundle `colophon publish` emits
   through, and the front door waits for it: the workflow may be built
   before 11.8 lands, but it accepts submissions only after 11.8 lands
   (Rulings).

4. **One board per official suite.** A bundle whose sealed method carries a
   conforming suite protocol object keys on its suite protocol id, whatever
   its coverage, read from the `protocol` field of the sealed suite-protocol
   selection object; the claim package's `suiteComparability` carries no
   protocol id. Catalog ids are exactly `SUITE_PROTOCOL_IDS`. Every coverage
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
   guess a coverage. Until a suite-bound bundle carries its sealed selection
   bytes (follow-on 11.6), it refuses: the checker has nothing to re-derive
   `suiteComparability` from (`check-failed`), and the site has no
   `protocol` field to key a board on (`unknown-format`). Even with 11.5
   and 11.6, a suite-bound bundle is `/10` by default, which the front door
   cannot list until follow-on 11.8 (decision 3). The one report
   listed today, the LoCoMo judge report,
   re-projects from its existing `public/reports/<slug>/bundle/` bytes; a
   bundle that cannot project a key, or for a suite its coverage, stays on
   `/reports/<slug>/` until a human resolves it. Re-projection reads only the
   reports `data/reports/` lists: the unpublished Demo-1 report's bundle
   bytes remain under `public/reports/`, and re-projection must not bring
   its page back or put it on a board. The reason for one board per suite
   is usability: one place per suite for a reader to look (the operator's
   direction of 2026-09-23 on #4715). The split key this record first
   proposed is under Alternatives rejected.

5. **A listing is a fact row, newest first.** The row copies what the bundle
   already seals. Score is whatever the claim package presents
   (`headline`, `comparison`, or `qualification`); do not invent a single
   numeric board score. A comparison-shaped claim has no headline; the row
   shows the comparison. Attach the claim's own limitation sentences on the
   row; full text lives on the report page. Date is the date that orders
   the row: the earlier of the `closeAt` of a `run.json` the checker
   validated as a Run record and the listing time. Where that `closeAt` is
   the earlier, the row shows it, labeled as the run's close (the listed
   LoCoMo bundle seals no timestamp in `report.json` or its claim package);
   otherwise it shows the listing time, labeled "listed at". A row with no
   such `run.json` takes the listing time. A `run.json` nothing checked,
   such as one a `/5` bundle declares, does not
   set the date. Ingest's `reportedAt`, today's
   sort key, is not a listing time: `scripts/ingest-report.mjs` sets it from
   `report.json` `reportedAt` for format `/1` and from the public reading
   record's `sealedAt` for `/5`, `/7` and `/8`; the site's grouped ingest,
   `scripts/ingest-grouped-report.mjs`, takes it from a hand-typed
   `--reported-at`, and `lib/reports.ts` renders and sorts on that value
   too; no ingest path writes a listing time, so follow-on 11.1 adds one.
   For LoCoMo, `reportedAt` is
   `2026-08-29T16:30:51Z`, the run's `closeAt` cut to seconds: the site
   already shows that `closeAt` as the report's date, under the reading
   record's name `sealedAt`. The earlier-of order below and the
   listing-time fallback are the operator's rulings of 2026-09-24
   (Rulings). On a suite board the row shows coverage
   and execution conformance from `suiteComparability`, with a visible
   marker on any row short of `full`. The published checker does not yet
   carry that field, and the bundle does not yet carry the selection bytes
   it would be re-derived from, so until follow-ons 11.5 and 11.6 land a
   suite-bound bundle refuses (decision 8; What this does not yet prove).
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
   newest first: the earlier of the run's pre-registered close time,
   `closeAt`, and the listing time, or the listing time where the bundle
   carries no Run record the checker validated. Taking the earlier means a
   claimant cannot date a row later than the moment it was listed.
   `closeAt` is not a seal
   time: it is fixed at lock, and a run that accounts every cell can be
   collected, reported and published before it. The operator's direction
   calls this order sealing time; this record names `closeAt` the close
   time.
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
   SHA-256 of fetched `bundle.json` (ingest already writes it as
   `digests.bundleIdentity`), not the slug. Slug is the durable URL path.
   Claimant may propose a URL-safe bounded slug; if free, use it; if taken
   by the same identity,
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
     `human-surface`. Prerequisite of opening the door, not of building
     it: 11.8. The workflow accepts submissions only after 11.8 lands
     (Rulings).
   - **11.2** `feat(site)`: board pages keyed by suite, or by method digest.
     Lands in `colophon-claims/site`. Label `human-surface`. Prerequisites:
     11.5, 11.6 and 11.8.
   - **11.3** `feat(site)`: listing row fields as ruled. Lands in
     `colophon-claims/site`. Label `human-surface`.
   - **11.4** `feat(benchmark-product)`: `colophon board submit <locator>`
     opens the GitHub door. Lands in `packages/benchmark-product`. File after
     11.1 is listed-on-the-board in production, not in parallel as a second
     door. It does not upload bytes, run ingest, or write the site repo.
   - **11.5** `fix(benchmark-product)`: the published checker carries
     `suiteComparability` in its claim schema and re-derives it in
     claim-consistency from the sealed selection manifest the bundle carries
     (11.6), the Run and the Matrix, never from the claim under test; for
     a full-coverage, conforming run of the five protocols 11.9 names, the
     flag's re-derivation is 11.9's (Rulings).
     Lands in `packages/benchmark-product/check`. Prerequisite of 11.2.
   - **11.6** `feat(benchmark-product)`: a suite-bound bundle carries its
     sealed selection bytes. Acceptance: a suite-bound run publishes a bundle
     that carries its sealed selection bytes for every official protocol,
     and the checker re-derives `suiteComparability` from the selection
     manifest, the Run and the Matrix. Lands in `packages/benchmark-product`.
     Prerequisite of 11.2, with 11.5 and 11.8: until all three land, no
     suite board can get its first row.
   - **11.8** `feat(benchmark-product)`: a bundle `colophon publish` emits
     can be listed. Acceptance: a `/10` claim pins a published reader
     release that reads `/10`; the site's ingest projects `/10`; a `/10`
     bundle submitted through the front door lists with a public reading
     record that comes from the submitted bytes, with no `--presentation`.
     Lands in `packages/benchmark-product` and `colophon-claims/site`.
     Label `human-surface`. Prerequisite of 11.2, with 11.5 and 11.6,
     and of opening the front door: 11.1 may be built in parallel, but its
     workflow accepts submissions only after 11.8 lands (Rulings).
   - **11.9** `feat(benchmark-product)`: a suite-bound bundle carries the
     evidence `leaderboardSubmitReady` turns on. Acceptance: for a
     full-coverage, conforming run of Terminal-Bench 2.1 or 3.0, DeepSWE
     v1.1, SWE-bench Verified or APEX-Agents, the bundle carries the files
     core reads to decide the flag (on the retained Harbor or Pier job,
     each trial's `config.json` and ATIF files, and for DeepSWE
     `reward.json`; harness `report.json` files for SWE-bench Verified;
     Archipelago `grades.json` for APEX-Agents), and the published checker
     re-derives the flag, and the limitation sentence it selects, from
     them cold. Lands in `packages/benchmark-product`. Not a prerequisite
     of 11.1 or 11.2 (Rulings).

   Not filed from this design: the Colophon venue independence service
   (DR-2026-09-04 decision 2; named so row fields are ready, not designed);
   blob-hosting or Git LFS (file only after git pain is measured); rewriting
   historical `@colophon-claims/verify` lines (the alias stays).

   Two issues on `colophon-claims/site`, both opened 2026-09-23, plan the
   same site work from the site's side: #20, the board page, and #22,
   ingest at the front door. Site #22 leaves open where the listing's state
   lives, which decision 6 rules on, and sketches a one-field Bundle URL
   form on a site page; here that field is decision 1's one locator, on a
   GitHub issue form (decision 2). Filed 11.1 to 11.3 name both site
   issues.

9. **This record is the design artifact** follow-on `human-surface` site
   issues consume. Board pages are a new domain model on `colophon-claims/site`
   and land with it: a Board is keyed state plus a collection of listings in
   the order of the row's date (decision 5), and its one action is the
   reader's re-sort by any
   column except the score, in the browser, with no request, no mutation,
   and no failure state (submit lives on GitHub); a Listing row is sealed
   facts, with coverage and conformance on a suite board, plus a same-origin
   bundle href, and has no actions; Submission is not a site-page component.
   Empty boards do not exist. No helper-text
   cruft restating the numbers; the non-ranking sentence is the claim
   boundary, the same class `/reports` already prints. Tooltips may explain
   "self-run" and the three independence lines.

## What this does not yet prove

- That `colophon-claims/site` can auto-merge a machine ingest PR without a
  human. The repository is public. Read through the GitHub API on
  2026-09-24, its `main` branch has no branch protection and no ruleset,
  and the repository does not allow auto-merge, so no required check gates
  a merge today. 11.1's acceptance includes it: green append-only ingest
  PRs auto-merge without a human click, behind the required checks of
  decision 7.
- That every historical bundle in `public/reports/` projects a board key.
  Grandfathering fails closed per decision 4.
- That a Colophon-controlled venue will exist, or what bytes it will seal
  into the three independence lines. Rows are shaped for it; the service is
  not designed.
- That npm will be available at listing time. `npm-unavailable` refuses
  rather than falling back to ingest-only.
- That the claimant's locator remains up. The site's byte-exact copy is what
  remains checkable.
- That the front door can list anything `colophon publish` emits. Today it
  cannot, whatever the format (decision 3; spec §6.2 step 5). `/10` is the
  default and the only format the CLI and the web app produce
  (`packages/benchmark-product/core/src/operations/report.ts`); its claim
  pins `npx @colophon-claims/verify@0.2.1 <bundle-dir>`
  (`packages/benchmark-product/check/src/capabilities.ts`), which predates
  `/10` and refuses it at manifest parse, and ingest does not project it.
  `/2`, `/4` and `/6` pass the published line they pin, and ingest refuses
  them. No `/7`, `/8` or `/10` closure allows a `presentation.json` member
  (`packages/benchmark-product/check/src/verify.ts`), so a `/7` or `/8`
  bundle that passes the checker has no reading record, and ingest refuses
  it. `publish` refuses to emit `/5`
  (`packages/benchmark-product/core/src/operations/publish.ts`), the one
  format both can accept. Follow-on 11.8 closes the gap, and the front
  door opens only after it lands (Rulings).
- That a suite-bound bundle can be listed today. The published checker does
  not carry `suiteComparability`: its claim schema
  (`packages/benchmark-product/check/src/profile/claim.ts`) has no such key,
  zod strips unknown keys, and `packages/benchmark-product/check/src/verify.ts`
  then refuses a `claim-package.json` that carries the key as not the exact
  canonical encoding. `publish` runs that same checker on its own output
  (`packages/benchmark-product/core/src/operations/publish.ts`), so a
  suite-bound bundle can be neither published nor passed through the cold
  listing gate, and no suite board can get its first row. A checker that
  merely tolerated the key would leave the coverage marker, the one on-page
  guard between a subset row and a full row, unchecked. Follow-on 11.5
  (decision 8) is one prerequisite of 11.2; the next item names a second,
  and the item above names the third, 11.8.
- That a suite-bound bundle can be listed once 11.5 lands. For all seven
  official suite protocols, the checker fix alone cannot open a suite board.
  For Terminal-Bench 2.1 and 3.0, DeepSWE v1.1, SWE-bench Verified,
  APEX-Agents and APEX-SWE-dev, the Run records the runtime selection and
  the suite-protocol selection (`SUITE_PROTOCOL_SELECTION_ROLE`) only as
  digests (`packages/benchmark-product/core/src/runtime/adapter.ts`), and
  `packages/benchmark-product/core/src/bundle/materialize.ts` adds
  `runtime-selection` bytes only for Inspect runtimes, so the bundle gives
  the site no `protocol` field to key a board on (this includes
  `/boards/terminal-bench-2.1`) and the checker nothing to re-derive from.
  For Inspect eval, `publish` stops in `materialize.ts` before the checker
  runs: it parses the runtime selection as an Inspect selection manifest
  (`inspect-selection/1` to `/4`), which the Inspect eval manifest
  (`inspect-eval-selection/1`) is not, and it requires every Task to carry
  `payload.selectionManifestSha256`, while Inspect eval Tasks carry only
  `sampleId` (`packages/benchmark-product/core/src/intake/inspect-eval.ts`).
  For a full-coverage, conforming run of Terminal-Bench 2.1 or 3.0, DeepSWE
  v1.1, SWE-bench Verified or APEX-Agents, core's `leaderboardSubmitReady`
  turns on files core reads from the producing machine and the bundle does
  not carry: ATIF trajectory files on the retained Harbor or Pier job, and
  for DeepSWE also `reward.json`
  (`packages/benchmark-product/core/src/runtime/suite-protocol/run-complete.ts`);
  harness `report.json` files for SWE-bench Verified; Archipelago
  `grades.json` for APEX-Agents. The checker rebuilds the whole claim and
  compares bytes, and 11.5 forbids reading the key from the claim under
  test, so 11.5's re-derivation cannot be met for those runs as first
  written; the same flag also picks the suite limitation sentence on the
  Report. Conformance reads the whole runtime selection manifest and the
  Run, not the suite-protocol object alone (for Inspect eval: epochs,
  Inspect version, solver, sample limit and run options, against the Run's
  planned replicates). Follow-on 11.6 carries the selection bytes; 11.2
  needs 11.5, 11.6 and 11.8. The operator ruled that the bundle carry the
  files `leaderboardSubmitReady` turns on, so the published checker
  re-derives the flag cold: follow-on 11.9, which 11.2 does not need
  (Rulings).
- That a reader will not take a subset row for a full-suite result. One board
  per suite puts them side by side; the header reminder and the row marker
  state the difference, and they cannot make a reader read it.

## Consequences

- Step 8 of the claimant path gets a door that does not require an
  operator to copy a folder. It opens only once follow-on 11.8 lands, so
  from its first day it can list a bundle `colophon publish` emits
  (decision 3).
- `colophon-claims/site` gains a workflow, an issue form, board routes, and
  ingest fields (board key, venue projection, locator provenance, listing
  time; the bundle identity is already there as `digests.bundleIdentity`).
  The export remains static.
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
- **Split key: (suite protocol id, coverage) for official named slices,
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
  order by the row's date and never by score. They state the difference;
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

## Rulings (2026-09-24)

The operator ruled on 2026-09-24 on the choices this record left open
(spec §14 entries 7 and 10 to 13). The decisions above carry each ruling.

1. **`leaderboardSubmitReady` is re-derived cold from evidence the bundle
   carries.** The bundle carries the files core reads to decide the flag,
   so the published checker re-derives the flag, and the limitation
   sentence it selects, cold: follow-on 11.9 (decision 8). 11.9 gates
   neither the front door nor the board pages; it is not a prerequisite
   of 11.1 or 11.2.
2. **Rows are ordered newest first by the earlier of the run's validated
   `closeAt` and the listing time** (decision 5). Taking the earlier means
   a claimant cannot date a row later than the moment it was listed.
3. **The listing-time fallback stays.** A row with no `run.json` the
   checker validated as a Run record takes the listing time, labeled
   "listed at". The row shows the date that orders it: the validated
   `closeAt`, labeled as the run's close, where it is the earlier;
   otherwise the listing time, labeled "listed at" (decision 5).
4. **Follow-on 11.8 gates the front door.** 11.1 may be built in
   parallel, but the door opens, meaning the workflow accepts
   submissions, only after 11.8 lands (decisions 3 and 8). 11.2's
   prerequisites stay 11.5, 11.6 and 11.8.
5. **The score is not a reader sort key.** Confirmed: a reader may
   re-sort by any column except the score (decision 5).

## Ratification

Proposed 2026-09-21 from design issue #3993. Stage 1 ruled the forks in
`docs/superpowers/specs/2026-09-21-board-front-door-design.md`. This record
condenses those rulings. Revised 2026-09-23 to the operator's direction
on #4715: decision 4 keys a board on the suite alone, and the split key is
recorded under Alternatives rejected. Revised 2026-09-24 to record that the
published checker does not yet carry `suiteComparability` (decision 8,
follow-on 11.5). Revised a second time 2026-09-24 to record that a
suite-bound bundle does not carry its sealed selection bytes (decisions 4
and 8, follow-on 11.6, now a second prerequisite of 11.2), that ingest's
`reportedAt` is not a listing time (decision 5), how ingest treats a bundle
it cannot project (decision 3), and three choices left open for the
operator (Open for the operator, now Rulings). Revised a third time 2026-09-24 to
record that nothing `colophon publish` emits today can be listed through
the front door (decision 3, What this does not yet prove), adding
follow-on 11.8 as a third prerequisite of 11.2 and asking the operator
whether it also gates the front door (Open for the operator, now Rulings); to name the
default order for the pre-registered close time, `closeAt`, not sealing
time (decision 5); and to correct the npm status of the checker (Context),
the site's grouped ingest (decisions 3 and 5), the existing
`digests.bundleIdentity` field (decision 6) and the site repository's
visibility. Revised a fourth time 2026-09-24 to narrow the
`presentation.json` statement to the `/7`, `/8` and `/10` closures, since
the `/5` closure accepts other members its manifest declares (decision 3,
What this does not yet prove), and to read the row date only from a `run.json` the
checker validated as a Run record (decision 5, Open for the operator,
now Rulings). Revised a fifth time 2026-09-24 to record the operator's
rulings of that date (Rulings): the bundle carries the evidence
`leaderboardSubmitReady` turns on, as new follow-on 11.9, which gates
neither 11.1 nor 11.2 (decision 8); the default order is the earlier of
the validated `closeAt` and the listing time, and the row shows the date
that orders it (decisions 5 and 9); the listing-time fallback stays
(decision 5); 11.8 gates the front door (decisions 3 and 8); and the
score is not a reader sort key.
Ratified on code-owner approval of this record by the
operator credential that did not author it.

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
