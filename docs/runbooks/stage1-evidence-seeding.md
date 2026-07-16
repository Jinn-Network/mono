# Stage 1 evidence seeding

How to turn a completed agentic session into a published evidence-episode
seed, and how to publish the curated Stage 1 fixture set
(`client/packages/harness-layer/fixtures/stage1-seeds/`) to the testnet
corpus so Stage 1's evidence-first retrieval
(`docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md` §3-§4)
has canonical prior-work evidence to serve. Issue #1771.

The corpus otherwise contains almost no evidence records — only skills.sh
skill seeds — so retrieval has nothing honest to return for the Stage 1
walkthrough or for any real operator session until this lane has run at
least once.

## Why episodes, not raw traces

A seed-episode JSON file is a *transformed*, human-reviewed artifact, not a
raw capture. It is published through the exact same `capture() -> publish()`
path a real contribution uses (strict trace scrub, `provenance: 'imported'`,
excluded from the demand signal and emissions eligibility), so a seeded
evidence record is indistinguishable on the wire from an organically
captured one — see `client/packages/harness-layer/src/seed-import/episode-execute.ts`.

## 1. Record → transform → author

1. **Record.** Run a real agentic session that performs a genuine, small,
   verifiable task — ideally re-performing an already-merged fix at its
   pre-fix commit, so the "before" state is real and reproducible (see
   `fixtures/stage1-seeds/source-dashboard-flake.episode.json` for the
   pattern: `git show <fix-sha>~1:<file>` to get the pre-fix content, run the
   failing command for real, apply the real fix, rerun).
2. **Normalize paths.** Every path in every step must be repo-relative
   (`client/src/...`, not `/Users/you/jinn-mono/client/src/...`). Strip
   machine/user identifiers from command output (hostnames, local
   usernames, absolute paths in stack traces).
3. **Scrub.** Read the episode once, end to end, for anything that
   shouldn't leave the machine — tokens, keys, private URLs. The strict trace
   scrub (`buildScrubPipeline()`: structured PII plus entropy-backed secret
   detection) runs automatically at `seed execute` time as a second,
   mandatory net over every episode-originated string, including the ID,
   tags, summary, steps, outcome, synthesis, and attribution. Authored content
   should already be clean; the scrub is a backstop, not a substitute for
   review.
4. **Author `synthesis` and `tags`.** `synthesis` is a 3-6 sentence,
   task-linked "how it was solved" — write it yourself; it is never
   generated at retrieval time. `tags` should name the subsystem vocabulary
   a related task would search on (see the source fixture's
   `mono, dashboard, vitest, version-status, async, flake`).
5. **Shape the file** against the seed-episode contract
   (`client/packages/harness-layer/src/seed-import/episode-fetch.ts`,
   `SeedEpisodeSchema`):

   ```json
   {
     "id": "kebab-case-stable-identity",
     "repo": "owner/repo",
     "baseCommit": "<full 40-char sha, when re-performing a real fix>",
     "taskSummary": "One line, ≤500 chars",
     "tags": ["subsystem", "vocabulary", "..."],
     "steps": [
       { "label": "failure", "title": "...", "text": "..." },
       { "label": "note",    "title": "...", "text": "..." },
       { "label": "fix",     "title": "...", "text": "..." },
       { "label": "diff",    "title": "...", "text": "..." },
       { "label": "command", "title": "...", "text": "..." }
     ],
     "outcome": { "status": "completed", "verifiabilityTier": "tests-passed" },
     "synthesis": "3-6 sentences.",
     "attribution": { "origin": "operator-recorded-session", "sourceUrl": "https://..." }
   }
   ```

   `steps[].label` is one of `failure | fix | command | diff | note` — the
   same vocabulary the retrieval-side knowledge-packet projection (rescope
   plan §3.2, `projectKnowledgePacket`) selects excerpts by. A source episode
   (one meant to actually help a related task) should carry at least one
   `failure` and its `fix`; distractor/negative fixtures are freeform.
   File name convention: `<id>.episode.json`.

   `attribution.origin` states how the episode entered the corpus, honestly.
   Vocabulary in use (freeform by schema — document any new value here):
   - `operator-recorded-session` — transformed from a real recorded session;
     carry `sourceUrl` when it re-performs a merged fix.
   - `synthetic-selection-distractor` — hand-authored negative/contrast
     material (e.g. the sympy distractor). Pair it with
     `verifiabilityTier: "user-accepted"`; it must not claim the
     recorded-session evidentiary standard.

6. **Validate locally** before touching the network:

   ```bash
   cd client
   yarn vitest run packages/harness-layer/test/stage1-seeds-fixtures.test.ts
   ```

   That test is the curated fixture set's own lint: schema-valid, no absolute
   paths/usernames, deterministically formatted. It reads
   `fixtures/stage1-seeds/` directly; to lint a new episode with this test,
   add it there and extend the expected-file list before running the command.

## 2. Plan (zero writes)

```bash
cd client
yarn jinn-layer seed plan --episodes-dir packages/harness-layer/fixtures/stage1-seeds \
  --out /tmp/stage1-episode-report.json
```

`plan` performs **no writes** — it lists every `*.episode.json` file found,
validates each against the schema, and flags a duplicate `id` within the
batch as `skip` (first occurrence wins). Review the printed table (or the
report file) before executing; nothing publishes that wasn't on this list.

Skill-shaped fixtures (`distractor-skill-tdd.json`,
`distractor-skill-tdd-dup.json`) are **not** picked up by `--episodes-dir` —
that flag only reads `*.episode.json` files. They are consumed only by the
fixture-lint test and, later, by the R5 acceptance gate's local corpus
fixture server (boundary assertions: skills are excluded from pickup, and
duplicate content collapses at the consumer). They are **not** publishable
via `seed plan/execute --source <list-file>` either: that source fetches
live from the GitHub API, and these fixtures' placeholder repos
(`distractor/skill-tdd*`) do not exist — a fetch would 404. Nothing
publishes them to the shared corpus.

## 3. Execute (publishes to testnet)

Publishing needs a live operator identity. Derive one from your local
`~/.jinn-client` keystore and export it for this shell:

```bash
eval "$(yarn --silent jinn-layer derive-env)"
```

Then run the approved report:

```bash
yarn jinn-layer seed execute /tmp/stage1-episode-report.json \
  --episodes-dir packages/harness-layer/fixtures/stage1-seeds
```

Each `import`-verdict row runs through `capture()` (strict trace scrub) then
`publish()` (the same anchor path a real contribution uses) and prints the
published `envelopeRef` (the corpus ref) plus the anchor tx. `--json`
emits the machine-readable `EpisodeImportResult` instead of the table.

## 4. Verify retrievability

```bash
yarn jinn-layer corpus search "dashboard" --limit 5
```

The seeded record should appear in the results (ref, `kind: 'trace'`, tags
including your episode's tags). Fetch it directly to confirm the full
content round-tripped:

```bash
yarn jinn-layer corpus get <ref> --json
```

Confirm `provenance: 'imported'`, the `seed:step:*` steps carrying
`seed.step.label`/`seed.step.title`/`seed.step.text`, and the final
`seed:synthesis` step carrying `seed.synthesis` + `seed.attribution`.

## 5. Idempotency and `supersedes`

Re-running `seed execute` over the **same directory and report** is safe to
repeat:

- **Unchanged content** — nothing publishes. The row prints as `skipped`
  with the reason `unchanged since <prior envelopeRef>`. No new IPFS
  upload, no new anchor tx.
- **Changed content after planning** — execution refuses the row because its
  canonical digest no longer matches the approved report. Re-run `seed plan`,
  review the new digest/content, and approve that new report.
- **Changed, newly approved content** (you edited the episode's steps,
  synthesis, tags, outcome, or attribution and approved a fresh report) — a
  fresh record publishes, and its
  `seed.attribution.supersedes` step attribute is set to the prior
  `envelopeRef`. The old record is not deleted or hidden by this alone
  (that collapse is a consumer-side / corpus-hygiene concern — rescope plan
  §3.3, #1776); `supersedes` is the durable lineage pointer a later reader
  can follow.

Idempotency state lives at
`~/.jinn-client/harness-layer/seed-import-state.json` (one JSON map,
`seed identity -> {contentHash, envelopeRef, publishedAt}`; path overridable
via `JINN_LAYER_SEED_STATE_PATH`), shared with the existing skill-seed lane.
Deleting that file resets idempotency — the next `seed execute` treats every
row as new. A corrupt/unreadable state file fails closed before publication,
preserving the last known lineage instead of overwriting it as empty. State
writes use a same-directory temp file plus atomic rename.

If publication succeeds but state persistence fails, the result still prints
the published `envelopeRef` with a recovery warning, stops the batch, and
exits nonzero. If the on-chain anchor succeeds but the local contribution
ledger append fails, the result likewise preserves the ref and anchor tx,
persists seed idempotency state from that known result, reports a ledger
recovery warning, stops the batch, and exits nonzero.

Any other publish error is treated as ambiguous: the batch stops immediately
and reports `publication outcome unknown; do not auto-retry`. Do not assume a
transport error means the anchor failed; reconcile the envelope/transaction
externally before deciding whether a retry is safe.

Stop automation on any recovery warning, preserve the printed ref, and repair
or reconcile local state before retrying. This state is **local to the machine
that ran `seed execute`**; it is not itself published, and it does not query
the corpus — it only answers "did *I* already publish this exact seed identity,
unchanged?".

## Fixture-file reference

| File | Kind | Role |
|---|---|---|
| `source-dashboard-flake.episode.json` | evidence | The positive match: re-performs the real dashboard `update_available` test flake fix (`163e070d`) at its pre-fix commit. |
| `distractor-operator-claims.episode.json` | evidence | Same repo, different module (`d682f811`) — proves selection is finer than repository match. |
| `distractor-sympy-printing.episode.json` | evidence | Different domain entirely (sympy LaTeX printing) — proves domain relevance. Explicitly synthetic (`origin: synthetic-selection-distractor`, `verifiabilityTier: user-accepted`, no source commit), unlike the two commit-verified episodes above. |
| `distractor-skill-tdd.json` | skill | Skill-shaped seed (existing lane's format) — proves skills are excluded from evidence pickup. |
| `distractor-skill-tdd-dup.json` | skill | Same `skillMd` content as the above under a distinct identity — proves content-key dedup at the consumer. |
