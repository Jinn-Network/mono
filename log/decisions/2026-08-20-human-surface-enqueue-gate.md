# DR-2026-08-20 — CODEOWNER Approve only on the human-surface set

- **Date:** 2026-08-20
- **Status:** Accepted — operator ruling in-session (Ritsu, 2026-08-20). Enacted in the same PR that lands this DR. The live `next` ruleset flip (`required_approving_review_count: 0`) is a post-merge admin `APPLY=1` of `.github/scripts/enable-next-merge-queue.sh`; do not APPLY before this PR lands, or the architecture audit against the pre-merge script will red.
- **Owning docs:** [`docs/engineering/handbook.md`](../../docs/engineering/handbook.md) rule 4; [`.github/CODEOWNERS`](../../.github/CODEOWNERS); [`.github/architecture-owners`](../../.github/architecture-owners).
- **Amends:** [DR-2026-08-18-b](./2026-08-18-merge-queue-on-next.md) D2/D4 — empty bypass and queue universality **unchanged**; drop "every PR needs 1 generic approving review" on `next`.
- **Supersedes in part:** [DR-2026-06-03](./2026-06-03-human-surface-review-gate.md) — its GitHub path list for enqueue. Render dirs of live frontends are out of the GitHub gate. Product-canon specs, canon, press/site copy, the root visual contract, the handbook, CODEOWNERS itself, and `log/decisions/` stay in. The CODEOWNERS + `require_code_owner_review` mechanism is retained on that shrunk set. PAC last-match ownership moves to `.github/architecture-owners` so shrinking GitHub CODEOWNERS does not red `platform-architecture-control`.

## Trust model

Write on this public repo is three GitHub admins: `ritsukai`, `ritsuKai2000`, and `oaksprout`. `ritsuKai2000` is the same person as `ritsukai`, split only so GitHub will record an approval. Trusted principals are `ritsukai` and `oaksprout`; their AIs are trusted because they run under those credentials.

Almost all code is AI-written and AI-reviewed. The merge queue plus required CI is the **quality** gate. Review-before-enqueue is only "did a trusted principal take responsibility." A generic Approve dance on ordinary operator PRs adds no extra trust.

Anyone can open a fork PR; they cannot push `next` or enqueue. Dependabot must not auto-merge. A trusted admin clicking Merge when ready is the untrusted-author gate. GitHub cannot stop an agent that enqueues every green PR — that is agent policy, not a ruleset. Autopilot is out of this gate's enforcement.

Do not put people on the queue ruleset bypass list (D2). Do not skip CI. Do not change `main`'s Base ruleset (keep ≥1 approval + CODEOWNERS for hotfixes).

## GitHub encoding

1. **Default:** `required_approving_review_count: 0` on `next`. Write users enqueue with Merge when ready. No generic Approve.
2. **Exception:** `require_code_owner_review: true` on the shrunk `.github/CODEOWNERS`. Author still cannot be the CODEOWNER — human-surface PRs authored as `ritsuKai2000`, approved as `ritsukai` or `oaksprout`. If authored as `ritsukai`, need `oaksprout`.
3. Keep merge queue, required contexts, empty bypass, `dismiss_stale_reviews_on_push`.
4. PAC ownership inventory is `.github/architecture-owners` (same root-anchored last-match syntax). `.github/scripts/architecture-control.mjs` reads that file.

GitHub cannot do "CODEOWNER-authored PRs skip review; everyone else needs Approve." Bypass is actor-based and fights the queue. The approximation is: 0 generic reviews + small CODEOWNERS + tight write + `allow_auto_merge` false.

## GitHub CODEOWNERS (human-surface only)

**In:**

- Canon: `/PRINCIPLES.md` `/SPEC.md` `/THESIS.md` `/BRAND.md` `/GROWTH.md` `/GLOSSARY.md` `/CLAUDE.md` `/README.md`
- The gate itself: `/.github/CODEOWNERS` `/docs/engineering/handbook.md` `/log/decisions/`
- External speech: `/docs/press/` `/apps/website/content/`
- Product-canon specs: `/apps/operator-console/OPERATOR-APP-SPEC.md` `/packages/indexer/explorer/EXPLORER-APP-SPEC.md` `/apps/website/WEBSITE-APP-SPEC.md`
- Root visual contract: `/DESIGN.md` `/DESIGN.json`

**Out (velocity):** console `app/` + `components/`; explorer `views/` + `components/` + `styles/` + `App.tsx`; website `app/` + `components/` + `styles/`. Also out of the GitHub gate: `spec/`, `docs/superpowers/`, runbooks, `operator/`, `packages/` (except the explorer spec path above), workflows, contracts. Those remain in the PAC inventory.

Known leak (accepted, same as DR-2026-06-03): copy can move through a logic dir and miss CODEOWNERS. `operator/OPERATOR-APP-SPEC.md` is a leftover path and is not in this GitHub set; the live spec is `apps/operator-console/OPERATOR-APP-SPEC.md`.

## Post-merge APPLY

After this PR lands on `next`, a repo admin (`ritsuKai2000`) re-runs:

```bash
APPLY=1 QUEUE_BOT_ACTOR_ID=262318 QUEUE_BOT_ACTOR_TYPE=Integration \
  .github/scripts/enable-next-merge-queue.sh
```

Then local `.github/scripts/branch-protection-audit.mjs` must be green. Until APPLY, live `next` still requires 1 generic approval, so this PR itself still needs that Approve to enqueue.

## Does not change

- D2 empty bypass on `next`
- Queue configuration (MERGE / ALLGREEN / merge 1 / build 2 / 180m)
- `main` Base ruleset (1 approval + CODEOWNERS + admin bypass)
- Autopilot enqueue policy (out of scope)
