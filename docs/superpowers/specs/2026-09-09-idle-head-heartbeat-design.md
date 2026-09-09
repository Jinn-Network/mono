# Idle-Head Heartbeat for Record-Discovery Sources

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-09 |
| **Shape** | `design` |
| **Status** | proposed — awaiting an operator ruling on §10's four decisions |
| **Issue** | [#4187](https://github.com/Jinn-Network/mono/issues/4187) |
| **Succeeds** | [#2549](https://github.com/Jinn-Network/mono/issues/2549), whose filed acceptance criteria are already satisfied on `next` |
| **Depends on** | [record discovery](../plans/2026-07-28-record-discovery.md) §5.2, §5.5, §7 item 3; [record-discovery protocol design](./2026-07-27-record-discovery-protocol-design.md) §5.2, §13.4, §14.1 |
| **Touches** | the `self-source-stale` / `self-source-future-head` degrades (#2547, #2548, #2550, #3467); the re-signed-head classification (#3468); the freshness-window rules (#3467, #3482) |
| **Outcome** | one primitive specified, one trigger rule, one liveness gate, one sequencing constraint, and two corrections to the issue's own phrasing |

## 0. Decision in plain language

A record-discovery source publishes one mutable signed document — its head — and §5.2
obliges a live source to re-sign that head before `refreshBy` lapses **even when it has
nothing new to announce**. An expired head is a withholding signal, not silence. `serve`
ships the primitive for it (`refreshHead` / `maintainHead`, `packages/discovery/serve/src/head.ts`).

Nothing in this tree ever calls it while idle. Every in-tree publisher re-signs only
after an append, and the operator daemon does not call `maintainHead` at all — its three
served sources mint heads exclusively inside `DurableSourceWriter.append`, whose entire
public surface is `append` / `recover` / `readState`. **There is no head-only refresh
entry point on the operator's real head-minting path.**

The consequence is the round-10 gate observation recorded on #2549 on 2026-08-10: operator
A idled for more than 24 hours, its served requester head lapsed `refreshBy`, and operator
B — cold-booting while A was up and reachable — refused it and stayed un-joinable until A
happened to post again. Following an idle re-stamp is solved (#3468). **Producing one on a
schedule is not**, and without it an idle source is invisible to any peer that arrives
during the idle window.

This design specifies the producer half. Four decisions carry it:

**The primitive is a fourth method on `DurableSourceWriter`, not `maintainHead`.**
`maintainHead` writes straight to the blob store, past the writer's compare-and-swap state,
its readback verification and its intent journal. A head written that way can later be
refused by the writer's own `assertHeadMatchesState`. The refresh belongs inside the same
transaction machinery that mints heads today. §5.

**The trigger is level-based, not a deadline timer.** Re-sign when the served head's
remaining window has fallen below half the window it was minted with, checked on a fixed
short tick. A deadline timer is fragile against restart, suspend and the very wedge
conditions the loop must survive; a level check on an existing tick is not. §4.

**The gate is the watchdog, not daemon readiness.** A wedged-but-live daemon is the one
scenario in which a heartbeat could genuinely mask a dead source, and the daemon already
detects it in five minutes. A *degraded* daemon is not that scenario: it is alive, serving,
and not withholding, and refusing to refresh its head would reintroduce the round-10
failure through a different door for exactly the population the `self-source-stale` degrade
exists to protect. §6.

**One consumer must be pinned before the producer is armed.** Two of the three in-tree
consumers of a re-signed idle head are pinned and correct. The third,
`operator/src/native-consumer/sync.ts`, has no equivalent predicate, reaches the shape by a
third route, and is covered by no test. Arming the timer while its behaviour is unverified
would convert a dormant hazard into a live one in the same change. §7.

**Two of the issue's own acceptance criteria are imprecise against the code**, and this
record corrects rather than restates them. AC1 says a re-sign changes "issuedAt only"; it
changes `refreshBy` too, and that re-basing is the entire mechanism. AC3 says the
self-source degrade "keeps refusing" a stale self-served head; a self-served stale head
*degrades* — it is a **peer's** that refuses. §2 and §6.1.

## 1. What #2549 left, and what round-10 actually showed

#2549's filed criteria are satisfied on `next`. The consumer side admits an honest idle
re-sign onto revalidation rather than tripping the sequence guard:

- `reSignedIdleHead` (`operator/src/daemon/native-discovery.ts:433`) classifies a head at
  the stored `sequence`/`entry` with a strictly greater `issuedAt` as `'re-signed'` and
  routes it to `source-head-revalidation`, which re-checks signature, currently-valid key,
  the §5.2 window and freshness on every call.
- `classifyIdleHead` (`plugin/runtime/src/corpus/mirror.ts`) does the same for the plugin
  runtime's corpus mirror.
- Both are pinned — `operator/test/daemon/native-discovery.test.ts` (the
  `#3468` group at `:532`) and `packages/discovery/protocol/src/verify/source-chain.test.ts`.

What remains is not a consumer gap. The code that wrote the `self-source-stale` degrade
said so at the time, and its comment is the most precise statement of this issue in the
tree (`operator/src/daemon/native-discovery.ts:838-845`):

> Refreshing the served head at boot instead — "make the head current" — was **not
> available** when this degrade was written: a re-signed head at the SAME sequence is not
> `sameHead` and tripped the `rewound-or-tampered-head` guard below for every consumer
> already checkpointed at that sequence, self AND peer (#2549). **#3468 admits that shape
> onto revalidation, so it is now a real option — but it is the SERVING side's change**,
> and nothing in this tree re-signs an idle head yet.

The serving side's change is what this record specifies.

**The failure, precisely.** Operator A serves its requester source from its own archive.
It idles past `refreshBy` — more than 24 hours, which the code itself calls "a normal
condition, not an edge case". A's own consumer degrades on its own lapsed head
(`self-source-stale`, #2547), so A boots and runs. Operator B cold-boots: it holds no
checkpoint for A's source, so `prior === undefined`, it never reaches the revalidation
branch, and lands on the cold verify path where a lapsed `refreshBy` reports `stale`. B is
not self-serving A's source, so the degrade does not apply and the refusal is hard — and
**correct**. B stays un-joinable until A appends something.

Nothing in that sequence is a bug. Every component behaved as designed. The gap is that
nothing ever makes A's head current while A is idle.

**Why polling frequency is not the answer.** A consumer polls once per `work` or
`evaluator` tick — 5 000 ms (`operator/src/daemon/loop-heartbeat.ts`) — against a
86 400 000 ms window. B was roughly 17 280 polls per window away from its first read. The
head it read had already lapsed; reading it sooner would not have helped.

## 2. What a re-sign changes — correcting AC1

AC1 as filed asks this record to state "what changes in the signed head (**issuedAt
only**)". That is not what the code does, and the correction is not cosmetic.

`refreshHead` (`packages/discovery/serve/src/head.ts:84-100`):

```ts
const issuedAtMs = Math.max(nowMs, prevIssuedAtMs + 1);
const boundedAheadMs = Math.min(requestedAheadMs, MAX_REFRESH_BY_AHEAD_MS);
return {
  ...prev,
  issuedAt: new Date(issuedAtMs).toISOString(),
  refreshBy: new Date(issuedAtMs + boundedAheadMs).toISOString(),
};
```

**Both `issuedAt` and `refreshBy` move.** `refreshBy` is recomputed from the *new*
`issuedAt`, not carried forward. `sequence`, `entry`, `origin` and `protocol` are preserved
by the spread.

That re-basing is the mechanism, not a side effect. A re-sign that moved `issuedAt` alone
would leave `refreshBy` pinned to its original instant; the head would lapse on exactly the
original schedule and round-10 would recur unchanged. The heartbeat works *because*
`refreshBy` re-bases.

**Three consequences the record commits to.**

1. The re-based `refreshBy` is what a consumer persists on the revalidation path
   (`native-discovery.ts` writes the new instant and envelope at the unchanged position),
   and what the redundant clock-side staleness guard reads on the next poll.
2. **The heartbeat re-bases the exposure window; it can never widen it.**
   `MAX_REFRESH_BY_AHEAD_MS` is 86 400 000 ms and is clamped on both sides — when writing
   (`head.ts`) and when reading (`packages/discovery/protocol/src/verify/refresh-bound.ts`,
   whose `Math.min(maxAheadMs, MAX_REFRESH_BY_AHEAD_MS)` a profile may only tighten). The
   §14.1 cold-start rollback exposure equals one window before and after this change. This
   is the structural half of AC3.
3. `Math.max(nowMs, prevIssuedAtMs + 1)` guarantees strict monotonicity at any cadence —
   but it also **carries a future-dated `issuedAt` forward**. On a fast-clocked host that
   makes `head-issued-ahead` sticky, and a heartbeat makes it *periodically* sticky rather
   than once-per-append. §5.3 specifies the guard that stops this.

## 3. Why the sequence guard and `rewound-or-tampered-head` are unaffected

This is AC1's third clause, and the answer is structural rather than a matter of tuning.

`rewound-or-tampered-head` is produced in exactly one place
(`operator/src/daemon/native-discovery.ts:870`):

```ts
if (prior !== undefined && compareCodeUnitStrings(syncedHead.head.sequence, prior.sequence) <= 0) {
  throw new NativeDiscoverySyncError(source, 'rewound-or-tampered-head');
}
```

An equal sequence trips it exactly as a lower one does. But that line sits **below** the
idle-head block, which returns at `:868`. A head with unchanged `sequence`/`entry` and a
strictly greater `issuedAt` is classified `'re-signed'`, enters that block, is revalidated,
and returns before line 870 is ever evaluated.

**The guard is not weakened. It is not reached.** Nothing about this design changes the
comparison, its operands, or its position.

What still trips it, unchanged by this design:

| Head shape vs. the stored checkpoint | Classification | Outcome |
|---|---|---|
| same sequence, same entry, `issuedAt` **>** stored | `'re-signed'` | revalidation; guard unreached |
| same sequence, same entry, byte-identical | `'unchanged'` | revalidation; guard unreached |
| same sequence, same entry, `issuedAt` **≤** stored (rollback or backdated) | none | **`rewound-or-tampered-head`** |
| same sequence, same entry, `issuedAt` unparseable (`NaN`) | none | **`rewound-or-tampered-head`** |
| same sequence, **different** entry (a fork at the position) | none | **`rewound-or-tampered-head`** |
| lower sequence | none | **`rewound-or-tampered-head`** |
| higher sequence (a real append) | none | the ordinary chain path |

Two properties make this safe rather than merely arranged:

- **The floor rises.** An accepted re-sign persists the new `issuedAt`, so the head it
  replaced becomes a rewind at the next poll rather than an indefinitely replayable
  document. Pinned today by `native-discovery.test.ts:571`.
- **Origin binding does not come from the classification.** `reSignedIdleHead` compares
  neither origin nor bytes — `sameHead`'s byte equality used to bind origin implicitly, and
  a re-signed head is a new envelope. Origin binding rests entirely on `verifyHead`, which
  `verifySourceHead` implements as `head-origin-mismatch` before any key resolution, pinned
  by `operator/test/daemon/native-discovery-head-origin.test.ts` (#3530). **A heartbeat
  changes nothing here, and this record does not touch it.**

## 4. When an idle source re-signs

**Rule.** Re-sign the head at the committed position when its remaining window has fallen
below half the window it was minted with:

```
remaining = refreshBy − now
minted    = refreshBy − issuedAt
due       ⟺  remaining ≤ minted × 0.5
```

evaluated on a fixed short tick (300 000 ms, matching `checkpoint`). At today's 24 h window
that is one re-sign roughly every 12 hours per source: negligible I/O, one extra signed
document per source per half-day.

**Level-triggered, never a deadline timer.** A timer scheduled at `refreshBy − ε` is
fragile against process restart, host suspend and the very wedge conditions the loop must
survive. Level-triggering also supplies missed-beat tolerance for free: once the threshold
is crossed there are roughly 144 further ticks before the head lapses, so a transient signer
or blob-store fault costs latency and not joinability.

**Derived from the served head, not from a constant.** Both `minted` and `remaining` are
read back from the head the source is actually serving, never computed from the writer's
`refreshWithinMs`. Every operator writer omits `refreshWithinMs` today, so it is always the
86 400 000 ms ceiling and a `refreshWithinMs / 2` rule would read as a constant and hide the
coupling. Reading the served head means a future tighter profile tightens the heartbeat
automatically, with no second place to change.

**Half, not a smaller fraction.** Consumers already grant one full window of clock-skew
slack (`checkRefreshWindow` rule 3 bounds `issuedAt` against the verifier's own clock by the
same ceiling), so a peer with a slow clock is not the constraint. Level-triggering, not a
smaller fraction, is what buys retry headroom.

**No jitter.** Each source's trigger is derived from its own `issuedAt`, which is
append-time-derived and therefore already desynchronised across a fleet. There is no shared
wall-clock boundary for a fleet to synchronise on.

**A non-finite `minted` or `remaining` is not due.** Fail closed: the head is left alone and
the existing degrades cover the source.

## 5. Where the primitive lives

### 5.1 A fourth method on `DurableSourceWriter`, not `maintainHead`

The operator's three served sources — solver and evaluator
(`operator/src/daemon/native-signed-source.ts`) and requester
(`operator/src/native-requester/requester.ts`) — all mint heads through
`createDurableSourceWriter`, inside the append transaction. `DurableSourceWriter` exposes
`append` / `recover` / `readState` and nothing else.

`maintainHead` is the wrong tool for them, for a reason that is mechanical rather than
stylistic. It takes a `prevHead` and writes straight to a `BlobStore`, bypassing the
writer's compare-and-swap state, its readback verification and its intent journal. A head
written that way can be one the writer's own `assertHeadMatchesState` later refuses
("source head does not match the committed source position"). The operator does not call
`maintainHead` today and must not start.

The correct shape is a fourth method — sibling to `append`, `recover` and `readState` —
that re-mints and re-signs at the committed position through the same path. Its outcomes
are returned, not thrown: the caller is a loop that runs every five minutes, and a
throw-per-tick is noise rather than signal.

```
refreshed        the head advanced; previous and current windows reported
not-due          the level trigger has not fired
no-position      state.last is null; there is nothing to refresh
append-in-flight a staged intent exists, or the state CAS lost
refused          checkRefreshWindow rejected the candidate; nothing was written
```

`evidence-journal`'s `publish` already admits an empty batch and re-signs in place, which is
the existing proof that the *semantics* are settled. Only the durable-writer implementation
is missing.

### 5.2 The staged-intent interlock

A refresh must refuse while an append intent is staged. A staged intent carries
`expectedHeadDigest`; writing a head underneath it makes the intent's own guard throw
("source head changed after the append intent was claimed") on every subsequent `recover()`
— a permanent wedge of the source. Checking for a staged intent before writing, plus
per-source serialisation at each operator leg (§5.4), is the whole safety argument against
a refresh racing a real append.

### 5.3 The fast-clock guard

`refreshHead` computes `issuedAt = max(now, prevIssuedAt + 1)` and therefore carries a
future-dated `issuedAt` forward. Left unguarded, a heartbeat on a fast-clocked host would
re-poison its own head on a schedule.

The refresh path therefore applies `checkRefreshWindow` to the candidate against the host
clock — exactly as the append path already does before minting — and on any failure returns
`refused` **without writing**. The operator's own `self-source-future-head` degrade still
covers its boot; peers still refuse the un-refreshed head as `head-issued-ahead`. Nothing
is masked and nothing is made worse.

### 5.4 The three legs, and why the requester is the one that matters

**Solver and evaluator** are the easy legs. `NativeSignedSourcePublisher` already holds the
durable writer, the signer, the store and a serialised append promise chain — free mutual
exclusion against a concurrent append. The refresh pushes onto that same chain, so no second
lock is invented. `FleetServedSource` is **not** widened: it is the read plane, and the
two-operator boot test asserts its shape.

**The requester is the awkward leg, and it is the one #2549 actually observed failing.**
`FleetRequesterWrite.discovery` exposes only `{ source, handler }`, and its writer is
constructed per-append inside `appendRequesterSource` under `withSourceLease` and then
discarded. A requester heartbeat needs a new exported entry point taking the same
source-global lease.

It also carries a coupling that no other leg has, and that this design must state
explicitly because getting it wrong bricks the source:

- The writer's append refuses unless the command timestamp **strictly advances the served
  head** (`source-writer.ts:827-832`).
- The requester computes that timestamp as `max(now, committed.last.head.issuedAt + 1)`
  (`requester.ts:1718-1721`) from **its own state**, not from the served blob.
- `DurableSourceState` carries no head timestamps, but the requester's `SourceState.last.head`
  is a full `SourceHead`.

So a refresh that moves the blob without moving the requester's recorded head desynchronises
the two floors. The resolution is already available and is why the refresh belongs inside
the writer: the refresh re-commits state through `states.compareAndSwap` with the **generic**
state unchanged, and the requester's state store reconstructs `lastHead` from the signed head
on every commit — so a head-only change produces an identical generic state while refreshing
the requester's own record of its head. `sameDurableState` compares the generic state, which
carries no head, so its guard passes.

This is subtle enough that the implementation plan (§8) makes it the one test that must be
written before its implementation.

### 5.5 No intent journal for a refresh

A head-only refresh has one blob write and no cross-object invariant: both the old head and
the new one satisfy `assertHeadMatchesState`, since `sequence` and `entry` are identical
and that assertion does not compare `issuedAt`. A crash mid-write leaves one or the other,
and both are valid. This is why the fourth method is small, and why it does not need a
fifth journal shape.

## 6. What the heartbeat must not mask

### 6.1 Correcting AC3

AC3 as filed says the self-source degrade "keeps **refusing** a genuinely stale self-served
head". It does not, and by design must not. A genuinely stale **self**-served head
*degrades* — that is what #2547 built, to stop a co-located requester and evaluator from
deadlocking their own boot after any idle stretch. It is a **peer's** stale head that
refuses hard.

Restated in terms of what it actually protects: **the heartbeat must not make a dead source
look live, and the peer refusal path must stay intact.**

### 6.2 The one scenario that is real

| Scenario | Does a heartbeat mask it? |
|---|---|
| Process dead — crash, OOM, SIGKILL, host down | **No.** An in-process timer dies with the process, the head lapses on schedule, and nothing serves it anyway. |
| Process alive, **a loop wedged** | **Yes — this is the live hazard.** Loops are scheduled by independent timers; a wedged `work` tick blocks only its own re-entry guard, never a sibling. |
| Process alive, readiness `degraded` | Yes, and **correctly** — see §6.4. |
| Signing key revoked or rotated out | **No.** `verifySourceHead` resolves keys valid at `now`; `unauthorized-signer` is a hard refusal for self and peer alike. |
| A refresh stretching `refreshBy` past the ceiling | **No.** Clamped when writing and when reading; `refresh-by-ceiling` refuses even for a self-served source. §2. |
| Host clock fast | **No.** Refused by §5.3's guard before writing. |

The wedged-loop row has teeth, because `JINN_WATCHDOG_AUTO_RESTART` defaults to `false`: a
stale loop is loud-logged and the process keeps running. It is also the row the daemon
already solves. `WatchdogLoop` marks a loop stale at
`max(stalenessFactor × intervalMs, floorMs)` with a default factor of 6 — for `work` that is
`max(6 × 5 000, 300 000) = 300 000 ms`. **Five minutes, against a 24-hour window the
heartbeat would otherwise mask: 288× finer.**

### 6.3 The gate

The heartbeat registers `admission: 'always'` and refuses to re-sign any source while the
watchdog holds **any** supervised loop (other than the heartbeat's own row) in a
reported-stale episode. `reportedStale` is a fire-once set cleared when a loop's heartbeat
recovers, so it genuinely means "currently stale", and it needs one read accessor.

A withheld refresh logs loudly and emits a structured event once per episode. It must never
silently no-op — otherwise the operator learns about it from a peer.

Stated plainly, because it is the point: **a wedged operator's head still lapses at 24 hours
and peers still refuse it.** That is the correct outcome and is the property `refreshBy`
exists to provide.

Registering `always` and gating the tick's *action* is the only shape that expresses this,
because `runLoop` stamps a loop's heartbeat outside the admission gate — a `ready-only` row
would be paused, not stale, and could not express the distinction by registry class.

**With the watchdog disabled there is no gate.** No liveness oracle means the heartbeat runs
unconditionally. That is honest rather than silently fail-open, and it is documented on the
config field rather than buried.

### 6.4 Why readiness is *not* the gate

Gating on `degraded` readiness as well was considered and is rejected.

A degraded operator is alive, reachable, and serving its archive. Its published records are
still valid and still retrievable, and it is withholding nothing. What a fresh head asserts
is "this source is not withholding" — not "this operator is claiming work". Refusing to
refresh while degraded would make a degraded operator un-joinable to every new peer: the
round-10 failure again, through a different door, for exactly the population `self-source-stale`
was written to protect. `ready-only` loops are, in the daemon's own words, "intentionally
paused, not stale".

### 6.5 The `self-source-*` degrades are kept, unchanged

`self-source-stale` and `self-source-future-head` stay exactly as they are. The heartbeat
makes that path rare; it does not make it unreachable. The degrade still covers an operator
whose heartbeat is withheld by the watchdog gate, one whose heartbeat has not yet run since
boot, and one whose clock is fast — an orthogonal condition the heartbeat cannot fix and, per
§2, makes stickier. Removing them would re-open the #2547 boot deadlock in precisely the
cases the heartbeat deliberately declines to cover.

Their code comments, which currently justify themselves by "nothing in this tree re-signs an
idle head yet", become false on landing and are corrected in the same change (§8).

## 7. The three consumers, and the one that is unpinned

A re-signed idle head reaches three in-tree consumers by three different routes.

| Consumer | Predicate | Route | Pinned? |
|---|---|---|---|
| `operator/src/daemon/native-discovery.ts` | `reSignedIdleHead` | classifies from the head alone, never walks | yes (#3468 group) |
| `plugin/runtime/src/corpus/mirror.ts` | `classifyIdleHead` | classifies only after its walk yielded nothing; also binds origin, since its high-water mark carries no envelope | yes |
| `operator/src/native-consumer/sync.ts` | **none** | falls through the byte-identical shortcut to the chain walk, **feeding the boundary entry itself** | **no** |

The third is the sequencing constraint. Its byte-identical revalidation shortcut misses on a
re-signed head — a new envelope is not byte-identical — so it falls through to the chain path
with `firstAdoption` false, looks the boundary entry up in local state, and unshifts it into
the fed set. On that route `verifySourceChain` sees a strictly increasing `issuedAt` and a fed
boundary, so it would most likely **accept**.

Functionally right; procedurally wrong. #3468 ruled that this shape belongs to
`source-head-revalidation`, and the chain procedure's own test pins it *refusing* the shape
when the boundary is not fed. This consumer escapes that refusal only because it supplies the
boundary itself — which also means it is fragile in a way the other two are not: if the
boundary entry is absent or inactive in local state, the same head fails
`discontinuous-source-chain`.

That reading was traced, not executed, and no test covers it. **The producer must not be armed
until this consumer is pinned** — otherwise this change converts a dormant hazard into steady
state in the same commit, which is the failure mode the head-anchoring design already warns
about in this exact area. §8 Stage 1 plans both branches: it accepts, or it does not.

## 8. How it gets built

Six stages, each independently landable and reviewable, ordered so that no stage arms the
producer before its consumers are pinned.

| Stage | Change | Discharges |
|---|---|---|
| 0 | Prose corrections only: AC1's "issuedAt only" (§2) and AC3's "keeps refusing" (§6.1) | AC1 |
| 1 | Pin `operator/src/native-consumer/sync.ts` for the re-signed-head shape; align its predicate with `native-discovery.ts` | precondition for AC2 |
| 2 | The fourth `DurableSourceWriter` method, with the staged-intent interlock (§5.2) and the fast-clock guard (§5.3) | AC1 |
| 3 | The three operator legs: solver and evaluator on the existing serialised append chain; the requester's new lease-taking entry point | producer half of AC2 |
| 4 | The `head-refresh` loop row, its config knob, and the watchdog gate | AC3, and arms AC2 |
| 5 | The AC2 regression test in `native-fleet-two-operator-boot.test.ts`, with its negative controls | AC2 |

**Stage 1 — pin the third consumer.** A test feeds mode `unchanged` with a head at the same
`sequence`/`entry`, a new envelope, a strictly greater `issuedAt` and a re-based `refreshBy`,
and asserts the checkpoint advances. A second case removes the boundary entry from local state
and records whatever happens, because that is the route's real fragility. A third refuses a
non-advancing `issuedAt` as a negative control. If the consumer accepts (expected), the
predicate alignment that follows is tidying and the pin holds behaviour across it. If it
rejects, the alignment is mandatory and Stage 2 does not start until it is green.

**Stage 2 — the primitive.** Order of operations: `recover()`; refuse on a staged intent;
`no-position` when there is no committed position; assert the served head against the committed
state; evaluate the level trigger against the served head (§4); `refreshHead`; apply
`checkRefreshWindow` and refuse without writing on failure (§5.3); sign; guard the blob write
on the previous digest and read it back; re-commit state through the writer's CAS with the
generic state unchanged (§5.4).

The highest-value assertion in the stage is that a refresh attempted with a staged intent
returns `append-in-flight` **and leaves the source still appendable** — that is the wedge §5.2
exists to prevent. Two more that must not be skipped: two successive forced refreshes keep
`refreshBy − issuedAt` at the clamp (§2's no-widening property), and omitting the injected
clock is byte-identical to wall-clock.

**Stage 3 — the legs.** The requester's regression test must be written before its
implementation: publish an association, advance the clock past the half-window, refresh, then
post a second association and assert the append succeeds. Without §5.4's state re-commit it
fails on `SourceWriterIntegrityError("announcement timestamp must strictly advance the signed
source head")`. That test is the only thing standing between this design and a bricked
requester source.

**Stage 4 — the loop.** One `LOOP_REGISTRY` row (`head-refresh`, 300 000 ms, `always`), one
read accessor on `WatchdogLoop` for its stale set, one loop class, one config field. The knob
belongs in the `publicArchive` block, which already gates whether this operator serves anything
at all — so an operator that serves nothing inherits the correct default for free, and the
kill switch (`0` disables) is scoped where an operator would look for it. Naming follows the
five existing `*_INTERVAL_MS` loop knobs.

`operator/test/architecture/loop-registry-narrowed.test.ts` pins the registry at exactly ten
rows and asserts set equality against its `REQUIRED` list. **It goes red the moment the row
lands**; updating it (and `CLAUDE.md`'s "Remaining ten") is part of this stage, not a follow-up.

**Stage 5 — the gate regression.** Extend `native-fleet-two-operator-boot.test.ts`, which
already stands up both operators' real archives, the real serving plane on loopback and the
real fleet boot over real HTTP. It needs one production change to be testable: an optional
`now` threaded through `native-fleet-discovery.ts` to `buildNativeDiscoverySources`, which
already accepts it. Five cases, in order:

1. **The defect, asserted rather than described** — heartbeat off, A's head aged past
   `refreshBy`, B cold-boots and refuses. This is round-10.
2. **The fix** — heartbeat on, A's head advances at the same position, and B's cold `sync()`
   returns `{ accepted: 0, verifiedSources: 1, degraded: [] }`. The **empty `degraded` array**
   is the pass condition: a `self-source-stale` or `stale` entry is exactly what round-10
   produced.
3. **AC3 gate control** — watchdog reporting a stale loop, A's served head byte-unchanged, B
   still refuses.
4. **AC3 inversion control** — readiness `degraded` with no stale loop: the head **does**
   advance. Red if anyone re-adds the rejected readiness gate (§6.4).
5. **Peer negative control** — the same aged head from a base URL that is not this operator's
   own still refuses hard. No existing test covers the `selfServed` discriminator in the
   aged-head shape.

Cases 1 and 2 are a matched pair: case 1 must be red-first against the pre-Stage-3 tree, or
the pair proves a scheduling accident rather than a mechanism.

`yarn e2e:archive-second-daemon` stays the live-surface gate it already is. It seeds a
pinned-instant fixture and mints heads through `maintainHead` rather than the durable writer,
so it exercises a different write path than production.

### 8.1 Statements that become false on landing

Each of these currently justifies itself by "nothing in this tree re-signs an idle head yet".
Correcting them is part of the change that makes them false, not a follow-up.

| File | What is now false |
|---|---|
| `operator/src/daemon/native-discovery.ts:407-408` | "Nothing in this tree re-signs while idle yet — every in-tree publisher calls `maintainHead` only after an append — so the shape arrives from an external source." |
| `operator/src/daemon/native-discovery.ts:843-845` | "nothing in this tree re-signs an idle head yet, so this degrade still covers the operator that has not." Rewrite per §6.5: the degrade stays, now covering a gated operator, one pre-first-heartbeat, and one with a fast clock. |
| `packages/discovery/protocol/src/verify/source-head.ts:29` | "though no in-tree publisher calls it while idle". |
| `plugin/runtime/src/corpus/mirror.ts:75-77` | "the shape arrives from a conformant external source rather than from anything here (#2549)". |
| `plugin/runtime/src/corpus/sync-loop.ts:550-555` | "Per #2549 every in-tree publisher re-signs a head only after an append, so a correct but quiet feed accumulates head age indefinitely." Correct the rationale; note that promoting that row from reported to gating is now possible and is **not** done here. |
| `packages/discovery/protocol/src/verify/source-chain.test.ts:146-147` | "Both consumers now classify it before reaching this procedure" — there are three (§7). |
| `operator/test/daemon/native-discovery.test.ts:530-531` | "No in-tree publisher re-signs while idle, so the shape arrives from an external source." The fixture rationale that follows it stays true. |
| `docs/superpowers/specs/2026-09-01-publication-head-anchoring-design.md` §1 | Its "dormant" characterisation of the idle re-stamp hazard. Amend with a pointer to this record rather than retro-editing dated prose. |

## 9. What this design does not do

- **Does not expose `refreshWithinMs` as an operator knob.** It is a protocol-profile
  parameter clamped at 24 h; a tighter value narrows the margin for every consumer of this
  operator. Explicitly out of scope.
- **Does not delete or narrow the `self-source-*` degrades** (§6.5).
- **Does not change** `reSignedIdleHead`, `classifyIdleHead`, `verifySourceChain`,
  `checkRefreshWindow`, or the `rewound-or-tampered-head` guard.
- **Does not widen `FleetServedSource`.** It stays the read plane.
- **Does not add a scheduler to `packages/discovery/serve`.** That package stays a pure
  library of write primitives; the timer lives in the operator.
- **Does not add a caller to `packages/marketplace/projector` or `evidence-journal`.**
  `publish` already admits an empty batch; no caller is added.
- **Does not promote the plugin corpus doctor's head-age row from reported to gating.** That
  becomes possible once idle heads are re-signed, and is left as a follow-up.
- **Does not cover a source whose host process dies.** An in-process timer dies with it, the
  head lapses, and peers refuse it. That is the correct outcome.
- **Does not make a source provably live.** A fresh head proves the source is being
  maintained by something holding its key, on a host whose clock is within one window. It
  does not prove the operator is doing work, and §6.3 is written so that it does not pretend
  to.

## 10. Decisions for the operator ruling

**D1 — The half-window level trigger, checked on a 300 000 ms tick (§4).** *Recommended: yes.*
The alternative shapes are a deadline timer (fragile against restart and against the wedge
conditions the loop must survive) and a smaller fraction such as one third (buys nothing that
level-triggering does not already buy). Half at a 24 h window is one re-sign per source per
twelve hours.

**D2 — The gate is watchdog staleness, not daemon readiness (§6.3, §6.4).** *Recommended: yes.*
This is the one place the two independent design passes disagreed. Gating on readiness as well
would make a degraded-but-serving operator un-joinable to new peers — round-10 again, for the
population `self-source-stale` exists to protect. The counter-argument is that `refreshBy` is
the protocol's only withholding signal and any heartbeat weakens it; the answer is that the
watchdog gate keeps the signal for the only case where it means "dead", at five-minute
resolution rather than twenty-four-hour.

**D3 — The primitive is a fourth `DurableSourceWriter` method, not a `maintainHead` caller
(§5.1).** *Recommended: yes.* `maintainHead` bypasses the writer's CAS state, readback
verification and intent journal, and can write a head the writer itself later refuses.

**D4 — `operator/src/native-consumer/sync.ts` is pinned before the producer is armed (§7).**
*Recommended: yes.* It is unpinned, unverified, and reaches the shape by a third route. The
cost is one test and possibly one predicate alignment; the cost of skipping it is arming a
timer against a consumer whose behaviour nobody has checked.

## 11. Follow-ups this design defers

To be filed as issues when this record is adopted; none of them blocks the work above.

1. **Promote the plugin corpus doctor's head-age row from reported to gating.** Its rationale
   for never gating is that "every in-tree publisher re-signs a head only after an append", which
   this design falsifies. Once idle heads are re-signed, accumulating head age becomes a real
   fault signal rather than a false positive.
2. **`CLAUDE.md`'s `JINN_NATIVE_CONFIG_PATH` / `--native-config` row is stale.**
   `operator/src/daemon/native-config-path.ts` does not exist; the live native config surface is
   `operator/src/config/native-sections.ts`, and `operator.verticalMode: 'native-v1'` is clamped
   back to legacy with a warning — the live switch is `operator.compositionMode: 'native'`.
   Unrelated to this design, found while tracing it, and worth its own correction.
3. **Consider a conformance-kit case for the idle re-sign.** `maintainsFreshness` in
   `packages/discovery/serve/src/head.ts` already checks a succession of heads; nothing exercises
   it against a producer that re-signs on a schedule.
