# DR-2026-09-02 — Close the F1 operator naming seam

- **Date:** 2026-09-02
- **Issue:** [#2682](https://github.com/Jinn-Network/mono/issues/2682)
- **Plan:** [`docs/superpowers/plans/2026-07-30-cutover-stage-5-rename-closure.md`](../../docs/superpowers/plans/2026-07-30-cutover-stage-5-rename-closure.md) (finding F1)
- **Design:** [`docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md`](../../docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md) §3

## Gating condition

This decision could not be taken before the stage-5 `client/` → `operator/` rename
landed, because until then every F1 item still described a live `client/` tree. The
rename landed on `next` (`e93b6487b` restoring the `packages/discovery/client` paths
the sweep had touched). The gate is satisfied; F1 is closed by this record.

## Decision

One disposition per F1 item. Three renamed and have already shipped; four are
permanent keeps and are recorded as such so no future sweep reopens them.

| F1 item | Disposition | State |
|---|---|---|
| `@jinn-network/client` (npm name) | **Rename** → `@jinn-network/operator` | shipped |
| `ghcr.io/jinn-network/client` (OCI image) | **Rename** → `ghcr.io/jinn-network/operator` | shipped |
| `~/.jinn-client` (operator state dir) | **Rename** → `~/.jinn-operator`, permanent read-fallback | shipped |
| `client-v*` (release tags) | **Permanent keep** | — |
| `bin: {"client": …}` | **Rename** → `jinn` / `operator` | shipped |
| `version --json` `client` key | **Permanent keep** at `schemaVersion: 1` | — |
| `packages/discovery/client` | **Permanent keep** (different tree) | — |

### Renamed — the migration each one took

**npm package.** `af8bd65de` renamed the published identity to
`@jinn-network/operator`; `a950075ca` dropped the transitional dual-publish of
`@jinn-network/client` once no external installer remained. No deprecate-and-alias
window is owed: the alias existed for the length of the transition and was retired
against a measured-empty consumer set, not on a timer.

**OCI image.** `docker.yml` builds a single `ghcr.io/<owner>/operator` repo
(`IMAGE_REPO`, line 53); `a950075ca` dropped the `…/client` dual tag. Railway
services follow the `deploy/` overlays, whose `BASE_IMAGE` already points at
`ghcr.io/jinn-network/operator`, so the cutover is the ordinary image-pin bump
those services take on every release — not a separate service migration.

**State directory.** `operator/src/state-dir.ts` resolves `~/.jinn-operator` for
fresh installs and reads a populated `~/.jinn-client` when the new tree is empty.
`JINN_STATE_DIR` overrides both. The fallback is **permanent, read-only, and has no
copy-forward step**: copying an operator's live keystores, SQLite database, and
earning state between directories on boot is a data-moving operation with a
failure mode (partial copy, two divergent trees) far worse than the cosmetic cost
of an existing install continuing to read its original directory. The code's
earlier promise of "a future run will copy this state" is withdrawn by this record
and removed from the log line, because a promise nothing owns is the same seam
F1 left in the first place.

**`bin`.** `a950075ca` dropped the `client` bin. The package ships `jinn` (the
documented entry point), `operator`, and `jinn-stop-hook`. The one-release alias
the acceptance criteria ask for was the dual-publish window itself, which has
closed.

### Permanent keeps — and why each stays

**`client-v*` release tags.** Real releases were cut under this pattern and their
tags are immutable. `docker.yml`, `npm-publish.yml`, and
`release-notes-scaffold.yml` must keep matching them to compute a previous tag and
to remain able to rebuild a historical release. `v<semver>` is the current scheme;
`client-v*` is retained purely as a read pattern over history and is never minted
for a new release.

**`version --json` `client` key.** The key is part of the `schemaVersion: 1`
payload contract and is asserted by `docker.yml`'s image smoke test. Renaming it is
a schema break, not a rename. It changes to `operator` if and when the payload
takes a `schemaVersion: 2` bump for an independent reason; it is not worth a bump
on its own.

**`packages/discovery/client`.** A different tree — the discovery client, not the
operator. It was out of F1's scope and stays out. This row exists so a future
naming sweep does not touch it by mistake.

## Consequences

- Composition design §3 keeps its retirement claim, footnoted with the three
  permanent keeps so it no longer over-asserts.
- The stage-5 plan's F1 finding points at this record instead of at nothing.
- No further F1 work is owed. A future contributor meeting `client-v*`, the
  `client` JSON key, or `packages/discovery/client` finds them recorded as
  intentional here.
