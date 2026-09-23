# The Board's Front Door

| | |
|---|---|
| **Version** | 0.2 (2026-09-23: §6.3 board key revised to one board per official suite, on the operator's direction on #4715) |
| **Date** | 2026-09-21 |
| **Author** | Autopilot design session (issue #3993); citations read against this attempt's supplied worktree |
| **Shape** | `design`; no build in this issue |
| **Status** | proposed — Stage 2 condenses this into `log/decisions/2026-09-21-board-front-door.md`; that DR is CODEOWNERS and parks for human approval |
| **Issue** | [#3993](https://github.com/Jinn-Network/mono/issues/3993) |
| **Parent** | [#3973](https://github.com/Jinn-Network/mono/issues/3973) item 4 |
| **Depends on** | [DR-2026-09-04](../../../log/decisions/2026-09-04-colophon-surrounds-the-run.md) (ratified; decision 7 names this fork); [colophon self-serve](../../../spec/2026-08-13-colophon-self-serve.md) §4 (site mutation is a separate gate; no API; reader path); [public bundle](../../../packages/benchmark-product/PUBLIC-BUNDLE.md); [external verification](../../../packages/benchmark-product/EXTERNAL-VERIFICATION.md); [suite comparability](../../../packages/benchmark-product/core/src/runtime/suite-protocol/comparability.ts); [DR-2026-08-18-f](../../../log/decisions/2026-08-18-colophon-method-cli.md) (officialness is a property of the sealed document) |
| **Does not do** | implement the site, the workflow, the CLI submit verb, a registry service, blob hosting, or the Colophon venue-independence service (named by DR-2026-09-04, not designed here) |
| **Lands in** | this document in `Jinn-Network/mono`. Follow-on **build** issues are filed on `Jinn-Network/mono` as sub-issues of #3973 and name that their code lands in `colophon-claims/site` (and, for the optional CLI, in `packages/benchmark-product`). This DR, once Stage 2 writes it, is the design artifact those issues consume. |

## 0. Decision in plain language

A claimant who has published a bundle locally hosts it themselves, then hands the site one locator. A GitHub Actions workflow on `colophon-claims/site` fetches that locator, runs a **cold** published checker at the line the bundle itself pins, and on success runs the existing ingest projector and opens an append-only PR. Merge lists the bundle. The exported site remains static files: no API, no runtime fetch, no upload form.

A board is one page per official suite, keyed on the suite protocol id, and every coverage of that suite (`full`, `ten_task`, `one_task`, `custom`) is listed on it. Coverage is a fact on each row, and a row short of `full` carries a visible marker. A method with no suite protocol object has its own board, keyed on the digest of the locked method document. The first successfully checked listing whose key is new creates that board. No operator registers boards.

A listing is a row, not a rank. It shows the claim's own score as the bundle states it, the report date, on a suite board the coverage and execution conformance, the venue the sealed disclosure names, the three venue-independence lines DR-2026-09-04 names, and a same-origin link to the byte-exact bundle. Rows are ordered by sealing time, newest first, and that order renders without script. A reader may re-sort by column in the browser; the score is not a sort key. Score-ranking and run-count-ranking are declined. The git tree `data/reports/` plus `public/reports/<slug>/bundle/` is the registry.

## 1. Context

Boards are the display: one per sealed method, listing every checked bundle that sealed it. Today two reports reached `colophon-claims/site` by hand, through pull requests. A claimant who has published a bundle has no way to get it onto the board for its method. Step 8 of the claimant's path — lock, run, bring back, bundle, publish, anyone verifies, **list** — does not exist.

`publish` in [`PUBLIC-BUNDLE.md`](../../../packages/benchmark-product/PUBLIC-BUNDLE.md) means local immutable emission, not hosting. It does not upload. A "bundle URL" is therefore something the claimant hosted after local publish: an HTTP directory, a zip or tarball, a GitHub release asset, or a repository tree.

The site is a Next.js App Router export (`output: "export"`). Pure static files. No API routes, no ISR, no middleware, no server. The exported site makes no external requests. Its README: "The site is a notary's display case, not a CMS: it never transforms a published bundle." Reports are ingested by an operator today with `node scripts/ingest-report.mjs <bundle-dir> --slug <slug>` then `npm run build`. Ingest validates the bundle manifest locally, copies byte-exact into `public/reports/<slug>/bundle/`, and emits `data/reports/<slug>.json`. Existing slugs are never replaced. `lib/reports.ts` `listReports()` is `readdirSync("data/reports")` of `*.json` excluding `*.presentation.json`, sorted by `reportedAt` descending. That ingest does **local manifest validation**, not a cold `npx @colophon-claims/check` of the published checker.

DR-2026-09-04 decision 5: "The suite identity is what a board is keyed on." Decision 7: the board's front door is this design fork, not part of the claimant-path build train. The verifier is never cut. The published checker is `@colophon-claims/check`; `@colophon-claims/verify` is a permanent passthrough alias so every sealed `verification.command` keeps resolving.

The `/reports` index already states: "Colophon does not rank reports against each other. Each report answers one bounded question and keeps its own scope and limitations attached." PRODUCT.md forbids leaderboards: ranking is the thing this product refuses to do; the site must not look like one. Every number on the site is itself checkable.

## 2. Goals

1. A claimant who has locally published a public bundle can submit it for listing without a privileged operator path.
2. Listing is a checkable claim: the site listed this bundle because the published checker, at the line the bundle pins, returned success against the fetched bytes.
3. The exported site stays a static notary's display case: no API, no runtime fetch, no transformation of bundle bytes.
4. One board per official suite, so a reader has one place to look. Every coverage of the suite is listed on it. Coverage is a fact on every row, and a subset row beside a full row is shown, not ranked.
5. Custom methods obtain a board by being listed, not by operator registration.
6. A listing row shows facts the bundle already seals. It does not invent a ranking.
7. The git tree that the site already serves is the registry. A listing that exists only in a store the site does not serve is an unverifiable claim.

## 3. Non-goals

- A form, API, or upload on colophon.claims itself.
- File-upload, email-the-folder, or any path that puts bundle bytes on Colophon's machine before a public locator exists.
- Hosted execution, hosted verification-as-a-service, accounts, telemetry, cookies, or analytics.
- The Colophon-controlled venue independence service (DR-2026-09-04 decision 2). Named here only so listing-row fields are ready when that service exists; not designed.
- Blob-hosting of huge bundles (the LoCoMo judge report is tens of thousands of files in git). Later, if git pain is measured.
- A second registry, database, or GitHub Project field as source of listing truth.
- Changing what `publish` means. Local emission stays local.
- Ranking, scoring curves, "state of the art" badges, or default order by score or by how many times a claimant has listed.
- Folding `colophon board submit` into the first build. The GitHub door ships first; the CLI is a later opener of the same issue.
- Rewriting historical `verification.command` lines that name `@colophon-claims/verify`. The alias stays.

## 4. Constraints that bind

### 4.1 Static export

Verified facts about `colophon-claims/site` (this session cannot fetch that repository; they are taken as given):

- Next.js App Router, `output: "export"`. No API routes, no ISR, no middleware, no server.
- Exported site makes no external requests.
- Ingest is a build-time projector. Listing is a committed file.
- Site mutation remains a separate gate ([self-serve §4.2 / §10](../../../spec/2026-08-13-colophon-self-serve.md)).

Any option that requires a server on colophon.claims is declined on this constraint alone.

### 4.2 Bundle identity and publish

[`PUBLIC-BUNDLE.md`](../../../packages/benchmark-product/PUBLIC-BUNDLE.md): `bundle.json` is the exact canonical manifest and is not listed inside itself. The bundle identity is the lowercase SHA-256 of those exact manifest bytes. `publish` does not upload, host, deploy, register, or write remotely. A path, package URL, repository, or report name is never the bundle's canonical identity ([self-serve §3.1](../../../spec/2026-08-13-colophon-self-serve.md)).

### 4.3 Checker pin

Take the reader line from the claim package's `verification.command`, not from the format string. Prompted screening, qualification, and disclosure make the format string insufficient ([PUBLIC-BUNDLE.md Portable verification](../../../packages/benchmark-product/PUBLIC-BUNDLE.md)). `@colophon-claims/check` is the current package name; `@colophon-claims/verify` is the permanent alias those sealed lines name.

Self-serve §5.1: do not add `--yes` to the **human** quickstart; npm's first-download confirmation is supply-chain consent. CI and other non-interactive callers select their own confirmation policy. The listing workflow is such a caller.

### 4.4 Suite comparability

[`comparability.ts`](../../../packages/benchmark-product/core/src/runtime/suite-protocol/comparability.ts): `SUITE_PROTOCOL_IDS` are `terminal-bench-2.1`, `terminal-bench-3.0`, `swe-bench-verified`, `apex-agents`, `apex-swe-dev`, `deep-swe-v1.1`, `inspect-eval`. Coverage is `one_task | ten_task | full | custom`. Two-axis comparability is `execution_conformance` × `coverage`. Ordering a `full` run and a `one_task` run by score would compare incomparable runs.

Named slices are deterministic. [`namedSliceTaskNames`](../../../packages/benchmark-product/core/src/runtime/suite-protocol/manifest.ts) takes the lexicographic first 1 / first 10 / all of the official inventory. Two `one_task` Terminal-Bench 2.1 locks select the same task. `--ids` is `custom` and is not that prefix ([DR-2026-08-18-f](../../../log/decisions/2026-08-18-colophon-method-cli.md) decision 3).

Officialness is a property of the sealed document: suite protocol object present and conforming → official; absent → custom (DR-2026-08-18-f decision 5). A homemade Inspect / Harbor document has no suite id.

### 4.5 Venue disclosure

[`LOCAL_VENUE_LIMITS`](../../../packages/benchmark-product/core/src/operations/run-results.ts) and `VenueHonesty.venue` today are `"self-run"` only. DR-2026-09-04: only a Colophon-controlled venue flips three sealed-disclosure lines — who controlled the machine, whether pinning held, whether costs were independently seen. Today's listings will all show self-run lines. The row schema still carries the three lines so the page does not change shape when that venue exists.

### 4.6 Human surface

Board pages are a new domain model on a public human surface. Follow-on feat issues that change the site's model or action surface carry `human-surface`. This document (and the Stage 2 DR) is the design artifact those issues consume. Site UI changes land in `colophon-claims/site`, a different repository; the issues themselves are filed on `Jinn-Network/mono` as sub-issues of #3973.

## 5. Principles that bind the forks

**Legible.** Listing a bundle on a board is itself a claim: "this checked." An artifact that carries a claim must state what it does not prove ([PRINCIPLES.md](../../../PRINCIPLES.md); [EXTERNAL-VERIFICATION.md](../../../packages/benchmark-product/EXTERNAL-VERIFICATION.md)). The listing must name the checker line that ran, the bundle identity it ran against, and that a green check does not prove the producing venue was honest, that signing keys belong to independent parties, or that costs were independently settled. A listing that exists only in a private database is an unverifiable claim.

**Permissionless.** The path from outsider to participant has no privileged shortcuts. An operator-only ingest command, an email-us-the-folder path, or a human who silently declines to merge a green listing, is a shortcut. Auto-merge of an ingest PR whose only mutations are append-only listing files, after cold-verify succeeded, is the Permissionless reading. A later public revert is a visible act, not a silent filter.

**Neutral.** The network does not structurally benefit any entity. A board that ranks by score or by run count is a ranking. PRODUCT.md: the site must not look like a leaderboard. Newest-first is a ledger order, not a quality order. Run count may appear as a fact on the board header (how many checked bundles this board lists) without ordering rows by it.

## 6. Decision surface

Each fork compares two or three options, names the taken option, names the declined options, and gives one-paragraph why. A recommended-direction note that the files contradict is called out in §6.3.

### 6.1 What the site accepts

**Fork.** A bundle URL, a release asset, a repository path — three products, or one locator?

| Option | What the claimant hands over | What the workflow does |
|---|---|---|
| **A (taken). One locator, several syntaxes** | One string that resolves to a Colophon public-bundle directory (or a zip/tarball of one) | Fetch, unpack if needed, require `bundle.json` at the root of the resolved tree |
| B. Three products | Separate "URL", "release asset", and "repo path" submit flows | Three forms, three workflows, three failure dialects |
| C. Upload / email | Bytes on Colophon's machine first | A server, a mailbox, or a privileged operator copy |

**Taken: A.** Syntaxes for the same locator:

1. `https://` URL of a bundle **directory**. The workflow GETs `{url}/bundle.json`, then GETs every path `bundle.json` names, relative to that URL. Directory autoindex is not required. This is the honest HTTP shape of "I hosted the directory `publish` emitted."
2. `https://` URL of a zip or tarball whose top-level directory (or the archive root) is that bundle. GitHub release assets are this syntax, not a second product.
3. `owner/repo@ref:path` — GitHub-tree sugar. The workflow resolves `ref` to an exact commit OID, fetches that tree rooted at `path`, and requires `bundle.json` there. A moving branch is allowed as claimant convenience; the ingest PR records the resolved OID. The listing is of those bytes, not of the branch name.

**Declined: B.** Three products would teach claimants that hosting choice is a Colophon product fork. It is not. `publish` already emitted one directory.

**Declined: C.** File upload and "email us the folder" require a server or a privileged inbox. They also skip the public-host step that makes anyone else able to fetch the same bytes the checker saw. Permissionless fails; Legible fails (the site's copy would become the only copy).

Locator policy, fail-closed:

- `https:` only for URL syntaxes. `http:` to a non-public origin, `file:`, and credential-bearing URLs refuse.
- Private, loopback, link-local, CGNAT, multicast, unspecified, and similar destinations refuse (the same class of destination policy the corpus-artifact fetch already uses). The listing workflow must not become an SSRF proxy.
- Auth-gated GitHub trees and private release assets refuse. The locator has to be fetchable by a cold `GITHUB_TOKEN`-less HTTPS GET, or by the site repo's ordinary Actions token against **public** GitHub content.
- The resolved tree must contain `bundle.json` at its root after unpack. Nested "I zipped the parent of the bundle" refuses with that reason, not with a generic fetch error.

### 6.2 What happens before listing

**Fork.** Cold-verify with the published checker, or keep ingest's home-rolled manifest walk as the gate? What refuses, and how does it say so?

| Option | Gate | On failure |
|---|---|---|
| **A (taken). Cold published checker, then ingest projector** | `npx --yes @colophon-claims/check@<pin>` (or the sealed `verify` alias) against a cold npm cache, pin taken from the fetched claim package's `verification.command` | Workflow comments the checker's stdout (and stderr) on the submission issue and stops. No ingest, no PR |
| B. Ingest's local manifest walk is enough | Today's `scripts/ingest-report.mjs` validation | A listing that "validated" against a private copy of ingest, not against the published checker |
| C. Trust the claimant's own verify receipt | Claimant pastes a log | The site repeats a claim it did not recompute |

**Taken: A.** Procedure:

1. Fetch the locator into an ephemeral workspace (not the site git tree yet).
2. Read `claim-package.json` `verification.command` from those bytes. If that file is absent or the command does not parse, refuse `unknown-format` before npx.
3. Run that exact command against the fetched directory, with `--yes` because this is CI, and with `npx --cache` pointed at an empty temp directory so the install is cold. Do not rewrite the sealed package name; if the line names `@colophon-claims/verify`, that alias is the pin the bundle sealed. `--yes` is the self-serve exception for non-interactive callers, not a change to the human quickstart.
4. Success (process exits 0, and the tool's own report says the checks passed) is the listing gate.
5. On success, run existing ingest as the **projector** into `data/reports/<slug>.json` plus byte-exact `public/reports/<slug>/bundle/`. Ingest may still locally sanity-check the manifest. If ingest then refuses, that is a projector bug: fail closed, comment both the checker pass and the ingest refusal, do not list. Do not skip the checker because ingest would have passed. Do not skip ingest because the checker passed.
6. Open an ingest PR. Required checks: the cold-verify job (already green on this run; re-run on the PR against the committed copy) and the site build. When those are green and the diff is append-only listing files (new `data/reports/<slug>.json`, new `public/reports/<slug>/`, no edits to existing report URLs), auto-merge. Listing is the merge.

**Declined: B.** Today's ingest is a local manifest walk. Listing would then claim "this checked" while having run a private projector, not the published checker. Legible fails. PRODUCT.md: every number on the site is itself checkable — and the check has to be the one the bundle names.

**Declined: C.** A pasted receipt is not a check. Anyone can paste.

**Refuse, and say so on the submission issue** (no silent skip):

| Code | When | What the comment contains |
|---|---|---|
| `fetch-failed` | Locator does not resolve, non-200, truncated body | URL, status, and that nothing was listed |
| `blocked-origin` | Scheme or destination policy | The policy class, not the internals of the resolver |
| `unknown-format` | No `bundle.json`, or claim package has no parseable `verification.command`, or the format is one the site's ingest projector cannot emit `data/reports/<slug>.json` for | The missing piece. A bundle the checker would accept but ingest cannot project still refuses; the site does not grow a second, unprojected listing channel |
| `check-failed` | Checker non-zero, or checks not all passed | The checker's stdout and stderr, truncated to a stated byte cap with a note if truncated. This is the listing's "what it does not prove" sibling: the site refused because the named line refused |
| `duplicate-identity` | Lowercase SHA-256 of fetched `bundle.json` already appears in `data/reports/*` (the ingest JSON must carry `bundleSha256`) | The existing `/reports/<slug>/` URL. Same bytes do not get a second row |
| `slug-collision` | Proposed slug is taken by a **different** bundle identity | The taken slug and the assigned fallback (see §6.5) |
| `mutation-refused` | Diff would replace or edit `public/reports/<existing-slug>/` or `data/reports/<existing-slug>.json` | That listing URLs are append-only |
| `npm-unavailable` | Cold npx cannot install the pinned line | That listing did not happen; retry is the claimant's, not a fallback to ingest-only |

Do not refuse because the venue is self-run. Do not refuse because `leaderboardSubmitReady` is false. Do not refuse because the claimant is unknown. Those would be ranking or permission.

The submission surface is a GitHub issue form on `colophon-claims/site` (one locator field, optional proposed slug, optional claimant note that is not copied onto the board). A later `colophon board submit <locator>` in `packages/benchmark-product` opens that same issue. It is not a second door.

### 6.3 What a board is keyed on

**Fork.** Suite identity and coverage; method-document digest; operator-registered boards. How a custom method gets a board.

The recommended direction treated "suite protocol id and coverage" as equivalent to "the digest of the locked method document, which already binds those." **The files contradict that equivalence.** A locked method document also names the solver, host, arms, and pins. Two Terminal-Bench 2.1 `full` runs with different models are two method digests and one official slice. Keying official boards on method digest would give each configuration its own one-row board, which is a gallery of isolated claims, not a board of checked bundles for a suite. DR-2026-09-04 decision 5 keys a board on suite identity. This design keys official boards on suite identity and declines the equivalence.

The 0.1 draft took option A. The operator's direction of 2026-09-23 on #4715 takes option C, for usability: one place per suite for a reader to look. Option C is taken as that direction states it, which differs from C as first drafted in two ways: coverage is not ignored, it moves from the key onto every row; and a method with no suite protocol object keeps the digest board option A drafted.

| Option | Official suite, named slice (`one_task` / `ten_task` / `full`) | Official suite, `custom` coverage | No suite protocol object |
|---|---|---|---|
| A. Split key | `(suiteProtocolId, coverage)` | SHA-256 of the locked method document bytes | SHA-256 of the locked method document bytes |
| B. Always method digest | One board per exact locked document | Same | Same |
| **C (taken). Suite key, coverage on the row** | `suiteProtocolId`; the row shows the coverage | The same suite board; the row shows `custom` | SHA-256 of the locked method document bytes |
| D. Operator registers boards | A human creates the board, then listings attach | Same | Same |

**Taken: C.** Extraction:

- If the sealed method carries a conforming suite protocol object, the board key is its `suiteProtocolId`, whatever the coverage. Catalog ids are exactly `SUITE_PROTOCOL_IDS`. One board lists every checked bundle for that suite: `full`, `ten_task`, `one_task`, and `custom`.
- If there is no suite protocol object, the board key is the method-document digest. A homemade method has no suite id; its digest **is** the method.
- The first successfully checked bundle whose key is not yet present **is** that board's creation. No operator registration. Permissionless: an outsider's custom method gets a board by listing, the same way an official suite does.
- Coverage is a row fact, like `execution_conformance`. Every row on a suite board shows both (and the claim already carries `leaderboardSubmitReady` plus the limitation sentence), and any row short of `full` carries a visible marker. Neither splits a board. Hiding non-conforming runs or subset runs from a suite board would be a ranking choice: only show "valid" or "complete" scores. Neutral display lists every checked bundle for the suite, limitation attached.
- Comparability moves from the key to the page. Named slices are deterministic (§4.4), so two `ten_task` rows ran the same tasks; `custom` `--ids` selections are not a shared prefix, so two `custom` rows may have run different tasks. The board header carries the two-axis comparability reminder (`execution_conformance` × coverage), every row shows both axes, and rows are ordered by sealing time, never by score (§6.4). A subset row beside a full row is shown, not ranked.

**Declined: A.** The split key kept incomparable coverages off one page, at a cost to the reader: finding a suite meant knowing which coverage board to open, and each official `custom` run sat on its own digest board, apart from its suite. Usability outweighs that separation: one place per suite for a reader to look. What the split key carried by separation, option C carries on the page: the header reminder, the coverage fact and marker on every row, and an order that never ranks by score. The caveat is recorded in §12: the reminder and the marker state comparability; they cannot make a reader read it.

**Declined: B.** Method digest as the universal key fragments official suites per solver. That is not what "the suite identity is what a board is keyed on" says, and it makes the board look like a per-entrant trophy case.

**Declined: D.** Operator-registered boards are a privileged shortcut and a governance surface. Governance Minimal: push this to mechanism. The mechanism is "first checked listing creates the key."

Board URL: `/boards/<protocol>` for official suites (example `/boards/terminal-bench-2.1`), every coverage on one page; `/boards/method/<hex>` for digest keys, where `<hex>` is the 64-char lowercase SHA-256. `method` is not a suite protocol id, so the two shapes cannot collide. No operator-assigned display names as the identity. A human title may be derived from the suite display name (`suiteProtocolDisplayName`) or from the claim's method id; it is paint, not the key.

Bundles that wear an official suite but do not project `suiteComparability` refuse listing (`unknown-format`) rather than guess. Every row on a suite board shows its coverage; a guessed coverage would be a false row fact, and a missing one would drop the marker.

Existing two hand-ingested reports: re-project board keys, and for a suite its coverage, from the byte-exact `public/reports/<slug>/bundle/` already in git. Do not re-fetch. If a grandfathered bundle cannot project a key, or a suite bundle cannot project its coverage, it stays on `/reports/<slug>/` and does not appear on a board until a human resolves it. Fail closed, not a guessed suite or coverage.

### 6.4 What a listing shows, and in what order

**Fork.** Score, date, venue, three pinning lines, bundle link. Default order: newest, score, or run count?

| Option | Row | Default order |
|---|---|---|
| **A (taken). Fact row, newest first** | Score as the bundle states it; date; on a suite board, coverage and execution conformance; venue from sealed disclosure, not from who submitted; the three DR-2026-09-04 lines; same-origin bundle link | Sealing time descending; a reader may re-sort by any column except the score |
| B. Score rank | Same facts plus position, delta, "best" | Highest score first |
| C. Run-count rank (operator suggestion, previously unruled) | Same facts | Claimants with more listed bundles first, or rows grouped by volume |

**Taken: A.** Row fields, all copied or projected from sealed bytes, never recomputed as a second opinion:

- **Score.** Whatever the claim package already presents as the result of this method: `headline` for a headline-shaped claim, `comparison` for a comparison-shaped claim, `qualification` for `binary-instrument@1`. Do not invent a single numeric "board score." A comparison-shaped claim has no headline; the row shows the comparison, not a dash pretending to be a rankable number. Attach the claim's own limitations on the row (truncated to the limitation sentences; full text lives on the report page).
- **Date.** `reportedAt` from the ingest JSON (today's sort key). This is listing time in the projector, which must continue to be a fact about when the site ingested, or a timestamp the bundle itself seals — the follow-on ingest change must pick one and document it on the row. Taken: prefer a timestamp the bundle seals (`report.json` / claim package) when present; fall back to ingest time and label it "listed at" so the site does not imply the run happened then.
- **Coverage and execution conformance.** On a suite board, `suiteComparability.coverage` and `suiteComparability.executionConformance` from the claim package, on every row. Any row short of `full` coverage carries a visible marker. These are facts, not filters: no row is hidden or demoted for either. A method-digest board shows neither: a method with no suite protocol object seals no `suiteComparability`, and its rows share one locked method document.
- **Venue.** `venueHonesty.venue` from the claim package. Today that is `"self-run"`. When a Colophon-controlled venue exists, that sealed value is what the row shows. Who filed the GitHub issue is not venue.
- **Three pinning / independence lines**, DR-2026-09-04's names, projected from the sealed disclosure / `venueHonesty.limits`, not rewritten:
  1. Who controlled the machine.
  2. Whether pinning held.
  3. Whether costs were independently seen.
  On today's self-run bundles these are the corresponding `LOCAL_VENUE_LIMITS` sentences (operator controls dispatch, execution, and evaluation; pinning is an admission gate on the owner's machine; costs are self-reported). The row quotes them. It does not summarize them into a traffic-light.
- **Bundle link.** Same-origin `/reports/<slug>/bundle/`, the byte-exact copy ingest already writes. The locator the claimant hosted is recorded in `data/reports/<slug>.json` as provenance; it is not the identity and it is not required to stay up for the listing to remain checkable. Anyone checks the site's copy with the pinned command against `/reports/<slug>/bundle/`.

Board **header** (not a row, not an order): board identity (suite protocol id, or method digest); how many checked bundles this board lists (a count, not a rank); on a suite board, the two-axis comparability reminder: rows are comparable only where both `execution_conformance` and coverage match, so a subset row beside a full row is shown, not ranked. No "best score." No sparkline.

**Order.** The default order is the row's date, newest first: the time the bundle seals, or the listing time labeled "listed at" where it seals none (Date, above). The exported page is built in that order, so the default renders without script. A reader may re-sort by any column except the score, in the browser, using the page's own script: no external requests, and the sortable column headers are keyboard-operable. The score is not a sort key. It is the claim's own projection, not one number, and a sort by score would be the ranking option B declines. A re-sort is the reader's own view; the order the site publishes stays sealing time.

**Declined: B.** Score-ranking is a leaderboard. PRODUCT.md forbids it. Neutral forbids structurally benefiting the high scorer with position. The `/reports` index already refuses ranking in those words; board pages reuse that sentence.

**Declined: C.** Ordering by run count ranks claimants by volume. A well-resourced claimant who lists often would own the top of the board without a stronger claim. The count belongs on the header as a fact ("N checked bundles"), not as a sort.

`/reports` stays the chronological ledger of every listing (newest first, already built). `/boards` and `/boards/<key>` sit above it as the grouping by suite, or by method where there is no suite. Neither replaces the other. Replacing `/reports` with boards-only would hide listings whose board key is still being resolved; sitting above keeps the ledger.

### 6.5 Where the state lives

**Fork.** `data/reports/` as today; a second registry; a database.

| Option | Source of truth | Checkable? |
|---|---|---|
| **A (taken). The git tree the site already serves** | `data/reports/<slug>.json` + byte-exact `public/reports/<slug>/bundle/` | Clone the site repo, or fetch the exported files, and run the pinned checker on `public/reports/<slug>/bundle/` |
| B. Registry service / database / Project field | A store the export does not serve | A listing that exists only there is an unverifiable claim |
| C. Locator-only (site stores a URL, fetches at view time) | Claimant's host | The exported site would make a runtime request, and the bytes could change |

**Taken: A.** Duplicate identity is keyed by `bundle.json` digest, not by slug. Slug is the durable URL path, nothing else.

Slug assignment:

1. Claimant may propose a slug in the issue form (URL-safe, bounded length).
2. If free, use it.
3. If taken by the same bundle identity, this is `duplicate-identity`, not a new slug.
4. If taken by a different identity, or if omitted / invalid, assign `sha256-` plus the first 12 hex characters of the bundle identity. If that too collides (astronomical), extend the prefix until unique. Never replace an existing slug.

Append-only: ingest already refuses to replace existing slugs. The workflow must not pass `--force`. Mutation of an existing report URL is `mutation-refused`.

Blob-hosting of huge bundles is **not** designed here. The LoCoMo tree-in-git pain is noted as a later build **if measured**. Until then, ingest keeps copying byte-exact into `public/reports/<slug>/bundle/`. Git LFS is also not designed here; introducing it would be a site-repo operations decision with its own issue.

**Declined: B.** A registry the static site does not serve cannot be the listing. Project fields are paint on Jinn's engineering board and are not a Colophon product surface.

**Declined: C.** Runtime fetch from the exported site is forbidden. Bytes at a claimant URL can change after listing; the site would then display a claim it no longer holds.

## 7. End-to-end protocol

```text
claimant                     GitHub (site repo)                 exported site
--------                     ------------------                 -------------
publish locally
host locator (HTTP/zip/tree)
open issue form  -----------> workflow:
                                fetch locator
                                cold npx of sealed line
                                ingest projector (append-only)
                                open PR
                              auto-merge if green + append-only
                                                                /reports/<slug>/
                                                                /reports/<slug>/bundle/
                                                                /boards/<key> includes the row
```

Roles:

- **Claimant.** Publishes locally, hosts a locator, files the issue (or later runs `colophon board submit`).
- **Workflow.** Fetches, checks, projects, opens the PR. No human in the success path.
- **Site git.** The registry.
- **Exported pages.** Display. They never fetch the locator again.
- **Reader.** Checks `/reports/<slug>/bundle/` with the pinned command. The listing page tells them that command.

Crash / ambiguity (same default as the rest of Colophon: read the bytes back):

- Issue opened, workflow dies before fetch: claimant sees a failed check; retry by adding a comment that re-runs, or by opening a new issue. Duplicate-identity will catch a double success.
- Fetch succeeds, check succeeds, ingest PR open, auto-merge fails: the PR is the recovery surface. A human on the site repo may merge an already-green append-only PR; that is repair, not a second gate.
- Two locators, same `bundle.json` digest, two issues: first merge wins; second refuses `duplicate-identity`.
- Two locators, different identities, same proposed slug: first merge wins the slug; second gets the digest fallback or `slug-collision` then fallback.

## 8. What a listing claims, and what it does not

Every board page and every listing row states, in those words or a BRAND-clean equivalent already on `/reports`:

- Colophon does not rank reports against each other.
- Listing means the published checker, at the line this bundle pins, passed against the bytes now at `/reports/<slug>/bundle/`.
- A passing check does not prove the producing venue was honest, that distinct keys are independent parties, that isolation was strong, or that costs were independently settled ([EXTERNAL-VERIFICATION.md](../../../packages/benchmark-product/EXTERNAL-VERIFICATION.md) table, last four rows).
- On a suite board, rows are comparable only where both `execution_conformance` and coverage match. A row short of `full` carries a visible marker, and a row's place in the order is its sealing time, not its score.

The three independence lines on the row are the sealed disclosure, not Colophon's endorsement of them. A self-run row that says the operator controlled the machine is repeating the bundle, not softening it.

## 9. Site domain model (for follow-on human-surface issues)

Board pages are a new product component on `colophon-claims/site`. This section is the domain model those issues must land with, per the frontend spec rule.

### Board

- **State.** Key (suite protocol id, or method digest); derived title; count of listed bundles; on a suite board, the two-axis comparability reminder.
- **State messages.** Empty board does not exist (a board is created by its first listing). A grandfathered report that cannot project a key (or, for a suite, its coverage) is not on any board; that is reported on the report page, not as a board message.
- **Collections.** Listings, in default order by sealing time, newest first (§6.4). No pagination required at first ship; add only if a board's row count is measured as a problem.
- **Actions.** `re-sort by column`: by any column except the score, in the reader's browser, with the page's own script and keyboard-operable column headers. Action states: `default order → sorted by <column> (ascending | descending)`. No request, no mutation, no failure state; without script the action is absent and the default order stands. A board is otherwise read-only display. Submit lives on GitHub, not on the page.

### Listing (row)

- **State.** Score projection as §6.4; date; on a suite board, coverage and execution conformance, with the marker on a row short of `full`; venue; three independence lines; slug; bundle identity; same-origin bundle href; locator provenance (not identity).
- **State messages.** None beyond the claim's own limitations, which are content.
- **Collections.** None.
- **Actions.** None on the row. The bundle link is navigation, not an action with lifecycle.

### Submission

- **State.** Not a site-page component. The GitHub issue form is the action surface. Issue states: open → workflow running → refused (comment + close or leave open for retry) → ingest PR → listed (issue closed with the `/reports/<slug>/` URL).
- **Actions.** `submit locator` (human on GitHub, or CLI that opens the issue). Action states: `idle → submitted → checking → listed | refused`.

No helper-text cruft on board pages. A label plus its value is enough. The non-ranking sentence is not cruft: it is the claim boundary, the same class as `/reports` already prints. Tooltips may explain "self-run" and the three lines; they must not narrate the numbers.

## 10. Consequences

- Step 8 of the claimant path exists, and it does not require an operator to copy a folder.
- `colophon-claims/site` gains a workflow, an issue form, board routes, and ingest fields (`bundleSha256`, board key, venue projection, locator provenance). The export remains static.
- Ingest stays the projector. The published checker becomes the listing gate. The two must not drift: a checker pass plus ingest refusal is a fail-closed bug, not a skip.
- Official suite boards will mix models, harnesses, claimants, and coverages. That is the point: one place per suite for a reader to look. Coverage and conformance are on every row, and no row is ordered by score.
- Custom methods appear without a catalog change. The catalog remains how you **bind** an official suite, not how you **display** one.
- Auto-merge of append-only listing PRs is a site-repo settings change (branch protection / CODEOWNERS exceptions for the workflow actor). The follow-on issue names it. If the site repo cannot auto-merge without a human, Permissionless is not met and the issue is not done.
- Git history of `public/reports/` continues to grow. Blob-hosting remains a later, measured issue.
- Stage 2 writes `log/decisions/2026-09-21-board-front-door.md`. That path is CODEOWNERS. This issue parks for human approval of the DR; it does not implement.

## 11. Follow-on build issues

File on `Jinn-Network/mono` as sub-issues of #3973. Each is triage-complete: context, impact, binary acceptance. Code for 11.1–11.3 lands in `colophon-claims/site`. This spec / the Stage 2 DR is the design they consume. Issues that change the site's model or action surface carry `human-surface`.

Do not implement them in #3993.

### 11.1 feat(site): submission issue form, cold-verify workflow, ingest-on-success PR

- **Repo.** `colophon-claims/site`. Tracking issue on `Jinn-Network/mono`, sub-issue of #3973, label `human-surface`.
- **Context.** Claimants have no submit path. Ingest is operator-only and does not run the published checker.
- **Impact.** Step 8 of the claimant path exists; listing becomes a checkable claim.
- **Acceptance.**
  - [ ] An issue form on `colophon-claims/site` accepts one locator and an optional slug; no file upload.
  - [ ] A workflow fetches the locator under §6.1 destination policy, runs a cold `npx --yes` of the claim package's `verification.command` against an empty npx cache, and on success runs `scripts/ingest-report.mjs` without replacing existing slugs.
  - [ ] `data/reports/<slug>.json` carries `bundleSha256` (lowercase SHA-256 of `bundle.json`), board key fields, venue projection, locator provenance, and resolved git OID when the locator was `owner/repo@ref:path`.
  - [ ] Duplicate `bundleSha256` refuses with `duplicate-identity` and comments the existing `/reports/<slug>/` URL.
  - [ ] Checker failure comments stdout/stderr and does not open an ingest PR.
  - [ ] Green append-only ingest PRs auto-merge without a human click. Existing report URLs cannot be mutated by this workflow.
  - [ ] The exported site still has no API routes and makes no runtime fetches.
- **Files (site repo).** `.github/ISSUE_TEMPLATE/` (submit form); `.github/workflows/` (cold-verify + ingest PR); `scripts/ingest-report.mjs` (new fields, duplicate-identity, slug fallback); `data/reports/` (schema of the emitted JSON).

### 11.2 feat(site): board pages keyed by suite, or by method digest

- **Repo.** `colophon-claims/site`. Tracking issue on `Jinn-Network/mono`, sub-issue of #3973, label `human-surface`.
- **Context.** `/reports` is a flat newest-first ledger. DR-2026-09-04 keys a board on suite identity; custom methods have no suite id.
- **Impact.** Every checked bundle for one suite, or for one method with no suite, is visible in one place without ranking.
- **Acceptance.**
  - [ ] `listReports()` still sorts by `reportedAt` descending and still excludes `*.presentation.json`.
  - [ ] `/boards` indexes boards. `/boards/<protocol>` serves one official suite, with every coverage (`full`, `ten_task`, `one_task`, `custom`) listed on it; `<protocol>` is one of `SUITE_PROTOCOL_IDS`. `/boards/method/<64-hex>` serves digest keys.
  - [ ] Board key extraction matches §6.3: the suite protocol id from a conforming suite protocol object, whatever the coverage; otherwise the method-document digest. Missing `suiteComparability` on a bundle that claims an official suite does not guess.
  - [ ] Every row on a suite board shows its coverage, and a row short of `full` carries a visible marker (row fields per 11.3). `custom` official-suite coverage is listed on the suite board, not on a digest board.
  - [ ] A suite board's header carries the two-axis comparability reminder.
  - [ ] The default order (sealing time, newest first) renders without script. A reader may re-sort by any column except the score, in the browser, using the page's own script, which makes no external requests; the sortable column headers are keyboard-operable.
  - [ ] First listing whose key is new creates the board. No registration UI, no operator catalog of boards.
  - [ ] Grandfathered reports re-project from existing `public/reports/<slug>/bundle/` bytes. A bundle that cannot project a key, or for a suite its coverage, stays on `/reports/<slug>/` only.
  - [ ] `/reports` remains the chronological ledger. Board pages sit above it.
  - [ ] Exported site remains static; board pages are built from `data/reports/*.json` at `npm run build`.
- **Files (site repo).** `lib/reports.ts` (key derivation, board grouping); `app/boards/` (index, suite and method routes, and the board page's own sort script); existing `app/reports/` retained.

### 11.3 feat(site): listing row fields as ruled

- **Repo.** `colophon-claims/site`. Tracking issue on `Jinn-Network/mono`, sub-issue of #3973, label `human-surface`.
- **Context.** A board row must show the claim's own result, date, coverage and conformance on a suite board, venue, the three independence lines, and a bundle link, without looking like a leaderboard.
- **Impact.** The display matches PRODUCT.md (no ranking) and DR-2026-09-04 (venue lines from the sealed disclosure).
- **Acceptance.**
  - [ ] Each row shows: the claim's own result projection (`headline` or `comparison` or `qualification`, not a synthesized board score); date labeled as sealed report time or "listed at" per §6.4; on a suite board, coverage and execution conformance from `suiteComparability`, with a visible marker on any row short of `full`; venue from `venueHonesty.venue`; the three independence lines quoted from the sealed disclosure; link to `/reports/<slug>/bundle/`.
  - [ ] Default order is sealing time, newest first (the row's date, §6.4). No control sorts by score. No control sorts by run count.
  - [ ] Board header may show the count of checked bundles as a fact. That count does not order rows.
  - [ ] The non-ranking sentence already on `/reports` appears on each board page.
  - [ ] Who submitted the GitHub issue does not appear as venue.
  - [ ] No helper-text cruft restating the numbers. Tooltips allowed for "self-run" and the three lines.
- **Files (site repo).** board row component under the site's existing UI kit; `lib/reports.ts` projections; copy on `app/boards/`.

### 11.4 feat(benchmark-product): `colophon board submit` opens the GitHub door

- **Repo.** `Jinn-Network/mono`, `packages/benchmark-product`. Sub-issue of #3973. File **after** 11.1 is listed-on-the-board in production, not in parallel as a second door.
- **Context.** Claimants already have `colophon` locally. Opening a browser to an issue form is extra ceremony once the GitHub door works.
- **Impact.** Same listing protocol, less ceremony. Not a bypass of cold-verify.
- **Acceptance.**
  - [ ] `colophon board submit <locator>` creates an issue on `colophon-claims/site` using the same form fields (locator, optional slug). It does not upload bytes, does not run ingest, and does not write the site repo.
  - [ ] The verb refuses a local directory that has not been hosted (no implicit zip-and-upload).
  - [ ] Help text names that listing still waits on the site workflow's cold check.
  - [ ] Skill-text / USAGE pins in the CLI package include `board submit` and do not mention a site API.
- **Files.** `packages/benchmark-product/cli/` USAGE / verbs; operations facade if one already owns GitHub-opening helpers; tests that the command only opens the issue.

### 11.5 Not filed from this design

- Colophon venue independence service (DR-2026-09-04). Named, not designed.
- Blob-hosting or Git LFS for large `public/reports/` trees. File only after git pain is measured.
- Changing `@colophon-claims/verify` sealed lines. The alias stays.

## 12. What this does not yet prove

- That `colophon-claims/site` branch protection can auto-merge a machine ingest PR. 11.1's acceptance includes proving it or changing the settings; this spec cannot prove a private repo's rules.
- That every historical bundle in `public/reports/` projects a board key. Grandfathering fails closed per §6.3.
- That a Colophon-controlled venue will exist, or what bytes it will seal into the three lines. Rows are shaped for it; the service is not designed.
- That npm will be available at listing time. `npm-unavailable` refuses rather than falling back to ingest-only.
- That the claimant's locator remains up. The site's byte-exact copy is what remains checkable.
- That a reader will not take a subset row for a full-suite result. One board per suite puts them side by side; the header reminder and the row marker state the difference, and they cannot make a reader read it.

## 13. Mapping to issue #3993 acceptance

- [x] Each fork above is ruled with the option taken and the options declined (§6.1–§6.5). §6.3 carries the operator's direction of 2026-09-23 on #4715: option C taken, the split key declined.
- [x] Follow-on build issues are specified so they can be filed as triage-complete sub-issues of #3973 (§11). Filing is a coordinator/operator act after the DR; this session has no GitHub credentials.

## 14. Headless decisions log

No human was present. HARD-GATE approval was overwritten by the session prompt. Decisions made from the files rather than from asking:

1. **Revised the recommended-direction equivalence in §6.3.** Method-document digest is not equivalent to suite×coverage: the document also names solver, host, and arms (`claim.ts` method block; DR-2026-08-18-f officialness vs homemade). DR-2026-09-04 decision 5 keys boards on suite identity. Taken in 0.1: split key. Declined: universal digest. Superseded in part by the operator's direction of 2026-09-23 on #4715, which takes option C: one board per suite, coverage a row fact. The split key is now declined; the refusal of the universal digest stands.
2. **Auto-merge of append-only ingest PRs.** Permissionless forbids a silent human filter on green listings. Repair merges remain allowed.
3. **`execution_conformance` does not split boards.** Hiding non-conforming official-suite runs would be a ranking choice. In 0.1 coverage still split, because the task set differs (`namedSliceTaskNames` vs `--ids` → `custom`). Under the operator's direction of 2026-09-23 coverage is a row fact too, so neither axis splits a suite board; the header reminder and the row marker carry the difference.
4. **Cold check runs the sealed `verification.command`**, including the `verify` alias, rather than rewriting the package to `check`. Legible: the site ran the line the bundle named.
5. **Did not design blob-hosting** despite known LoCoMo git weight; the prompt forbids designing it in this DR.
6. **Did not file the §11 issues.** No `gh` credentials in this stage; the documents are the filing payload for after the DR.
7. **The score is not a reader sort key.** The operator's direction lets a reader re-sort by column and says rows are never ranked by score. A row's score is the claim's own projection, not one number (§6.4), so a score sort would need the single board score this design declines. Taken: every column except the score sorts. The operator may rule otherwise.
8. **Sealing time falls back to listing time.** Where a bundle seals no timestamp, the default order uses the listing time, labeled "listed at", by the date rule §6.4 already states.
)
