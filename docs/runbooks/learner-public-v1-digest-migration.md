# `learner-public.v1` digest migration — the `codeDigest` break

**Date:** 2026-08-03
**Issue:** [#2118](https://github.com/Jinn-Network/mono/issues/2118)
**Shape:** `refactor` (shipped-behavior change, DEEP review)
**Authority:**
[`docs/superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md`](../superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md) §3.2 + §4.1 (the ratified profile),
[`docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md`](../superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md) §4.2 (why the fork has to be healed, and that healing is forward-only)

> This note requires operator sign-off before the change merges. It changes
> every operator's forward `codeDigest`.

## What changes

Every `codeDigest` the learner harness produces from this version forward is a
different value than the same tree produced before it.

Before, the learner's impl-state was hashed with a caller-supplied ignore list
of exactly `['.git']`, and three surfaces disagreed about even that:

| Surface | Pre-migration exclusion set |
| --- | --- |
| Freeze fence + delivery envelope `codeDigest` | `.git` only |
| Daemon/operator status panel | nothing — `.git` included |
| `jinn` commit→digest revert helper | `.git` only (hardcoded, separately) |

From this version, all of them hash under one **named profile**,
`learner-public.v1`:

- **Algorithm (unchanged):** walk the tree, sha256 each regular file, sort
  entries by relative path, join `"<relpath>:<filehash>"` with LF, sha256 the
  result. 64 lowercase hex characters.
- **Excluded roots (canonical order):** `.git`, `operator-requests`, `secrets`,
  `transcripts`. Their contents contribute nothing to the digest at any depth.
- **Everything else is classified, and unclassified fails closed.** The
  spike's §4.1 table is exhaustive: `.archive/`, `agents/`, `configs/`,
  `hooks/`, `notes/`, `patterns/`, `plans/`, `runs/`, `skills/`,
  `strategies/`, `tests/`, `tools/`, `tunables/` may contribute as
  directories; `policy.json` may contribute as a file. Any other top-level
  path, and any symlink or special file anywhere in the tree, raises
  `HashProfileViolationError` instead of being silently skipped.

The three surfaces are now one scheme with three uses: freeze-fence identity,
on-chain `codeDigest`, and (per the policy-identity design) `jinn.harness-state.v1`
loadout pinning.

## Why

Two digests for one tree is not a cosmetic problem.

1. **The private-roots contradiction.** The learner deliberately writes
   operator-private material to `transcripts/` and `operator-requests/`, and
   credentials live under `secrets/`. Hashing them means any honest publication
   of a digest must publish secret bytes; stripping them at publish time means
   the re-hash can never match. The spike's resolution is to exclude them from
   the digest and the package together, so publishable bytes match the
   advertised digest.
2. **The local identity fork.** Without this, a single operator holds two
   digests for one directory — the fence's and the loadout's — which is the
   identity fork reproduced inside one machine, before any cross-operator
   distribution enters the picture.
3. **Silent skips were a safety hole.** The old walk skipped symlinks and
   special files quietly. Because a profile *ignores* `.git/`, a package could
   otherwise carry arbitrary bytes — including executable `.git/hooks/*` — and
   still digest-verify. Fail-closed classification is the precondition for
   treating a digest as an identity anyone else can trust.

## What does NOT change

- **Historical on-chain `codeDigest` values remain valid history.** Nothing is
  rewritten, invalidated, or re-anchored. Every pre-migration digest still
  correctly names the tree that produced it under the scheme in force at the
  time.
- **They are permanently non-joining.** A pre-migration digest and a
  post-migration digest of the same tree are different strings, and no
  procedure converts between them — the excluded bytes are gone from the
  input. Pre-migration digests are a closed legacy population: joinable to each
  other, never to anything produced from here on. Any query, corpus join, or
  revert lookup that spans the boundary returns nothing rather than something
  wrong.
- **The hash algorithm.** Same walk, same sha256, same combining rule. Only the
  input set changed.
- **Harnesses without a registered public profile.** `hermes-agent` keeps its
  own declared ignore list and its own digests; the learner profile is not
  inherited. A future harness profile is a new registered id.
- **On-chain contracts, agent identities, staking, and fleet state.** Untouched.

## Operator action required

**None in the ordinary case.** The change is automatic on upgrade. There is no
migration command, no re-bootstrap, no config edit, and no flag. Your next
delivery simply carries a digest computed under the new profile.

**One case needs a hand.** Because unclassified top-level paths now fail
closed, an operator whose learner impl-state directory contains a root outside
the profile's table gets a hard error — `HashProfileViolationError` naming the
offending path — instead of a quietly different digest. This is deliberate: a
digest that silently ignores unknown bytes is not an identity. Nothing the
shipped learner writes is unclassified, so this should only appear where a
human or a custom plug-in put something there by hand.

The likeliest real-world trigger is not learner state at all but incidental
tooling debris: a `.DS_Store` written by opening the directory in macOS Finder,
an editor's `.vscode/`, a stray `README.md` someone dropped in. Those are
unclassified top-level paths and they will stop a run.

If you hit it:

1. Read the path named in the error, under `~/.jinn-client/engine/impl-state/claude-code-learner/`
   (or `codex-code-learner/`).
2. Move it under a classified root if it is durable learner state (`notes/`,
   `skills/`, `strategies/`, …), or under `transcripts/` / `operator-requests/`
   if it is operator-private, or delete it if it is scratch.
3. Re-run. Do not attempt to widen the profile locally — the profile is the
   published identity scheme, and adding a root is a new reviewed profile
   version, never an in-place edit.

## Version boundary

- **Package:** `@jinn-network/client`
- **Last release under the old scheme:** `v0.2.2` (and every `0.2.2-canary.*`
  built before the commit that lands this change).
- **First release under `learner-public.v1`:** the first `canary` published from
  the `next` push that carries this commit, and the first named Monday cut at or
  after it. Fill the named version in below when the cut happens.
  - Named stable boundary: `v0.2.3` _(to be confirmed at the Monday cut)_.
- **Detection without guessing at versions:** a digest is post-migration if and
  only if it was produced by a client whose learner harness declares
  `freezeStateHashProfile: 'learner-public.v1'`. There is no marker inside the
  digest string itself — both schemes emit bare 64-hex — so joins across the
  boundary must be keyed on the producing client version, not on the digest's
  shape.

## Reference digest

The regression suite pins one fully-stated fixture tree so a second
implementation can check itself against this one without running it. Tree,
contents, and per-file hashes are in
`client/test/harnesses/hash-profile.test.ts`; the tree hashes under
`learner-public.v1` to:

```
90b25998166464fbb356ce7738149e7f173a78b6bff4d6896aaa96445e89abd8
```

## Deferred, and one gap this leaves open

`jinn checkpoint publish` / `install` ([#2119](https://github.com/Jinn-Network/mono/issues/2119))
and digest discovery ([#2120](https://github.com/Jinn-Network/mono/issues/2120))
are cross-operator distribution and are not in this change. This note covers the
local identity scheme only.

Named so it is not discovered later: the checkpoint publish path
(`client/src/cli/commands/checkpoint.ts`) still hashes through an injected
one-argument `hashImplStateDir(dirPath)` dependency and therefore does **not**
use the profile. That path is a stub today — it pins empty bytes to IPFS — and
#2119 owns making it real, at which point `harness.checkpoint.v2`'s required
`hashProfile` field forces the join. Until then, a checkpoint's `codeDigest`
is not comparable to a delivery's.
