# DR-2026-08-18-b — Official suite protocol (Terminal-Bench 3.0)

- **Date:** 2026-08-18
- **Status:** **Accepted 2026-08-18.** Ratified by operator instruction to
  implement the Terminal-Bench 3.0 official-suite train (issue
  [#2769](https://github.com/Jinn-Network/mono/issues/2769)).
- **Owning docs:** the publication interoperability profile; Colophon
  self-serve; the benchmark-product GTM plan (copy); product-design pointer
  addendum.
- **Amends (at ratification, pointers only):**
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  (TB 3.0 as a second named Harbor-family protocol);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3;
  [`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md)
  (pointer addendum only).
- **Does not rewrite:** [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md)
  (Terminal-Bench 2.1 remains its own protocol).
- **Does not amend:** `GROWTH.md`.

## Context

Colophon already locks Terminal-Bench 2.1 as a named official protocol
(Harbor Hub dataset `terminal-bench/terminal-bench-2-1`, content-hash pin,
one Job per arm, k=5, ATIF, Hub export as a derived artifact). Wearing
**Terminal-Bench 3.0** on that 2.1 lock, on TB 2.0 one-task, on SWE-bench
Verified, on Inspect, or on any Harbor job resolved as `@latest` is the
same overclaim as overlay-on-Inspect: legitimacy for an official suite is
that **their** method ran.

Maintainer oracle on 2026-08-18 (`harbor-framework/terminal-bench` README):

`harbor run -d terminal-bench/terminal-bench@latest -k 5 --agent … --model … --env …`

Harbor Hub dataset id is still `terminal-bench/terminal-bench`. Hub tag
`3.0.0` and Hub `@latest` resolved to the same content hash on that date.
Colophon honesty is the sealed hash, not the word latest. Frontier-Bench
(`frontier-bench/frontier-bench`) is a different protocol if/when it ships.

## Decisions

1. **Named protocol is `terminal-bench-3.0`.** Dataset id
   `terminal-bench/terminal-bench` (not `terminal-bench-2-1`). Revision is
   the Hub `dataset_version_content_hash` sealed at implementation:
   `sha256:a32a61879ea94eb9dc16fa1fbeb398759f0c07ca633d9d1f6aec760207036da3`,
   Hub version string `3.0.0`. Select refuses `@latest`, `latest`, unpinned
   names, and any hash that does not match the sealed registry snapshot.
   A later Hub version is a new pin (Issue + constant bump), never a silent
   select. Do not freeze GitHub tag `v3.0.0` as “the” living suite.

2. **Cousins cannot wear the name.** TB 2.0 one-task, TB 2.1 official,
   SWE-bench Verified, Inspect, any Harbor job on `@latest`, and
   Frontier-Bench if the dataset id differs cannot claim
   `terminal-bench-3.0`. 2.1 cannot emit 3.0; 3.0 cannot emit 2.1.

3. **Grain is reused, not rebuilt.** One Harbor Job per arm, k=5 planned
   replicates per selected task (TEP `attempts.maxTotal = 1` each),
   `retry.max_retries: 3` as Colophon replacement dispatches, ATIF required
   for Hub packaging, same forbidden env overrides as 2.1. Harbor remains
   `0.21.x`; reuse `officialHarborExecutionConformance`. Do not widen 2.1’s
   0.21 check. Named slices are lexicographic first 1 / first 10 / all of
   **this pin’s** `task_ids`, plus `custom`. Those names are not 2.1 task
   names.

4. **Comparability stays two-axis.** Report v2 gains no new required
   fields. Quote bits are `executionConformance`, `coverage`, and
   `leaderboardSubmitReady` (never true at quote). Limitation copy for this
   protocol must say Terminal-Bench 3.0 and this dataset id. 2.1 strings
   stay 2.1-only.

5. **Hub export is a derived artifact.** Claim of record remains the
   Colophon bundle. Ready vs inspection vs refuse stays the same shape as
   2.1. 3.0 instructions use current maintainer Hub flow (`harbor upload`,
   optionally `--upload`). Do **not** copy 2.1’s `uv run lb submit` or
   “community submissions are currently closed” sentence onto 3.0.

6. **CI never downloads the full 3.0 dataset.** Operator `one_task`
   qualify is fail-closed behind `COLOPHON_TB30_ONE_TASK_QUALIFY=1`. Tests
   use fake Harbor.

## Consequences

- `SuiteProtocolSelection` is a discriminated union on `protocol`.
  Harbor-family helpers accept 2.1 **and** 3.0 and still drop Verified.
- GTM and self-serve may name Terminal-Bench 3.0 as a second named
  protocol Colophon wraps. Inspect copy stays “select a supported Inspect
  task.”
- Frontier-Bench is out of this train until Hub’s dataset id actually
  changes.

## Alternatives rejected

- **Store `@latest`.** The living Hub set moves; Colophon seals a hash.
- **Treat GitHub `v3.0.0` (74 tasks) as the suite.** Hub `@latest` and the
  public leaderboard are the living set; the pin is the hash.
- **Follow the Frontier-Bench rebrand before the dataset id changes.**
- **Copy 2.1 Hub submit copy onto 3.0.** Different maintainer flow.
- **Widen Harbor 0.21 conformance to admit a newer Harbor for 3.0.** Split
  conformance by protocol if 3.0 later requires a newer Harbor.

## Ratification

Ratified on 2026-08-18 by the operator’s instruction to implement the
attached TB 3.0 official-suite train. Wearing `terminal-bench-3.0` on a
2.1 lock (or the reverse), storing `@latest`, or silently following a new
Hub hash requires a superseding record.
