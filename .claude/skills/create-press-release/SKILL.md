---
name: create-press-release
description: End-to-end builder for a Jinn external press release — from milestone brief, through on-chain evidence gathering and screenshot spec, to template-shaped draft, distilled prose, PRINCIPLES.md Legibility cross-check, PII + regulatory scrub, and a committed file under docs/press/. Use when the user wants to announce a Jinn milestone externally, write a press release, draft an announcement, ship comms for a Phase milestone, or turn a notable result into a publication-ready artifact. Triggers on "write a press release", "draft a release", "announce this milestone", "external announcement", "we should write something about this", "press release for [milestone]", "comms for [event]", "ship comms about". Not for X threads (use x-post-builder), not for GitHub Discussions of design proposals (use writing-plans / spec convention), not for internal status updates. Composes distil-writing for the compression pass.
---

# Create Press Release

End-to-end flow for shipping a Jinn external press release. Produces a committed markdown file under `docs/press/YYYY-MM-DD-<slug>.md` that serves as the canonical source for any derived artifact (X thread, blog post, Discussion).

## When to use

- The user reports a milestone worth announcing externally and asks for a press release, blog draft, or "comms" for it.
- The user says "we should write something about this" or "let's ship comms about this".
- The user wants a standalone document that backs a claim with on-chain receipts.

## When NOT to use

- The user wants a tweet or thread → use `x-post-builder`.
- The user wants a design proposal or technical spec → write a spec per `CLAUDE.md` §Spec Conventions.
- The user wants an internal status update or daily brief → use `eng-day` or `growth-day`.

## Canonical docs to read first

Always read these before drafting. They override anything in this skill.

- [`PRINCIPLES.md`](../../../PRINCIPLES.md) — the Legibility cross-check is mandatory; the other principles (Neutral, Learning Maximised, Governance Minimal, Permissionless, Prestige) constrain framing choices.
- [`THESIS.md`](../../../THESIS.md) — why Jinn exists.
- [`BRAND.md`](../../../BRAND.md) — voice, headless-brand posture, content non-negotiables.
- [`GROWTH.md`](../../../GROWTH.md) — product-led distribution; positioning derives from the GTM plan and `BRAND.md`.
- [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md) — current product and go-to-market framing.
- `CLAUDE.md` §External Communication — Jinn-specific framing, attribution, verb hygiene, PII rules.
- The user's own `~/.claude/CLAUDE.md` §External Communication — generic comms rules (strip jargon, distil).

## The flow

### Step 0 — Read canonical docs

Read in this order: `PRINCIPLES.md`, `THESIS.md`, `BRAND.md`, `GROWTH.md`, the benchmark-product GTM plan, `mono/CLAUDE.md` §External Communication. Do not skip — these rules override drafting choices.

### Step 0.5 — Milestone status gate (check before anything else)

Before intake, determine whether the milestone is **already achieved**.

- Run the milestone's check script (e.g. `operator/scripts/check-milestone-N.ts`) or query the indexer for the gate condition. State the result: HIT or NOT HIT, with the number.
- **If achieved:** proceed normally — a standard announcement, written against live receipts.
- **If NOT achieved:** stop and confirm with the user that this is a **proactive, Amazon-style "working-backwards" release** — *"what we will announce when the milestone is hit."* Do not draft a not-yet-true announcement without that explicit confirmation.

Once proactive mode is confirmed, the release is written **as if the milestone is already hit** (achievement-framed), with these adjustments:

- **Dateline** stays a placeholder — `**DD Month YYYY** —` — set at publish time, never invented now.
- **Receipts** carry placeholder tx hashes / operator addresses marked `<filled at publish>`. The *structural* claims (contract addresses, the gate criterion, the methodology) are real and verified now; only the hit-state figures are deferred.
- **Screenshots** are spec'd, not captured — the surface won't show the hit state yet. Step 9 defers to publish time.
- The filename uses the expected publish slug; the Appendix opens with **`STATUS: HELD — not for publication until the gate reports HIT (current: N/target)`**.
- `What this does not yet prove` additionally states the milestone is not yet reached at draft time.

### Step 1 — Brief intake (3 clarifying questions)

Ask the user three things in a single `AskUserQuestion` block:

1. **Channel** — standalone press release in repo, X thread (defer to `x-post-builder`), GitHub Discussion, or "draft one canonical source, derive variants later". Default for this skill is the first.
2. **Evidence source** — does the user already know the addresses / tx hashes / metrics, or should the skill discover them from the running daemon (`/v1/status` on `http://127.0.0.1:7331`) + the public indexer (`https://jinn-indexer-production.up.railway.app`) + on-chain calls via `cast`?
3. **Screenshot capture mode** — capture now via `chrome-devtools` / `claude-preview` MCP against the running daemon and explorer, or spec the shots for the user to capture.

### Step 2 — Evidence map (subagent)

Dispatch an `Explore` agent with breadth `very thorough` to map the relevant evidence surfaces. Cover:

- **Contracts.** Find canonical addresses for all contracts involved in the milestone. Check `operator/deployments/*.json`, `operator/src/earning/contracts.ts`, recent `spec/*.md`. Cite address + the deployment-JSON path it came from. Never paraphrase addresses.
- **Dashboard surfaces.** Walk `operator/src/dashboard/spa/src/pages/` and `operator/src/dashboard/spa/src/api/`. Identify the route + card + `data-testid` that renders each user-visible number the release will cite.
- **Indexer + API.** The public Ponder indexer at `https://jinn-indexer-production.up.railway.app` exposes both REST (`/explorer/network`, `/explorer/operators`, `/explorer/operator/:addr`) and GraphQL (`/graphql`). The local daemon exposes `/v1/status`. Both are evidence sources.
- **Recent commits.** `git log --oneline -30` plus targeted greps for the milestone's vocabulary. Cite SHAs.
- **Ponder schema.** `packages/indexer/ponder.schema.ts` is the authoritative shape of indexer entities. Use it to find the right table for the milestone (e.g. `rewardDistribution` for tJINN claims, `attempt` for solver activity, `verdict` for evaluator activity).

The subagent returns a tight report with `path:line` citations and verbatim addresses/URLs.

### Step 3 — Discover subjects (the "who" of the milestone)

Translate the milestone into specific on-chain subjects. Examples:

- *"Two operators earned tokens"* → query indexer for distinct multisig addresses with non-zero `jinnEarned` in the relevant window; cross-verify on chain with `cast call <distributor> "totalClaimedOperator(uint256)(uint256)" <serviceId>`.
- *"First successful evaluation of a new SolverNet"* → query indexer `verdict` entity filtered by SolverNet manifest CID; get the verdict tx + evaluator multisig.
- *"Mainnet deployment of contract X"* → read the deployment JSON; verify with `cast code <address>` against the mainnet RPC.

Get block timestamps with `cast block <n> --field timestamp --rpc-url <rpc>` and convert to ISO via Python. Record both block + UTC timestamp.

### Step 4 — Screenshot spec

For each user-visible number the release will cite, produce a one-line spec:

```
**Figure N — <surface name>.** URL: <url>. <What must be in-frame>.
```

Prefer the Jinn network explorer (`jinn-indexer-production.up.railway.app/`) and the operator dashboard (`http://localhost:7331/<route>`) over block explorers when the same number is in both — the Jinn surfaces show derived state, the block explorer is the fallback receipt path. Include block explorer (Sepolia Etherscan, Basescan) shots for the "verify without any Jinn surface at all" path.

Spec the shots before drafting the body — the figure numbers help the body cross-reference.

### Step 5 — Draft v1 (full template)

Apply this structure unless the milestone clearly demands otherwise.

**The entire release body is plain English** — grade-11 vocabulary in every section, not just the summary. A 16-year-old who's seen percentages, controlled experiments, and the rough idea of a benchmark should follow the whole document without help. No protocol jargon anywhere — no "verdicts" / "envelopes" / "on-chain" / "indexer" / "harness" / "manifest CID" / "tx hash" without an immediate plain-English gloss on first use ("the wrapper that runs the AI", "a public ledger anyone can check"). The opening summary is the TL;DR; every section after it stays in the same register.

```
# <Headline — one sentence, news-led, no slogans>

**<Subheadline — one sentence expanding significance>**

## The short version

<2-3 short paragraphs — the TL;DR. State the milestone, the control variable, and the verification path in language a non-technical reader actually parses. End with the verification path in one sentence: anyone can check this, here's how. This is the opening of a fully plain-English document, not a quarantine for the only readable section.>

---

**DD Month YYYY** — <Opening paragraph: state the announcement directly, name Jinn Network, name the milestone, name the core significance.>

<Second paragraph: explain the problem the milestone addresses. Make it concrete. Show what existing approaches miss.>

## How <the loop / the contract / the system> works

<Plain-English explanation, structured as feature → enables → matters. Same grade-11 register as the rest of the document — describe each moving part in words a non-technical reader parses, and gloss any unavoidable term on first use. Use bullets per moving part. Each bullet anchors on a contract address or canonical doc.>

## The receipts

<Table of the specific subjects with on-chain figures. Latest tx hashes with explorer links. Indexer-derived network stats as bullets. Closing one-liner with the "Jinn surface vs raw eth_getLogs" distinction.>

## What's different

<Differentiation, 1-2 short paragraphs. No competitor naming unless source material requires it.>

## What this does not yet prove

<MANDATORY for any milestone release. Name the trust steps the chain does not close: distinctness vs independence, mock components, testnet vs mainnet, social assertions.>

## Quote

> "<Quote that adds interpretation, not announcement-restatement.>" — Jinn contributor

## Availability and next

<Concrete next milestones; on-ramp for participants.>

## About Jinn Network

<About-block boilerplate per CLAUDE.md §External Communication framing — product positioning from THESIS.md, BRAND.md, GROWTH.md, and the benchmark-product GTM plan; no fixed universal headline phrase.>

---

## Appendix A — Production notes (not for publication)

### Screenshots
<Figure spec from Step 4.>

### Assumptions
<What the release assumes that isn't proven inline.>

### Claims to verify before publication
<6-10 line list of specific claims to double-check at publish time.>

### Alternative headlines
- **Technical** — <…>
- **Ecosystem** — <…>
- **Media-friendly** — <…>

### Principles touched
<Which `PRINCIPLES.md` principles the release is in scope of.>
```

### Step 6 — Distil

Invoke `distil-writing` on the draft. Cut by ~30% minimum. The body should sit ~600-900 words; the appendix is excluded from the cut.

### Step 7 — PII + regulatory scrub

Sweep for prohibited terms:

```bash
grep -n -E -i 'team|co-founder|executive|\bpaid\b|\bpays\b|\bpaying\b|paying' <file>
grep -n -E -i 'LONDON|NEW YORK|SAN FRANCISCO|<known-contributor-name>' <file>
```

Any hit must be either removed or justified. Verb substitutions per `CLAUDE.md` §External Communication §Verbs. PII removals per §PII. No dateline city, no named attribution by default.

### Step 8 — Legibility cross-check

**This is not Step 7.** Step 7 is hygiene — grep for prohibited surface vocabulary. Step 8 is substance — the inside of each sentence, the math, the citations, the conditionals. Grep cannot do Step 8 because grep cannot see meaning. Reporting Step 7's "clean" output as Step 8 done is the failure mode this step exists to prevent.

Run as a deliberate pass with its own output. The protocol:

1. **Enumerate every assertive sentence in the body.** Headline, subhead, dateline opening, How-it-works bullets, receipts, What's-different, framing around the Quote. Skip the Quote itself and the About-block boilerplate. Write the list out — a numbered list in your turn output, or as a temporary scratchpad. Do not work from memory.
2. **For each claim, name the source-of-truth in one phrase.** Indexer URL, spec line, deployment JSON path, contract call, git SHA, screenshot caption, canonical-doc section. If you can't name one in five seconds, the claim is not yet Legible.
3. **For every numeric claim, do the arithmetic by inspection.** If the body says "windows separated by N verdicts", compute N from the window definitions and confirm it matches. If it says "75/25 to the wei", check the rounding. Counts, percentages, block ranges, time gaps, window offsets — verify each one. A surface-clean bullet can hide a wrong number; only inspection finds it.
4. **For every conditional claim ("X is attributable to Y", "this proves Z"), list the conditions that must hold.** Confirm each condition is either stated in the body or moved to `What this does not yet prove` with the trust step named.
5. **Tighten or relocate.** Verifiable claims stay. Unverifiable claims either tighten to what is verifiable (`distinct` not `independent`) or move to `What this does not yet prove` with the trust step named.

Do not report Step 8 complete on the basis of Step 7's grep output. Step 7 reports "no prohibited vocabulary appeared." Step 8 reports "every assertive sentence has been walked, the source-of-truth is named, the numerics check out, and the conditionals have their conditions." These are different sentences; only one of them is the Legibility check.

The `What this does not yet prove` section is not optional. If a release has no Legibility caveats, the caveats have been hidden, not absent.

### Step 9 — Screenshot fact-check (if shots provided)

When the user supplies screenshots:

- Confirm every figure in the shot matches the body to the wei.
- Tighten precision in the body where the shot is more precise (e.g. 80% → 79.9%).
- Update the screenshot spec to match what was actually captured if the shot deviates intentionally.
- Note any spec'd shot still outstanding.

### Step 10 — Commit + offer PR

Commit the file to `docs/press/YYYY-MM-DD-<slug>.md` with a `docs(press):` commit message and `Co-Authored-By: Claude` trailer. **Do not merge without admin approval** — offer the PR, wait for explicit sign-off.

## Output format

- The release file at `docs/press/YYYY-MM-DD-<slug>.md`, body + Appendix A.
- A summary of decisions worth flagging: editorial choices, sacrificed nuance from the distil pass, outstanding items in the verification list.
- A list of clarifying questions if any framing decision is ambiguous.

## Hard rules

- Read `PRINCIPLES.md` and `BRAND.md` before drafting. Always.
- Run `distil-writing` before claiming the draft is ready. Always.
- Run Step 8 (Legibility) as a substantive claim-by-claim pass — never report it complete on the basis of Step 7's grep. Always.
- Check milestone status before drafting (Step 0.5). If the milestone is not yet achieved, confirm with the user that this is a proactive, working-backwards writeup before drafting. Always.
- Write the **entire release** in plain English — grade-11 vocabulary in every section, protocol jargon glossed on first use throughout, not quarantined to one block. Open with a short-version summary that ends with the verification path. Always.
- Include a `What this does not yet prove` section. Always.
- No dateline city. Ever.
- No named attribution by default. Ever — until the contributor signs off explicitly.
- No `paid` / `pays` / `team` / `co-founder` in any artifact this skill produces.
- About-block product framing derives from CLAUDE.md §External Communication authorities; do not mandate a single universal headline phrase.
- Commit, do not merge — wait for admin approval.
