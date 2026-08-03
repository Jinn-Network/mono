# @jinn-network/benchmarking-local

Local-venue implementations of the `@jinn-network/benchmarking-run` assembly port contract,
including the **treatment-fidelity bridge**: local admission-gate results and Evidence Runtime
Observations in, per-axis `match | mismatch | unverifiable` out.

Authority: the policy identity/outcomes design §7 (producer contract) and the benchmarking
application design §8.1 / §8.3 / §8.4 (Matrix semantics, which win on any conflict).

## What it does not do

This package imports no concrete backend and no evidence package — the benchmarking
source-boundary guard forbids both across the whole tree, and the identity design takes the
same "mirrored, never imported" posture for evidence envelope shapes. Every venue fact is an
argument: the host that ran the admission gate and recorded the observations passes them in.
Nothing here reads config, opens a socket, or touches the filesystem.

## The bridge

`localPinningObservation` grades each of the four core axes independently.

| Axis | Requirements key | Strength on this venue | Reaches `match` when |
| --- | --- | --- | --- |
| `harness` | `harness` | enforced | the pin is present, the admission gate accepted it, and no observation disagrees |
| `model` | `model` | enforced | same |
| `loadout` | `loadout` | enforced | same |
| `isolation` | `isolationPolicy` | vacuous | the pin equals the venue's sole declared isolation value, and no observation disagrees |

And, on every axis:

- **`mismatch`** — an observation affirmatively names a different value than the pin.
- **`unverifiable`** — everything else, including an unpinned or `null`-filled axis, an
  absent admission result, and a *rejected* admission. A rejection means nothing ran, which
  is not evidence that something else did. `unverifiable` is never silently upgraded.

`verifyRunPinning` never inspects the isolation axis, so the launcher inventory is that
axis's only admission boundary: a singleton inventory equal to the pin means the venue
structurally could not have run anything else. That is a real match, and it is vacuous — the
identity design's per-axis *strength* is where the vacuity is disclosed, not the Matrix
tri-state, which answers the different question of whether the pin was honored.

Object-shaped pins corroborate by **satisfaction, not equality**: every field the pin declares
must hold where the observation carries it, and fields the pin does not declare are
unconstrained. A `{provider}`-only model pin therefore names a family that a richer
observation can satisfy, and a venue that happens to know the harness binary digest cannot
turn that knowledge into a contradiction of a pin that carried only `{id, version}`.

## Runtime Observations

`axisObservationsFromRuntimeObservations` projects `resource`-kind captures under
`https://jinn.network/properties/run-pinning/<axis>` onto axis observations. Object-shaped
axis values travel as JSON text, because a resource capture's value admits only string,
number, or boolean; a string that is not JSON is taken literally, which is what the scalar
`isolationPolicy` axis needs.

**No producer emits these captures yet.** Until one does, the bridge simply sees no
observations, which leaves enforced axes on the admission-gate leg and attested axes
`unverifiable` — the honest posture, and the same one the marketplace bundle hardcodes.

## The rest of the bundle

- `localInputScope` — the owner-declared cell set (design §7.2 leg (c)).
- `localCloseBoundary` — `at` only; a local venue has no chain to anchor against.
- `failClosedTrustResolver` / `unresolvedTrustResolver` — host-supplied resolution, wrapped so
  a failure resolves to `unresolved` rather than aborting assembly.
- `localAdmissionEvidence` — integrity tier copied from an admission receipt; `attested-only`
  whenever no receipt exists (§8.4).
- `localReportedCost` — always `source: "reported"`; a local venue cannot settle.
- `localAssemblyPorts` — the whole bag, wired.
