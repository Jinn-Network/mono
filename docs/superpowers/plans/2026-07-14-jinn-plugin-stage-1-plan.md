# Jinn Plugin Stage 1 — Completion Plan

- **Updated:** 2026-07-15
- **Product:** the Jinn Plugin; Hermes is the first host adapter, not the product boundary
- **Parent:** #1654
- **Status:** implementation in progress; only the live walkthrough remains after the automated gate

## 1. Outcome

Stage 1 proves one complete product lifecycle in an unmodified Hermes installation:

1. Install and enable the standalone Jinn Plugin.
2. Start ordinary OSS agentic work.
3. Receive visibly marked shared-knowledge suggestions.
4. Capture the complete ordered trajectory locally as `EpisodeV1`.
5. Tee the same session into the existing local distillation workflow.
6. Record a reusable public-task candidate without exposing raw trajectory or gold.
7. Inspect current-session, history, and contribution state.
8. Publish only when sharing is enabled, the one-time preview has been acknowledged, and the
   repository is verified public immediately before outbound I/O.

The knowledge artifact does not change between product stages. The complete episode is the raw
material for retrieval, local skill distillation, task minting and validation, later policy
learning, and eventual model adaptation. Those stages change how the knowledge is used, not the
form in which the underlying evidence is captured.

## 2. Delivery sequence

All implementation issues remain in the GitHub Project's `Human` state while this work is
coordinated, so Autopilot cannot claim them.

| Order | Issue | Completion condition |
|---|---|---|
| 0 | PR #1747 / #1664 | Merge the contribution renderer as a projection foundation with `Refs #1664`; leave #1664 open. |
| 1 | #1661 | Stable process contract, complete session-end delegation, canonical episode ownership, and real session-to-candidate bridge. |
| 2 | #1664 | Connect the renderer to real contribution records and state transitions. |
| 3 | #1663 | Derived `jinn-layer history --json` and `/jinn history` over real episode, contribution, and local-skill state. |
| 4 | #1665 | Point-of-use markers, `/jinn session`, and complete end-of-session product summary. |
| 5 | #1666 | Blocking automated acceptance gate against pinned stock Hermes. |
| Final | #1654 | One remaining checklist item: live walkthrough and recorded `proceed`, `iterate`, or `stop` decision. |

Branches are cut sequentially from current `origin/next`, because the work converges on the same
plugin adapter and state contracts:

- `codex/1661-stage1-session-contribution`
- `codex/1663-stage1-history`
- `codex/1665-stage1-legibility`
- `codex/1666-stage1-acceptance`

Every PR targets `next`, is independently reviewed, green, and merged before the next dependent
branch is cut. #1732 is a post-Stage-1 refactor: pickup stays implemented in Python for Stage 1.

## 3. Product contracts

### Canonical evidence and session completion

- `EpisodeV1` is the canonical reusable knowledge artifact. Its complete ordered trajectory is
  first-class rather than hidden in snapshots.
- Optional persisted `activity` records surfaced/fetched knowledge and installed skills.
- Optional persisted `eligibility` records the session-end verdict used by history.
- `JinnPlugin.completeSession(...)` accepts an already-captured `EpisodeV1`, activity,
  eligibility inputs, and an optional `ContributionCandidateV1`.
- `PluginSession.end()` uses the same completion path, so embedded and process hosts cannot
  diverge.
- Process exit never reconstructs an episode by replaying events. It preserves the host's
  episode ID, timestamps, trajectory, and provenance.

### Stable `jinn-layer` process contract

- `jinn-layer contract --json` publishes contract version `1`.
- Versioned stdin/stdout commands are `session pickup`, `session end`, and `history --json`.
- Product failures return structured `ok`, `degraded`, or `unavailable` envelopes with exit 0.
  Malformed or version-invalid input is the only command-level error.
- Python memoizes the handshake. A missing or incompatible binary disables only session-end
  delegation: Python pickup, local capture, and local distillation continue with a concise
  degraded-state explanation.
- On successful delegation, core owns the canonical episode write. On failure, Python writes
  the same episode once locally. Neither path loses or duplicates the episode.

### Contribution candidate and state

`ContributionCandidateV1` is host-neutral and contains the local source episode ID, repository
slug, base commit, accepted diff, structured tests when available, intermediate failure diffs,
skill events, the single sharing preference, and a deterministic creation timestamp.

The shared contribution store separates two state axes:

- local: `recorded`, `minted`, or `rejected`;
- publication: `disabled`, `preview-required`, `queued`, `published`, or `vetoed`.

It is shared by `jinn-layer` and the task-creator daemon, cacheless, locked, and updated with
atomic read-modify-write operations. V1 migration is conservative: it preserves a backup,
records unprocessed legacy candidates locally, marks processed records legacy/unavailable, and
never grants publication authorization.

The lifecycle is:

1. Session end records the candidate locally regardless of the sharing preference.
2. The task creator may mint locally regardless of the sharing preference.
3. Sharing off prevents every outbound operation.
4. The first sharing-enabled candidate waits for one sanitized preview acknowledgement.
5. Later eligible candidates may queue silently.
6. The sidecar rechecks repository visibility immediately before publication.
7. Only the public task artifact leaves the machine. Raw trajectory, local IDs, accepted
   diff/gold, private material, and holdouts remain local.
8. Veto is durable until publication. Published immutable tasks are never represented as
   withdrawn.

Legacy raw-trace pending envelopes remain local and are never auto-published by Stage 1 code.

### Host product experience

- Session start records repository root, origin, and base commit.
- Session end constructs a read-only diff covering committed-since-start, staged, unstaged, and
  untracked files without changing the worktree or index.
- Integration stays inside the standalone Jinn Plugin and generic Hermes hooks. Hermes core and
  the model toolset are unchanged.
- Every surfaced suggestion is marked, not only auto-adopted knowledge.
- `/jinn session` shows surfaced, fetched, installed, capture, eligibility, and contribution
  state.
- `/jinn history` is derived from canonical episodes, contribution records, and existing local
  skill provenance. It owns no duplicate history cache and reports degraded/unavailable facts
  honestly.
- Session end always reports what Jinn surfaced/used, capture status, local-learning state,
  contribution status, and an explicit nothing-relevant-found state.
- Disabled means no Jinn output, subprocesses, or state writes.

## 4. Automated acceptance

Required coverage spans:

- standalone plugin build, typecheck, unit tests, boundary tests, strict schema compatibility,
  and degraded ports;
- contract CLI, episode persistence, shared-store locking/migration, task mint/publication
  transitions, veto, and outbound privacy;
- all Python lifecycle hooks, bridge mismatch/missing-binary fallback, session state, markers,
  summaries, commands, and disabled behavior;
- cross-language identity preservation, shared-store interoperability, daemon-to-history state
  visibility, and capture survival on every process failure;
- sharing off, pre-preview, acknowledged preview, private repository, veto, and legacy pending
  privacy scenarios;
- relevant result, no result, local skill provenance, every contribution state, and missing
  sidecar product scenarios.

The cold-stock gate pins upstream Hermes to
`9df5f879b4a5925c0f8f947e7e16ed8e845932c3`, installs the built pip package into that unmodified
checkout, and uses the real built `jinn-layer`. Only external corpus, chain, storage, and
publication services are stubbed. It asserts required hook names and behavior rather than an
exact hook count, and exercises install, pickup, capture, local-learning tee, first preview,
mint/publication, `/jinn session`, and `/jinn history`. This job is blocking for #1666.

## 5. Manual gate

After all implementation issues close, #1654 retains exactly one unfinished item:

- Run the plugin interactively against real public OSS work and configured Jinn services.
- Confirm the experience is understandable without inspecting files or logs.
- Record `proceed`, `iterate`, or `stop` with walkthrough evidence.

No implementation issue remains open solely to represent this walkthrough.
