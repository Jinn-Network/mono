# Contributing to Jinn

Jinn is built in the open. This file is the entry point for contributors — humans and AI agents — opening PRs against `Jinn-Network/mono`.

The long form lives at [`docs/engineering/handbook.md`](docs/engineering/handbook.md). Read it before opening anything non-trivial.

## Quick start

```
git clone https://github.com/Jinn-Network/mono.git
cd mono/client
yarn install
yarn typecheck
yarn test
```

Per-package developer guides:
- [`operator/CONTRIBUTING.md`](operator/CONTRIBUTING.md) — Jinn client (TypeScript daemon).
- [`contracts/`](contracts/) — Solidity smart contracts (Hardhat).

## Licence and sign-off

The repository is licensed under **Apache License, Version 2.0** — see
[`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and the third-party inventory
in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

- **New source files** authored for this repository default to
  Apache-2.0. Add a header where the file format supports comments:
  ```
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Existing files** that already declare a per-file SPDX identifier
  (notably MIT) retain that identifier. Do not silently relicense
  existing files when editing them.
- **Vendored upstream code** retains its upstream licence. Add it to
  [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

Every commit must be **signed off** under the [Developer Certificate of
Origin](https://developercertificate.org). Add the trailer to every
commit:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it automatically. The DCO is a contributor
attestation that you have the right to submit the work under the
project's licence; it intentionally replaces a CLA so that no entity
sits between contributors and the licence.

The Jinn name, sigils, and wordmark are **not** licensed under
Apache-2.0 — see [`TRADEMARKS.md`](TRADEMARKS.md) before using them in
any context where confusion with the Jinn Network protocol is possible.

Community conduct expectations are in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Security issues are reported privately per [`SECURITY.md`](SECURITY.md).

## What to read before you open a PR

In rough order:

1. **[`docs/engineering/handbook.md`](docs/engineering/handbook.md)** — cadence, dist-tags, work-shape taxonomy, AI workflow rules, doc ladder.
2. **[`CLAUDE.md`](CLAUDE.md)** — agent-canonical project guide (architecture, conventions, design system pointers).
3. **[`BRAND.md`](BRAND.md)** — voice, headless-brand posture, content non-negotiables. Read before any user-facing copy.
4. Canonical docs as needed: [`SPEC.md`](SPEC.md), [`THESIS.md`](THESIS.md), [`GROWTH.md`](GROWTH.md), [`GLOSSARY.md`](GLOSSARY.md).

## Contributing shape

Jinn has no canonical implementation. The client and frontend in this repo are *one* implementation of the protocol. Contributing to Jinn can take any of several shapes — all welcomed:

- **Contributing to this implementation**: bug fixes, features, refactors, docs. See the work-shape table below.
- **Building an alternative implementation**: an alternative client, frontend, explorer, operator UI, or broadcast bot. Fork freely. Add your implementation to the known-instances list in the README when it's ready (open a PR with the entry).
- **Running infrastructure**: hosting a frontend mirror, running a community chat room, running a broadcast bot instance under your own account. Add it to the README's community-run surfaces list.
- **Design input**: open a [Discussion](https://github.com/Jinn-Network/mono/discussions) on protocol design, governance scope, documentation, or any canonical artifact. We actively want this input. No formal RFC process — Discussions and PRs are the input mechanism.
- **Articulating an alternative narrative**: [`BRAND.md`](BRAND.md), [`THESIS.md`](THESIS.md), [`GROWTH.md`](GROWTH.md) are *the current articulating contributor entity's* narrative, not the protocol's. If you disagree, articulate your own — the protocol doesn't privilege ours.

The only thing we ask: don't structurally privilege your contribution above others. The posture is plurality; contributions that try to install themselves as canonical defeat it. See [Discussion #316](https://github.com/Jinn-Network/mono/discussions/316) for the full statement of this posture.

## How work is shaped

Jinn engineering recognises seven shapes of work plus one emergency sub-flow, keyed to Conventional Commits prefixes:

| Shape | When | PR title prefix |
|---|---|---|
| `fix` | Bug fix | `fix:` or `fix(scope):` |
| `feat` | Feature | `feat:` or `feat(scope):` |
| `refactor` | Architecture / migration | `refactor:` |
| `spike` | Research / exploration | `spike:` (does not merge to main) |
| `chore` | Deps, CI, dev tooling | `chore:` or `chore(deps):` |
| `docs` | Documentation | `docs:` |
| `test` | Test-only | `test:` |
| `fix(incident)` | Hotfix under pressure | `fix(incident):` (relaxed review, postmortem follow-up required) |

Each shape has a distinct SOP — different skill chain, test discipline, design ceremony, stacking policy. The full table with v0 flows lives in [`docs/engineering/handbook.md`](docs/engineering/handbook.md#the-shapes-of-work).

If a PR doesn't fit one of these shapes, it's mis-scoped. Split it.

## PR expectations

- **Title**: `<shape>: <one-line summary>` per Conventional Commits (e.g. `fix: SWE typed payload fallback validation`, `feat(uy6v): live verdict-success on Base Sepolia`).
- **Body**: problem-not-solution framing (what's wrong / what gap / what need triggered this), test plan, agent identity if AI-authored.
- **Linked bd issue**: `Closes jinn-mono-<id>` in the body so merge auto-closes the mirror.
- **Co-Authored-By trailer** for AI commits, e.g.:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  Co-Authored-By: OpenAI Codex <noreply@openai.com>
  ```
- **Test discipline matches the shape** — see handbook §The shapes of work.
- **Stacked PRs** encouraged for features > 300 LOC; aim for < 200 LOC per layer, "one logical thing per layer." `gh-stack` is the canonical tool; Graphite (`gt`) is allowed.

## Review policy

**Reviewed, then queued** (handbook rule 4, rewritten by [DR-2026-08-18-b](log/decisions/2026-08-18-merge-queue-on-next.md), amended by [DR-2026-08-20](log/decisions/2026-08-20-human-surface-enqueue-gate.md)): review is a pipeline stage, not an identity ritual. The merge queue plus required CI is the quality gate. Generic approving-review count on `next` is 0 — write users enqueue with Merge when ready when checks are green. CODEOWNER Approve is required only on the human-surface set in [`.github/CODEOWNERS`](.github/CODEOWNERS). Self-enqueue is permitted once required checks are green (and CODEOWNER Approve exists when the diff hits the set), and the merge queue on `next` is the only merger of ordinary PRs. Exceptions: `fix(incident)` reviewer relaxation with documented justification; mechanical conflict resolution via the children ladder.

Canonical-doc changes (`SPEC.md`, `BRAND.md`, `THESIS.md`, `GROWTH.md`, `GLOSSARY.md`) require:
- A linked GitHub Discussion proposing the change.
- CODEOWNERS approval (see [`.github/CODEOWNERS`](.github/CODEOWNERS)).
- Downstream-doc review per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

`CLAUDE.md` and `README.md` are root-level capitalised files but are treated as **meta** per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md): they describe the repo and the agent contract, and are **exempt from the spec-proposal / linked-Discussion requirement** — still CODEOWNERS-reviewed, and still subject to downstream-doc review.

## Prediction-freeze guardrail

**Prediction SolverNet is frozen** as of 2026-05-11 per [DR-2026-05-11-a](log/decisions/2026-05-11-freeze-prediction-solvernet.md). Reviewers reject Prediction-only PRs by default. Bug fixes against existing Prediction surfaces require explicit Captain approval citing why the fix is load-bearing for SWE-rebench v2 or shared infrastructure.

If your PR touches Prediction-only surfaces (Polymarket task generator, `prediction.v0` / `prediction.v1` contracts, prediction-flavored plugins/harness pieces), check the corresponding box in the PR template and cite Captain approval.

## AI workflow rules (summary)

Full text in [`docs/engineering/handbook.md`](docs/engineering/handbook.md#ai-workflow-rules). The ten ratified rules (rule 5 deferred):

1. Worktree-for-multi-agent — multi-agent or speculative subagent work uses a separate git worktree (current convention: `git worktree add ../jinn-mono_worktrees/<name>`).
2. Issues frame problems, not solutions — GitHub Issue body = context + impact + acceptance criteria; solutions live in design sessions or implementation plans.
3. GitHub Issues are the single SoR for engineering work — per DR-2026-05-18, `bd` retires; all new engineering work originates as a GitHub Issue on `Jinn-Network/mono`.
4. Reviewed, then queued — queue + required CI is the quality gate; generic approving-review count on `next` is 0; CODEOWNER Approve is required only on the human-surface set in `.github/CODEOWNERS`; self-enqueue is permitted once required checks are green; the merge queue on `next` is the only merger of ordinary PRs. Exceptions: `fix(incident)` reviewer relaxation with documented justification; mechanical conflict resolution via the children ladder.
5. _(Deferred — see [`jinn-mono-8qbc`](https://github.com/Jinn-Network/mono/issues?q=jinn-mono-8qbc))_
6. Integration tests > mocks for migration / contract surfaces.
7. TDD for new features, regression test for fixes.
8. Auto-canary on every push to `next`; Monday-only named stable cut promotes `main`.
9. `canary` for rolling patches, `latest` for Monday named.
10. PRs target `next`, not `main` — only exception is `fix(incident)` hotfixes (target `main` directly, mandatory back-merge per [`docs/runbooks/hotfix.md`](docs/runbooks/hotfix.md)); branch protection on `main` enforces this (issue #589).

## Issue tracker

The internal SoR is **bd (beads)** — see [`CLAUDE.md`](CLAUDE.md) §Beads Issue Tracker for the workflow. External contributors interact via:

- **Public GitHub Issues** — the sprint-scoped subset of bd, mirrored by the Friday triage automation. The Issue body ends with `Internal tracking: jinn-mono-<bd-id>`.
- **GitHub Project (v2) "Jinn engineering"** — the public sprint board.
- **GitHub Discussions** — RFCs / Q&A / governance prep.

If you can't find a public Issue for what you want to work on, open a Discussion (RFC / question) or comment on the closest-matching Issue.

## Building in public

See [`docs/engineering/handbook.md`](docs/engineering/handbook.md#building-in-public--substrate). The substrate is intentional — GitHub Projects, Issues, Releases, repo-as-docs, Discussions. Every shipped artifact emits a knowledge artifact (Release notes / CHANGELOG / DR / spec / runbook).
