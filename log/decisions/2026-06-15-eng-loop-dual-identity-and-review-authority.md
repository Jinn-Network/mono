# Give the engine autonomous review authority on the black-boxable majority, behind two identities and an author allowlist

- **id:** DR-2026-06-15
- **Date:** 2026-06-15
- **Author:** opus
- **Status:** Accepted — operator direction (2026-06-15). Phased implementation
  tracked in [#1219](https://github.com/Jinn-Network/mono/issues/1219).
- **Verb:** Steer

## Summary

The `eng-loop` dispatcher implements issues into draft PRs and (per
`spec/2026-05-29-pr-review-loop-design.md`) can run an independent `review-pr`
loop over PRs labelled `engine:review`. We adopt **Model A**: the engine
**approves** the PRs it is satisfied with, so the *black-boxable majority* of
changes clear the `next` branch-protection 1-review gate autonomously, while
**human surfaces continue to require a human code owner** ([[DR-2026-06-03]]).

Two facts make this non-trivial and are the substance of this decision:

1. **GitHub forbids approving your own PR.** So the engine needs **two distinct
   GitHub identities** — an *implementer* that authors PRs and a *reviewer* that
   approves them. Today neither is wired: both spawned session types inherit the
   runner's single active `gh` account.
2. **The repo is PUBLIC and the engine runs untrusted-influenceable input.**
   `review-pr` **checks out the PR head branch and runs it** (the `app-test`
   stage). Reviewing an untrusted fork PR is therefore **arbitrary code
   execution on the runner** — before any approval question. So the engine must
   act only on an **author allowlist**, and that allowlist must be
   un-tamperable by the very PRs it gates.

## Context

`next` branch protection (verified 2026-06-15): `required_approving_review_count: 1`,
`require_code_owner_reviews: true`, `enforce_admins: false`. `.github/CODEOWNERS`
names `@oaksprout @ritsukai` on the load-bearing human surfaces only (canonical
docs, dashboard SPA, indexer explorer UI). So:

- A PR **not** touching a code-owned path needs **one** approving review from any
  write collaborator — an engine reviewer can satisfy this.
- A PR touching a code-owned path **additionally** needs a **code-owner**
  approval — which an engine identity must never be able to give ([[DR-2026-06-03]]:
  *"an agent's approval never satisfies this gate."*).

This is the seam: the engine clears the black-boxable majority; humans stay on
the load-bearing surfaces. Model A operationalises exactly that seam.

The org currently has only three human accounts (`oaksprout`, `ritsukai`,
`ritsuKai2000`) — all **admin** — and no bot or GitHub App. The 36 engine PRs
from 2026-06-14 were authored by `ritsukai`, so nothing could review them
without manual `gh auth switch`-ing to a second account.

## Decision

### 1. Two identities (least privilege, non-code-owner)

- **`jinn-impl-bot`** — authors engine PRs. Repo permission **write** (not
  admin). Scopes: `contents:write`, `pull_requests:write`.
- **`jinn-review-bot`** — reviews and approves. Repo permission **write** (not
  admin). Scopes: `pull_requests:write`, `contents:read`.
- **Neither is a code owner and neither has admin / merge / branch-protection
  bypass.** A fully prompt-injected session can therefore at most push a branch
  and post a review — it can never merge or weaken protection. A **human** still
  performs every merge.
- Making the *implementer* a bot (not `ritsukai`) is deliberate: it lets the
  human code owners (`ritsukai`, `oaksprout`) review and approve the engine's
  **human-surface** PRs, which they could not if they were the author.

**v1 credential = fine-grained PATs on two machine accounts**, injected per
session via `GH_TOKEN` (cheap, least-privilege, trivial on the laptop runner).
**Migration path = GitHub App(s)** when the runner moves to hosting and we want
short-lived auto-rotated tokens — note one App is a single identity, so author ≠
reviewer requires **two** Apps (or App + machine account).

### 2. Six security gates (defense in depth)

1. **Implement only if issue author ∈ allowlist** (exists: `ready-filter`). The
   implement session ingests `gh issue view --json body` only — **not comments**
   — so an untrusted commenter cannot inject into an implement run.
2. **Review/approve only if PR author ∈ allowlist — enforced *before* the review
   worktree is checked out**, because `app-test` runs the branch. This is the
   single most important hardening and closes the public-repo RCE hole. The
   review-side trusted-author set must include `jinn-impl-bot` (so the engine
   reviews its own PRs) plus the trusted humans.
3. **The allowlist lives in the runner environment/secret, never in the repo**,
   so no PR can add its own author to it. Fail-loud if empty (exists).
4. **Bots are write, not admin; no merge, no bypass** (see §1).
5. **Reviewer identity ≠ author identity** — fail-loud at boot if equal.
6. **Approval is necessary-not-sufficient** — an engine approval clears only the
   generic 1-review gate on non-code-owned PRs; code-owned (human-surface) PRs
   still require a human code owner, and a human performs the merge.

### 3. Human-surface PRs stay advisory

For a PR touching a code-owned path, `review-pr` runs its review **but does not
approve** — it posts findings and defers to the human code-owner gate
([[DR-2026-06-03]]). Engine approval is reserved for the black-boxable set.

## Options considered

- **Model B — advisory only, one identity.** The reviewer posts `COMMENT`
  reviews (allowed on own PRs) and never approves; a human approves everything.
  No second identity, simplest, honest. Rejected as the *target* because it
  banks none of the autonomy on the safe majority — but it is the graceful
  degradation if the second identity is unavailable.
- **Reuse `ritsuKai2000` as the v1 reviewer.** Works mechanically (it is an admin
  collaborator) and is the fastest path, but it is the *same operator's* second
  account (sock-puppet) and currently over-privileged (admin). Acceptable only as
  a stop-gap; the dedicated write-only `jinn-review-bot` is the real answer and
  avoids presenting same-operator approval as independent review (Legibility).
- **Single GitHub App for both roles.** Rejected: one App is one identity, so it
  hits the same self-approval block.

## Consequences

- Concurrent implement + review as different identities becomes possible
  (per-session `GH_TOKEN`, not global `gh auth switch`).
- The blast radius of a compromised/injected session is bounded to "push a branch
  + post a review" — never a merge. This is also a hardening over today, where
  sessions run as an **admin** account.
- **Residual risk (named, not eliminated):** prompt injection via PR diff or
  issue body from an allowlisted — or compromised-allowlisted — author. The
  allowlist shrinks the surface to trusted identities; gates 4 + 6 (no bot merge;
  human merge; code-owner on load-bearing paths) contain the blast radius. The
  engine's `engine:review` approval is an **internal quality gate, not an
  independent-party attestation**, and must not be described externally as
  independent review.

## Implementation phases (→ #1219)

- **P1 (no credentials needed, this PR):** gate 2 — review-side author allowlist
  in `selectReviewable`, enforced before worktree checkout. Latent until the
  review loop is enabled; safe by construction when it is.
- **P2:** per-session `GH_TOKEN` injection (impl token vs review token) + gate-5
  fail-loud validation (reviewer login ≠ implementer login; tokens present;
  allowlist non-empty).
- **P3:** human-surface detection in `review-pr` → advisory-only (no approve),
  escalate to human code owner.
- **P4 (operator, human action):** create `jinn-impl-bot` + `jinn-review-bot` as
  write-only non-code-owner collaborators, mint fine-grained PATs, add the impl
  bot to the allowlist, store tokens in the runner secret store. Then enable the
  loop.
- **Docs:** eng-loop launch recipe / README updated with the two-identity model.
