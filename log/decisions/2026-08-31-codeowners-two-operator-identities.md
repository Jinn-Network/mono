# DR-2026-08-31 — Both operator credentials are code owners

- **Date:** 2026-08-31
- **Status:** Accepted — operator ruling in-session (Ritsu, 2026-08-31).
- **Owning docs:** [`.github/CODEOWNERS`](../../.github/CODEOWNERS); [`.github/architecture-owners`](../../.github/architecture-owners); [`docs/engineering/handbook.md`](../../docs/engineering/handbook.md) rule 4.
- **Amends:** [DR-2026-08-20](./2026-08-20-human-surface-enqueue-gate.md) — its GitHub encoding item 2 only. The human-surface path set, `required_approving_review_count: 0`, `require_code_owner_review: true`, the merge queue, required contexts, empty bypass, and `dismiss_stale_reviews_on_push` are all **unchanged**.

## What changed in the world

`oaksprout` is no longer an active contributor. They remain a repository admin and stay listed as a code owner, but no longer review in practice.

## The defect that exposed

DR-2026-08-20 encoded the gate as: *"human-surface PRs authored as `ritsuKai2000`, approved as `ritsukai` or `oaksprout`. If authored as `ritsukai`, need `oaksprout`."*

That last clause was the whole escape hatch, and an inactive `oaksprout` removes it. Observed on PR #3067 (a security fix adding four rows to `CLAUDE.md`, fully reviewed and CI-green): authored as `ritsukai`, so `ritsukai` could not approve it (GitHub forbids approving your own PR), and `ritsuKai2000` was not a code owner, so its approval did not satisfy the gate. GitHub refused the enqueue with *"Waiting on code owner review from oaksprout."* **Every engine PR authored as `ritsukai` that touches a canon path was unapprovable.**

## Decision

Add `@ritsuKai2000` to every entry in `.github/CODEOWNERS` and `.github/architecture-owners`. Every human-surface path is now owned by `@oaksprout @ritsukai @ritsuKai2000`.

This is **not** a weakening of the trust model, because that model never rested on two people. DR-2026-08-20 states it plainly: *"`ritsuKai2000` is the same person as `ritsukai`, split only so GitHub will record an approval"*, and *"which operator credential reviews a CODEOWNERS path is immaterial except for GitHub's author-cannot-approve rule — that is platform plumbing, not an independence claim."* The gate asks whether a trusted principal took responsibility. It still does. What changes is that the principal can now answer from whichever credential did not author.

`oaksprout` is deliberately retained as a third owner: their access is unchanged, and a genuinely independent approval remains possible if they return.

## The hazard this creates, and its containment

Autopilot runs under both operator credentials — it implements as `ritsukai` and reviews as `ritsuKai2000`. With both credentials now code owners, an engine review would satisfy GitHub's code-owner requirement on a canon path. GitHub cannot distinguish a human clicking Approve as `ritsuKai2000` from the engine publishing one.

Containment is Autopilot-side, in the enqueue gate added by autopilot#87: `repository.codeOwnerLogins` is the set of logins whose head-bound APPROVE lets the engine **self-enqueue** a codeowner-sensitive change. It is set to `["oaksprout"]` — the only code owner that is not an engine credential.

The consequence is the intended one:

| Actor | GitHub code-owner gate | Autopilot self-enqueue |
|---|---|---|
| Operator approving as either credential | satisfied | **refused** — operator enqueues by hand |
| Engine reviewing as `ritsuKai2000` | satisfied | **refused** |
| `oaksprout` approving | satisfied | permitted |

So a canon-touching change still cannot reach `next` unattended. The engine parks it (`Blocked on: Human`) and a human enqueues. The rule to preserve: **`codeOwnerLogins` may contain only principals that are not engine credentials.** Adding an operator credential to it would let the engine approve and enqueue its own canon edits in one unattended step.

## Non-goals

- No change to the human-surface path set, the queue, required contexts, bypass (still empty), or `main`'s Base ruleset.
- No change to `oaksprout`'s repository access.
- Autopilot remains out of this gate's enforcement (DR-2026-08-20), and still never bypasses or weakens branch protection.
