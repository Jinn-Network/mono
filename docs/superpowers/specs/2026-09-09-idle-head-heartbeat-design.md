# Idle-Head Heartbeat for Record-Discovery Sources

| | |
|---|---|
| **Version** | 0.3 |
| **Date** | v0.1 2026-09-09; v0.2 2026-09-09; v0.3 2026-09-09 |
| **Shape** | `design` |
| **Author** | Autopilot design session (Claude Opus 5); every citation re-read against the attempt head of `autopilot/4187` |
| **Status** | proposed — awaiting an operator ruling on §10.1's five decisions. §10.2 records three calls this record makes rather than putting them up for adjudication. |
| **Issue** | [#4187](https://github.com/Jinn-Network/mono/issues/4187) |
| **Succeeds** | [#2549](https://github.com/Jinn-Network/mono/issues/2549), whose filed acceptance criteria are already satisfied on `next` |
| **Depends on** | [record discovery](../plans/2026-07-28-record-discovery.md) §5.2, §5.5, §7 item 3; [record-discovery protocol design](./2026-07-27-record-discovery-protocol-design.md) §5.2, §13.3, §13.4, §14.1 |
| **Touches** | the `self-source-stale` / `self-source-future-head` degrades (#2547, #2548, #3467); the re-signed-head classification (#3468); the freshness-window rules (#3467, #3482). #2550 was considered and left off: it has no in-tree corroboration — no source file, test or doc mentions it — where each of the other five is corroborated by a code comment matching this record's characterization, so it is dropped rather than carried unverified. |
| **Outcome** | one primitive specified, one trigger rule, one liveness gate, one sequencing constraint, one persistence-invariant change on the requester leg, and two corrections to the issue's own phrasing |
| **v0.3 changes** | Two corrections, five clarifications, no change to any recommendation. §5.1's key-rotation mechanism was wrong — a rotation throws out of `assertStateOwnership` before any head is read, wedging `append` and `readState` alike, and it never clears at the next append; §6.3's observability rationale and §8 Stage 2's `faulted` case follow, and §11 gains a follow-up. §2 consequence 2 no longer says the §14.1 rollback exposure is identical before and after: the *bound* is, the *realized* exposure is not, and that third weakening is now carried into §6.2, §9 and §10.1 decision 1. Also: §10.1 decision 3 states the whole loss (NB1), §10.2 marks its two tunable defaults (NB2), §5.4 stops overstating a guard (NB3), §2 corrects an elision note (NB5). This row is also where the record's revision history now lives: v0.2's corrections of v0.1 are no longer narrated in the body except where the correction itself is the content (§7, §8 Stage 4). |

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

This design specifies the producer half: a head-only refresh, minted through the same
writer that mints the operator's heads today, triggered when the served head's remaining
window has fallen below half the window it was minted with, and withheld while the watchdog
holds any supervised loop stale. §4 argues the trigger, §5 the primitive and its crash
window, §6 the gate and its limits, §7 the one consumer that must be pinned first.

**Two of the issue's own acceptance criteria are imprecise against the code.** AC1 says a
re-sign changes "issuedAt only"; it changes `refreshBy` too, and that re-basing is the
entire mechanism. AC3 says the self-source degrade "keeps refusing" a stale self-served
head; a self-served stale head *degrades* — it is a **peer's** that refuses. §2 and §6.1
set out both corrections against the code. Adopting them changes what "done" means for
#4187, so it is a decision for the issue's filer (§10.1) rather than an assertion this
record makes on its own.

**A design record cannot itself discharge AC2 or AC3.** Both are runtime criteria — a peer
cold-booting during the idle window fetches a head within `refreshBy`; the heartbeat cannot
make a dead source look live. AC1 is discharged here in prose; AC2 and AC3 are routed to
named tests in §8 Stage 3 and Stage 5, which is the only discharge available to a document.

What the operator is asked to rule on is §10.1. What this record decides without asking is
§10.2.

## 1. What #2549 left, and what round-10 actually showed

The criteria #2549 filed are satisfied on `next`. The consumer side admits an honest idle
re-sign onto revalidation rather than tripping the sequence guard:

- `reSignedIdleHead` (`operator/src/daemon/native-discovery.ts:433`) classifies a head at
  the stored `sequence`/`entry` with a strictly greater `issuedAt` as `'re-signed'` and
  routes it to `source-head-revalidation`, which re-checks signature, currently-valid key,
  the §5.2 window and freshness on every call.
- `classifyIdleHead` (`plugin/runtime/src/corpus/mirror.ts`) does the same for the plugin
  runtime's corpus mirror.
- Both are pinned — `operator/test/daemon/native-discovery.test.ts` (the `#3468` group at
  `:532`) and `plugin/runtime/src/corpus/mirror.test.ts` (six `#3468` cases from `:256`).
  `packages/discovery/protocol/src/verify/source-chain.test.ts:146-147` pins the companion
  fact: the chain procedure itself still refuses the shape when the boundary is not fed.

What remains is not a consumer gap. The code that wrote the `self-source-stale` degrade
said so at the time, and its comment is the most precise statement of this issue in the
tree (`operator/src/daemon/native-discovery.ts:838-845`):

> Refreshing the served head at boot instead — "make the head current" — was not available
> when this degrade was written: a re-signed head at the SAME sequence is not `sameHead` and
> tripped the `rewound-or-tampered-head` guard below for every consumer already checkpointed
> at that sequence, self AND peer (#2549). #3468 admits that shape onto revalidation, so it
> is now a real option — but it is the SERVING side's change, and nothing in this tree
> re-signs an idle head yet …

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

`refreshHead` (`packages/discovery/serve/src/head.ts:84-100`). The excerpt elides the
`parseHeadTimestamp` guard on `prev.issuedAt` (`:85-88`) and the clock read that follows it
(`const nowMs = clock.now().getTime()`, `:89`, which is outside that guard); the
`requestedAheadMs` fallback is included, because the no-widening argument below rests on it:

```ts
// …
const issuedAtMs = Math.max(nowMs, prevIssuedAtMs + 1);
const requestedAheadMs = Number.isFinite(refreshWithinMs) && refreshWithinMs > 0
  ? refreshWithinMs
  : MAX_REFRESH_BY_AHEAD_MS;
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
   (`head.ts:94`) and when reading (`packages/discovery/protocol/src/verify/refresh-bound.ts`,
   whose `Math.min(maxAheadMs, MAX_REFRESH_BY_AHEAD_MS)` a profile may only tighten). So the
   **bound** on §14.1's cold-start rollback exposure is identical before and after this
   change. Its size is `checkRefreshWindow`'s own, and it is not one window: the procedure's
   three rules together bound a valid head's `refreshBy` to at most `2 × maxAheadMs` past the
   consumer's clock, as `refresh-bound.ts:34-36` states in its own header. A heartbeat
   re-bases within that bound; it does not move the bound. This is the structural half of AC3.

   **The bound is not the whole claim, and this record does not close the question here.**
   What the heartbeat changes is how often a source sits near that bound. §6.2's
   superseded-head row states the case: a source that idles and then appends leaves behind a
   head that a heartbeat has kept inside `refreshBy`, where today the same head has lapsed.
   That is a third way a heartbeat weakens `refreshBy`, it is a consequence for §10.1's first
   decision to be ruled on, and §9 records that this design declines to cover it. §6.2, §10.1.
3. `Math.max(nowMs, prevIssuedAtMs + 1)` guarantees strict monotonicity at any cadence —
   but it also **carries a future-dated `issuedAt` forward**. On a fast-clocked host that
   makes `head-issued-ahead` sticky, and a heartbeat makes it *periodically* sticky rather
   than once-per-append. **No guard in this design closes that**, and §5.3 explains why one
   cannot: on a uniformly fast host `issuedAt` and the host clock move together, so every
   candidate the heartbeat mints passes every check the producer is able to apply. It is an
   orthogonal fault — hard-refused by every peer before and after this change, and covered
   on the operator's own boot by the `self-source-future-head` degrade. §6.5.

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
append-time-derived and therefore already desynchronized across a fleet. There is no shared
wall-clock boundary for a fleet to synchronize on.

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
stylistic. It takes a `prevHead` and writes straight to a `BlobStore` (`head.ts:126-129`),
bypassing the writer's compare-and-swap state, its readback verification and its intent
journal.

Be precise about the hazard. It is not that the refreshed head disagrees with the head it
replaced — `refreshHead` preserves `origin`, `sequence` and `entry` by spread, so it cannot
introduce that mismatch. It is that the caller's `prevHead` may have gone **stale**.
`maintainHead` never reads the writer's committed state, so a `prevHead` overtaken by a
concurrent append installs a head at a position the writer no longer holds — one the
writer's own `assertHeadMatchesState` then refuses ("source head does not match the
committed source position", `source-writer.ts:326-332`). The operator does not call
`maintainHead` today and must not start.

**Nor an empty-batch `append` through the existing method.** `evidence-journal`'s `publish`
admits an empty entry batch (`publish.ts:50`), which suggests re-using the method the writer
already exposes rather than adding one. It does not carry:
`AppendAnnouncementCommand.announcement` is required, not optional
(`source-writer.ts:138-139`), and an announcement mints an entry, so a refresh routed
through `append` would advance `sequence`. That makes the result a chain claim to every
consumer rather than the same-position revalidation shape #3468 admits — the opposite of
what a heartbeat is for. The option is named here so that it is refused rather than merely
unmentioned.

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
faulted          the path threw; the head is unchanged and the error is reported
```

The last outcome is load-bearing. The refresh path calls machinery that throws for reasons
the five above do not model, and one of them is certain rather than hypothetical: a
blob-store IO failure throws from either the read or the write, and no gate in §5.2 or §5.3
sees it coming. The method catches, returns `faulted` with the error attached, and the loop
reports it under §6.3's observability rule. A bare `catch` that swallowed it would be exactly
the silent-refusal failure §6.3 exists to prevent.

**A signer-key rotation is not a heartbeat condition, and reading it as one misdirects the
implementer.** A rotated key does surface here — the method catches every throw, so a rotation
returns `faulted` on each tick like anything else. What it is not is a fault the heartbeat
introduces, and it never reaches the head at all. `loadState` calls `assertStateOwnership`
(`source-writer.ts:547`), which throws `"durable source state belongs to a different signer
key"` on a `signerKeyId` mismatch (`:340-342`) **before any head is read**, and `readState`
applies the same guard directly (`:951`). `append` loads state through that same `loadState`
(`:785`). So a rotation wedges every entry point on the writer for that source at once —
`append` and `readState` alike — and nothing in the writer re-mints under the new key.
`source-writer.test.ts:422` pins it.

This is a pre-existing hard wedge of the durable writer, independent of this design. The
heartbeat neither causes it nor recovers from it, and the operator's actionable signal is the
wedged writer — every append refusing — rather than anything the heartbeat reports. In
particular it does **not** clear at the next real append, because the append is wedged by the
same guard. §11 files it as a follow-up.

That `evidence-journal`'s `publish` re-signs in place at all is the existing proof that the
*semantics* of a head-only refresh are settled. Only the durable-writer implementation is
missing.

### 5.2 The staged-intent interlock

A refresh must refuse while an append intent is staged. A staged intent carries
`expectedHeadDigest`; writing a head underneath it makes the intent's own guard throw
("source head changed after the append intent was claimed", `source-writer.ts:555-556`) on
every subsequent `recover()` — a permanent wedge of the source. Checking for a staged intent
before writing, plus per-source serialization at each operator leg (§5.4), is the whole
safety argument against a refresh racing a real append.

**The two halves of that serialization are not the same strength**, and this record says
which is which rather than leaving "per-source serialization" to be read as uniform. The
requester's is **cross-process**: `withSourceLease` and the CAS `mutate` both take file locks
on the source's own lock paths (`requester.ts:1011`, `:1018-1019`). Solver and evaluator
serialize **in-process only**, on a promise chain (`append = append.then(...)`,
`operator/src/daemon/native-signed-source.ts:1055`). Two operator processes over one archive
directory would therefore race on those two legs — but they race on appends there today,
identically, so this is not a hazard the heartbeat creates and not one it is this design's
job to close. What the design must not do is assume a lock it does not hold, which is why
the staged-intent check is a precondition of the write rather than a consequence of the
lease.

### 5.3 The fast-clock guard, and what it does not catch

`refreshHead` computes `issuedAt = max(now, prevIssuedAt + 1)` and therefore carries a
future-dated `issuedAt` forward. The refresh path applies `checkRefreshWindow` to the
candidate against the host clock — exactly as the append path already does before minting —
and on any failure returns `refused` **without writing**.

**Be precise about what that catches, because it is narrower than it reads.** It does not
catch a uniformly fast host. There, `refreshHead` sets
`issuedAt = max(fastNow, prev + 1) = fastNow`, and the guard compares that value against the
same fast clock: the difference is zero, the candidate passes, and the head is written. The
tree already states this about the identical bound on the append path — "a uniformly fast
host is not caught -- `issuedAt` and `now` move together, the difference is ~0, and the head
is still issued past every correctly-clocked consumer's window"
(`packages/discovery/serve/src/source-writer.ts:669-671`) — and
`operator/test/daemon/native-discovery.test.ts:349-352` records the same fact from the
consumer side, including that `refreshHead` "carries the future `issuedAt` forward on every
re-sign".

What the guard genuinely catches is the **corrected**-clock carry-forward: a host whose clock
ran fast, minted a future-dated head, and has since been put right. Without the guard,
`max(now, prevIssuedAt + 1)` would carry that stale future instant forward on every tick
indefinitely, so a host that had already recovered could never mint an acceptable head again.
With it, the refresh refuses until a real append replaces the head.

The uniformly fast host is not this design's to fix and this record does not claim otherwise.
Its head is hard-refused by every peer as `head-issued-ahead` before and after this change,
and its own boot is covered by the `self-source-future-head` degrade. §6.5.

### 5.4 The three legs, and why the requester is the one that matters

**Solver and evaluator** are the easy legs. `NativeSignedSourcePublisher` already holds the
durable writer, the signer, the store and a serialized append promise chain — free mutual
exclusion against a concurrent append. The refresh pushes onto that same chain, so no second
lock is invented. `FleetServedSource` is **not** widened: it is the read plane
(`operator/src/daemon/native-fleet-serving-plane.ts:101-104`). Be honest about the guard on
that commitment, because it is weaker than it sounds. The two-operator boot test destructures
`{ source, handler }` from `a.served`
(`operator/test/daemon/native-fleet-two-operator-boot.test.ts:355`), which *consumes* the
shape rather than asserting it — an added field would not turn it red. The commitment stands
on this record, not on that test.

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

So a refresh that moves the blob without moving the requester's recorded head desynchronizes
the two floors. The resolution is already available and is why the refresh belongs inside
the writer: the refresh re-commits state through `states.compareAndSwap` with the **generic**
state unchanged, and the requester's state store reconstructs `lastHead` from the signed head
on every commit — so a head-only change produces an identical generic state while refreshing
the requester's own record of its head. `sameDurableState` compares the generic state, which
carries no head, so its guard passes. The CAS revision does still move, so the refresh's
compare-and-swap loop terminates rather than spinning on an unchanged revision:
`readSourceSnapshot` derives `revision` as a `recordDigest` over the whole persisted
`SourceState` file (`requester.ts:846-852`), and `last.head` — which the refresh changes — is
part of those bytes.

This is subtle enough that the implementation plan (§8) makes it a test that must be written
before its implementation. The re-commit is load-bearing rather than cosmetic even on a
perfectly healthy clock: `appendRequesterSource` derives its command timestamp as
`max(now, previous + 1)` from its own state (`requester.ts:1719-1721`), so an append landing
in the same millisecond as an unrecorded refresh computes `timestamp === blobHead.issuedAt`
and trips the writer's strict-advance check (`source-writer.ts:827-832`) with no clock fault
involved at all.

**What the re-commit does not do is make a refresh crash-safe on this leg.** §5.5 states the
window it leaves open and the three resolutions that close it.

### 5.5 The crash window, and why the no-journal argument only half holds

The argument for omitting a journal is that a head-only refresh has one blob write and no
cross-object invariant: both the old head and the new one satisfy `assertHeadMatchesState`,
since `sequence` and `entry` are identical and that assertion compares `origin`, `sequence`
and `entry` only (`source-writer.ts:326-332`). A crash between the two leaves one or the
other, and both are valid.

**That holds for the generic writer. It does not hold for the requester leg, where the same
crash bricks the source.** The requester's state store does not go through
`assertHeadMatchesState`. `SourceStateStore.read()` reconstructs the source's history from
the stored head (`requester.ts:1432-1445`), and `reconstructRequesterHistory` compares that
head to the one recorded in state **byte-wise**:

```ts
|| (input.last.head !== undefined && !sameJson(head, input.last.head))
```

`requester.ts:1349`; `sameJson` is a canonical-bytes comparison (`:859-861`). A changed
`issuedAt` or `refreshBy` fails it and throws `'requester source public head does not equal
requester-source state'` (`:1353`). The one escape hatch, `skipHead`, is set only when a
pending intent exists (`:1441`) — which §5.2 forbids during a refresh.

So: the refresh writes the head blob, then the process dies before `states.compareAndSwap`.
From that instant `read()` throws on every call, and both of the writer's live entry points
go through it — `append` loads state at `source-writer.ts:785` (→ `loadState`, `:543`) and
`readState` reads it at `:949`. The requester source can never append again, and no code path
returns it to a consistent state. This is not a race narrowed by timing; it is guaranteed for
the whole interval between the two writes, and it is a worse outcome than the timestamp-floor
desync §5.4 describes.

**Three resolutions close it, and choosing between them is a ruling rather than a build
detail** (§10.1, decision 3):

- **(a) Align the requester's head check with `assertHeadMatchesState`** — drop the `sameJson`
  clause at `requester.ts:1349`, keeping the `origin` / `sequence` / `entry` comparisons that
  already sit immediately below it at `:1350-1352` and are exactly the generic writer's
  comparison. The smallest change, and the one that makes this section's opening argument
  true on every leg.
- **(b) A refresh intent for the requester leg** — a fifth journal shape, replayed by
  `recover()`.
- **(c) One durable transaction spanning the blob write and the state commit.**

This record recommends (a), and §10.1 states plainly what it costs.

## 6. What the heartbeat must not mask

### 6.1 Correcting AC3

AC3 as filed says the self-source degrade "keeps **refusing** a genuinely stale self-served
head". It does not, and by design must not. A genuinely stale **self**-served head
*degrades* — that is what #2547 built, to stop a co-located requester and evaluator from
deadlocking their own boot after any idle stretch. It is a **peer's** stale head that
refuses hard.

Restated in terms of what it actually protects: **the heartbeat must not make a dead source
look live, and the peer refusal path must stay intact.**

### 6.2 What a heartbeat can and cannot mask

| Scenario | Does a heartbeat mask it? |
|---|---|
| Process dead — crash, OOM, SIGKILL, host down | **No.** An in-process timer dies with the process, the head lapses on schedule, and nothing serves it anyway. |
| Process alive, **a loop wedged** | **Yes — this is the live hazard.** Loops are scheduled by independent timers; a wedged `work` tick blocks only its own re-entry guard, never a sibling. |
| Process alive, readiness `degraded` | Yes, and **correctly** — see §6.4. |
| Signing key revoked or rotated out | **No.** `verifySourceHead` resolves keys valid at `now`; `unauthorized-signer` is a hard refusal for self and peer alike. |
| A refresh stretching `refreshBy` past the ceiling | **No.** Clamped when writing and when reading; `refresh-by-ceiling` refuses even for a self-served source. §2. |
| Host clock fast | **No** — but not because this design stops it. A fast-clocked head is hard-refused by every peer as `head-issued-ahead` before and after this change, and §5.3's guard does not close the uniformly-fast case either. The heartbeat neither masks the fault nor fixes it. §5.3, §6.5. |
| **A superseded head retained by a rollback mirror**, after a source idled and then appended | **Yes, and this design does not cover it.** §14.1's cold-start rollback residual is left continuously available rather than intermittently. §9. |
| Process alive and ticking, **but its writes or its serving are broken** — a full or read-only blob store, an unreachable archive listener, a persistently throwing append | **Yes, and this design does not cover it.** §9. |

**The last two rows are why this table is framed as a survey rather than as a proof of
exhaustiveness**, and each is carried into §9 rather than left to be inferred from a table.

The **superseded-head row** is the one §2 consequence 2 points forward to, and it is a
consequence of the heartbeat rather than a condition it merely fails to catch. Take a source
that mints its head at T0 with a 24 h window and idles. Today that head lapses at T0+24h, so
when the source finally appends at T0+30h a rollback mirror replaying the retained
sequence-N head is **refused** by a cold consumer: `verifySourceChain` reaches
`fresh.isFresh(head.refreshBy, now)` and returns `stale`
(`packages/discovery/protocol/src/verify/source-chain.ts:118-120`). With the heartbeat the
same head is re-signed at T0+12h and again at T0+24h, so it carries `refreshBy` T0+48h — and
after the T0+30h append moves the source to sequence N+1 the retained sequence-N head is
still **valid**: the signature is good, the key is current, `refreshBy` has not lapsed, and
a cold consumer has no floor to fail. On first adoption there is no high-water mark, so no
`issuedAt` monotonicity check applies (`:129-142`) and the walk simply runs to genesis
(`:174-176`), which a chain prefix satisfies. That consumer is held at the superseded
position for up to a further 18 hours.

The bound is not violated — §2 — but the frequency with which a source sits near it goes from
near-zero to near-always for anything that idles before appending. **Two mitigations survive
and should be read alongside it.** §13.3's cold-start procedure fetches from *every* reachable
mirror in the policy's mirror set and takes the highest valid `(sequence, issuedAt)`, so the
real head at sequence N+1 is preferred wherever the real source is reachable; and a returning
consumer is unaffected, because its high-water mark supplies both an `issuedAt` floor and a
walk boundary the superseded head cannot satisfy. This is a caveat to name in §10.1's first
decision, not a reason to change its recommendation.

**The broken-writes row** is the other. A source in that condition is alive, its loops tick,
and it can write a head blob a few hundred bytes long — so the heartbeat re-signs on schedule
while the archive behind that head is unreachable, frozen or
unextendable. Nothing catches it. No `LOOP_REGISTRY` row supervises the serving plane or the
append path's health; the ten rows are `posting`, `reward-claim`, `balance-topup`,
`eviction-check`, `checkpoint`, `harvest`, `projector`, `evidence-driver`, `work` and
`evaluator` (`operator/src/daemon/loop-heartbeat.ts:41-65`). And a loop that catches its own
error and retries still stamps its heartbeat — `runLoop` records the tick outside the
admission gate and after the error handler (`:221`) — so §6.3's watchdog gate does not fire
for it either.

Today a lapsing `refreshBy` makes that fault visible to a peer within 24 hours. A heartbeat
removes that signal and puts nothing in its place: a peer cannot distinguish such a source
from an honestly idle one. This design does not cover it and says so in §9 rather than
leaving the omission to be inferred from a table. Covering it would need a liveness oracle
over the write and serve paths specifically — a different instrument from the watchdog, and
a larger piece of work than this issue. §10.1's second decision is framed so that the gate
is ruled on knowing this.

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

**The same rule binds every other outcome, not only the gate.** A refresh returning `refused`
on a fast-clocked host (§5.3), `append-in-flight` against a wedged lease, or `faulted` against
a full or read-only blob store (§5.1) will return it on every tick for as long as the
condition lasts, and a per-episode event covering only the watchdog case would leave all three
invisible for months. The loop therefore emits one structured event on every **change** of
outcome for a source, including the change back to `refreshed`, and logs the current outcome
at a level an operator sees. Per-tick events are not the requirement; per-transition ones are.
Those three are precisely the conditions in which a heartbeat refuses silently and
indefinitely while the daemon otherwise looks healthy — none of them wedges anything an
operator would notice locally, and each of them ends with a peer refusing this operator's
head. That is the state the per-transition rule exists to make visible.

Stated plainly, because it is the point: **a wedged operator's head still lapses at 24 hours
and peers still refuse it.** That is the correct outcome and is the property `refreshBy`
exists to provide.

Registering `always` and gating the tick's *action* is the only shape that expresses this,
because `runLoop` stamps a loop's heartbeat outside the admission gate — a `ready-only` row
would be paused, not stale, and could not express the distinction by registry class.

**With the watchdog disabled there is no gate**, and this record does not settle that on its
own authority — it is §10.1's fourth decision. The recommendation is to run unconditionally
and document it on the config field. An operator who has turned the watchdog off has already
declined the daemon's liveness supervision, and refusing to refresh for them would make that
operator un-joinable to every new peer, for the same reason §6.4 rejects the readiness gate.
The alternative — refuse to refresh when no watchdog is present — fails closed and is
defensible on that ground. Either way it is a masking hazard installable by configuration, so
it belongs in §10.1 as a decision and not only as a note on a config field.

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

## 7. The three consumers, and the one that is only half pinned

A re-signed idle head reaches three in-tree consumers by three different routes.

| Consumer | Predicate | Route | Pinned? |
|---|---|---|---|
| `operator/src/daemon/native-discovery.ts` | `reSignedIdleHead` | classifies from the head alone, never walks | yes (#3468 group) |
| `plugin/runtime/src/corpus/mirror.ts` | `classifyIdleHead` | classifies only after its walk yielded nothing; also binds origin, since its high-water mark carries no envelope | yes |
| `operator/src/native-consumer/sync.ts` | **none** | falls through the byte-identical shortcut to the chain walk, **feeding the boundary entry itself** | **partly** |

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

**That reading is confirmed, and v0.1 of this record was wrong to say no test covers it.**
`operator/test/native-consumer/sync.test.ts:281-288` feeds exactly this shape — the same
`sequence`/`entry`, a new envelope, `issuedAt` 12:02 against a checkpoint at 12:01 — and
asserts mode `unchanged`, acceptance, and a checkpoint whose instant advances to the new one.
A second, independent static trace through `walkLinkage` and `verifySourceChain` reaches the
same conclusion; the executed fixture is the stronger evidence and this record rests on it.

What is unpinned is narrower than the route's fragility suggests, and it is the part that
bears on the producer:

- **The re-based window is untested.** The fixture's `publicSource` helper hard-codes
  `refreshBy: '2026-08-03T12:00:00.000Z'` for every head it builds (`sync.test.ts:86`), so
  both heads in that case carry the same `refreshBy`. Re-basing `refreshBy` **is** the
  heartbeat (§2): the one field the producer changes is the one field the fixture holds
  constant.
- **The fragility branch is uncovered.** If the boundary entry is absent or inactive in local
  state, the same head is rejected `discontinuous-source-chain`
  (`operator/src/native-consumer/sync.ts:183-186`) — a failure mode neither of the other two
  consumers has, because neither of them walks.
- **There is no negative control.** Nothing asserts that a head whose `issuedAt` does not
  advance is refused.

**The producer must not be armed until those three are pinned** — otherwise this change
converts a known-fragile route into steady state in the same commit, which is the failure
mode the head-anchoring design already warns about in this exact area. §8 Stage 1 extends the
existing pin rather than writing one.

## 8. How it gets built

Six stages, each independently landable and reviewable, ordered so that no stage arms the
producer before its consumers are pinned.

| Stage | Change | Discharges |
|---|---|---|
| 0 | Prose corrections only: AC1's "issuedAt only" (§2) and AC3's "keeps refusing" (§6.1), once §10.1's fifth decision accepts the amendment | AC1 |
| 1 | Extend `operator/src/native-consumer/sync.ts`'s existing pin to the re-based window and both failure branches; align its predicate with `native-discovery.ts` | precondition for AC2 |
| 2 | The fourth `DurableSourceWriter` method, with the staged-intent interlock (§5.2), the fast-clock guard (§5.3) and §10.1's requester crash-window resolution | AC1 |
| 3 | The three operator legs: solver and evaluator on the existing serialized append chain; the requester's new lease-taking entry point | producer half of AC2 |
| 4 | The `head-refresh` loop row, its config knob, and the watchdog gate | AC3, and arms AC2 |
| 5 | The AC2 regression test in `native-fleet-two-operator-boot.test.ts`, with its negative controls | AC2 |

**Stage 1 — finish pinning the third consumer.**
`operator/test/native-consumer/sync.test.ts:281-288` already feeds mode `unchanged` with a
head at the same `sequence`/`entry`, a new envelope and a strictly greater `issuedAt`, and
asserts the checkpoint advances. This stage extends that case; it does not write one from
nothing. Three additions: vary `refreshBy`, which the fixture's `publicSource` helper holds
constant at `:86`; remove the boundary entry from local state and assert the
`discontinuous-source-chain` rejection, because that is the route's real fragility; and refuse
a non-advancing `issuedAt` as a negative control. The consumer accepts the happy path today,
so the predicate alignment that follows is tidying, and the extended pin is what holds
behavior across it.

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

**Inject the `faulted` case with a blob-store IO failure**, which is the outcome's one certain
cause (§5.1). Do not build it on a signer-key rotation. A rotation does return `faulted`, but
it throws out of `assertStateOwnership` in `loadState` before any head is read
(`source-writer.ts:547`, `:340-342`), and `append` loads state through the same `loadState`
(`:785`) — so a `faulted`-then-append-recovers assertion written against a rotated key cannot
pass, and a rotation exercises the writer's ownership guard rather than this method's error
path.

**Stage 3 — the legs.** The requester's regression test must be written before its
implementation: publish an association, advance the clock past the half-window, refresh, then
post a second association and assert the append succeeds. Without §5.4's state re-commit it
fails — but the stage must **observe which failure fires rather than assert a predicted one
blind**, because two are in play. The read-path throw is expected first: `append` loads state
at `source-writer.ts:785`, which on this leg runs `reconstructRequesterHistory`'s byte-wise
head comparison and raises `'requester source public head does not equal requester-source state'`
(`requester.ts:1353`). Only where that comparison has been relaxed — resolution (a) of §5.5 —
does execution reach `SourceWriterIntegrityError("announcement timestamp must strictly advance
the signed source head")` (`source-writer.ts:831`). Capture the actual failure, then pin it.

**That test is necessary and not sufficient.** It exercises a refresh that *completed*, which
the state re-commit does fix. It does not touch §5.5's crash window — the interval between the
head blob write and the state commit, in which the requester source is bricked outright.
Closing that is §10.1's third decision and is a
change to `reconstructRequesterHistory`, not a test. A crash-boundary case belongs in this
stage beside the regression: kill between the two writes, then assert the source is still
appendable.

**Stage 4 — the loop.** One `LOOP_REGISTRY` row (`head-refresh`, 300 000 ms, `always`), one
read accessor on `WatchdogLoop` for its stale set, one loop class, one config field. Naming
follows the five existing `*_INTERVAL_MS` loop knobs, and `0` is the kill switch.

**The knob does not belong in the `publicArchive` block, and v0.1 was wrong to put it there.**
That block is `{ enabled, host, port }` with `enabled` defaulting `false`
(`operator/src/config.ts:203-209`), and it gates the HTTP **listener**
(`operator/src/main.ts:2244`), not head minting — an operator can mint heads through the
durable writer while serving nothing over HTTP, so the claimed "serves nothing, inherits the
correct default for free" does not follow. `operator/src/daemon/native-fleet-serving-plane.ts:32`
also records a standing commitment for that block: "no new config keys.
`publicArchive.{enabled,host,port}` keeps its exact shape and meaning". The knob is therefore
a top-level field alongside the other loop intervals, where an operator already looks for a
loop's cadence.

`operator/test/architecture/loop-registry-narrowed.test.ts` pins the registry at exactly ten
rows and asserts set equality against its `REQUIRED` list. **It goes red the moment the row
lands.** Updating it is part of this stage, not a follow-up, and so are both documented
surfaces in `CLAUDE.md`: the "Remaining ten" line under §Architecture, and the config table,
which is the documented home of every `JINN_*` knob.

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
   own still refuses hard. Unit coverage of the `selfServed` discriminator in this shape does
   exist (`operator/test/daemon/native-discovery.test.ts:343` and `:601`); what does not is a
   **fleet-level** case. Those are unit tests with injected verifiers, where this one runs both
   operators' real archives over real HTTP — which is where a serving-plane wiring mistake
   would show and a unit test would not.

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
| `plugin/runtime/src/corpus/mirror.ts:76-77` | "the shape arrives from a conformant external source rather than from anything here (#2549)". |
| `plugin/runtime/src/corpus/sync-loop.ts:550-555` | "Per #2549 every in-tree publisher re-signs a head only after an append, so a correct but quiet feed accumulates head age indefinitely." Correct the rationale; note that promoting that row from reported to gating is now possible and is **not** done here. |
| `packages/discovery/protocol/src/verify/source-chain.test.ts:146-147` | "Both consumers now classify it before reaching this procedure" — there are three (§7). |
| `operator/test/daemon/native-discovery.test.ts:530-531` | "No in-tree publisher re-signs while idle, so the shape arrives from an external source." The fixture rationale that follows it stays true. |
| `docs/superpowers/specs/2026-09-01-publication-head-anchoring-design.md:116` (its §2, "Ground truth") | Its "dormant" characterization of the idle re-stamp hazard. Amend with a pointer to this record rather than retro-editing dated prose. |

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
- **Does not narrow §14.1's cold-start rollback residual, and leaves it continuously
  available rather than intermittently.** A source that idles and then appends leaves a
  superseded head that the heartbeat has kept inside `refreshBy`; a rollback mirror replaying
  it is accepted by a cold consumer for the remainder of that window, where today the same
  head has lapsed and is refused. The `2 × maxAheadMs` bound is unchanged (§2) and the two
  mitigations in §6.2 survive — the mirror-set comparison prefers the real head, and a
  returning consumer with a high-water mark is unaffected — but nothing here shrinks the
  residual. Closing it is the witness/gossip anchor §14.1 already names, and it is not this
  issue's. §6.2, §10.1 decision 1.
- **Does not cover a source whose process is alive but whose writes or serving are broken** —
  a full or read-only blob store, an unreachable archive listener, a persistently throwing
  append. Such a source can still mint a head, so the heartbeat re-signs on schedule while the
  archive behind that head is unusable, and a peer cannot tell it from an honestly idle
  source. Today the lapsing `refreshBy` surfaces that fault within 24 hours; after this change
  nothing does. No `LOOP_REGISTRY` row supervises either path and a retrying loop still stamps
  its heartbeat, so the §6.3 gate does not catch it (§6.2). Covering it needs a liveness oracle
  over the write and serve paths specifically — separate work, and not this issue's. This is
  stated as a non-goal rather than left implicit, because §10.1's second decision is a ruling
  about what the gate covers.
- **Does not make a source provably live.** A fresh head proves the source is being
  maintained by something holding its key, on a host whose clock is within one window. It
  does not prove the operator is doing work, and §6.3 is written so that it does not pretend
  to.

## 10. What the operator rules on, and what this record decides

### 10.1 Decisions that need a ruling

**1 — Does a scheduled heartbeat weaken `refreshBy` as the protocol's only withholding
signal, and do we accept that?** *Recommended: accept.* This is the root question, and every
decision below is downstream of it. `refreshBy` is the one thing in the protocol that says
"this source is not withholding". A source that re-signs on a timer asserts that continuously,
and therefore asserts it in some conditions where it is not strictly earned. **There are three
such conditions and the ruling should be made against all three**, because each was found by a
separate pass over the code and no argument here bounds the set:

1. **A wedged loop** — the process is alive and re-signing while a supervised loop is stuck.
   This is the one the §6.3 gate closes, at five-minute resolution rather than twenty-four-hour.
2. **Broken writes or serving** — a full or read-only blob store, an unreachable archive
   listener, a persistently throwing append. The source can still mint a head, the gate does
   not see it, and the lapsing `refreshBy` that used to surface it within 24 hours is removed
   with nothing in its place. Decision 2 is framed so this is ruled on knowingly. §6.2, §9.
3. **A superseded head retained by a rollback mirror** — a source that idles and then appends
   leaves behind a head the heartbeat has kept fresh, so §14.1's cold-start rollback residual
   becomes continuously available for that source rather than intermittently. The
   `2 × maxAheadMs` bound is unchanged; the frequency of sitting near it is not. §13.3's
   mirror-set comparison still prefers the real head wherever the real source is reachable,
   and a returning consumer with a high-water mark is unaffected — so this is a caveat to rule
   on, not a defect that changes the recommendation. §2, §6.2, §9.

Three alternatives were considered and none is recommended. **No heartbeat, plus a tighter
`refreshWithinMs` profile** shortens every consumer's tolerance rather than lengthening any
producer's honesty, and makes round-10 more frequent, not less. **An on-demand refresh
triggered by an inbound fetch of a lapsing head** makes the signal depend on being asked, and
hands a partitioned source a way to look live to whoever can still reach it. **A heartbeat
that refuses after N consecutive no-append cycles** re-introduces round-10 on a longer fuse,
for exactly the population that is honestly idle.

The reason to accept is the one §0 states: an expired head is a withholding signal, and an
idle source is not withholding. **If this is answered no, everything below is moot** —
decisions 2, 3 and 4 exist only to bound a heartbeat that exists.

**2 — The gate is watchdog staleness, not daemon readiness (§6.3, §6.4).** *Recommended: yes.*
This is the one place the two independent design passes disagreed. Gating on readiness as well
would make a degraded-but-serving operator un-joinable to new peers — round-10 again, through
a different door, for exactly the population `self-source-stale` exists to protect. A degraded
operator is alive, reachable, serving, and withholding nothing. The watchdog keeps the
withholding signal for the case where it genuinely means "dead", at five-minute resolution
rather than twenty-four-hour.

Rule on it knowing what it does **not** catch. The watchdog supervises ten named loops. It
does not supervise the serving plane or the append path's health, and a loop that catches its
own error and retries still stamps its heartbeat. So a source whose writes or serving are
broken passes this gate and gets its head re-signed on schedule, and a peer loses the one
signal — the lapsing `refreshBy` — that used to surface it (§6.2, §9). The gate covers a
wedged loop. It is not a general liveness oracle and this record does not present it as one.

**3 — How the requester crash window is closed (§5.5).** *Recommended: (a).* A crash between
the head blob write and the state commit leaves the requester source unable to append, ever,
because `reconstructRequesterHistory` compares the stored head to its own recorded head
byte-wise. The three resolutions are **(a)** align that check with `assertHeadMatchesState` —
compare `origin`, `sequence` and `entry` rather than the whole head; **(b)** add a refresh
intent for the requester leg, a fifth journal shape; **(c)** put the blob write and the state
commit inside one durable transaction.

(a) is recommended because it is the minimum that makes the invariant match what the head
actually means at that position, and because it is the same comparison the generic writer
already trusts on the other two legs. **What it costs, plainly:** the requester stops
detecting a head whose `issuedAt` has drifted from its own state — which is precisely the
drift a refresh legitimately introduces, and therefore precisely the check that cannot survive
a heartbeat unchanged. **State the loss whole, because a ruling on a persistence invariant
should not be made against half of it.** The clause is direction-blind, so dropping it also
stops the requester detecting a *backwards*-drifted stored head — one whose `issuedAt` or
`refreshBy` has gone down relative to the state's own record. That is not drift a refresh
introduces, and after (a) the producer stops failing closed on it and simply continues; what
catches it is downstream, where peers hard-refuse a non-advancing `issuedAt` as
`rewound-or-tampered-head` (§3). The residual risk is small either way — the writer's
strict-advance check reads the blob (`source-writer.ts:821-832`), so the append floor is
blob-derived rather than state-derived — but it is a real loss and it belongs in the ruling.

What survives is the position triple: the comparison that remains
(`requester.ts:1350-1352`) covers `origin`, `sequence` and `entry`, three of `SourceHead`'s
six fields (`packages/discovery/protocol/src/head.ts:10-17`), and the envelope and
canonicalization checks around it (`:1348`, `:1355-1360`) are untouched. Of the three fields
it stops comparing, `protocol` is separately pinned and is **not** part of the loss:
`SourceHeadSchema` declares it `z.literal(RECORD_DISCOVERY_VERSION)`
(`packages/discovery/protocol/src/head.ts:29`), so `parseSourceHead` refuses a wrong-valued
one at `requester.ts:1347`, a line above the clause under discussion. The loss is `issuedAt`
and `refreshBy`, in both directions. This is a change to a persistence invariant on the
operator's most awkward leg, which is why it is a ruling and not a build detail.

**4 — With the watchdog disabled, the heartbeat runs ungated (§6.3).** *Recommended: yes, run
ungated and document it.* An operator running without a watchdog gets a heartbeat with no
liveness oracle at all — a masking hazard installable by configuration, and one that belongs
in a decision rather than in a note on a config field. The alternative is to refuse to refresh
when no watchdog is present; it fails closed, and it makes the gate's absence loud rather than
silent. The recommendation goes the other way for the same reason §6.4 rejects the readiness
gate: an operator who has declined the daemon's liveness supervision has not thereby become a
withholding source, and making them un-joinable to every new peer is a worse outcome than the
masking it prevents. Whichever way this is ruled, it should be ruled rather than defaulted.

**5 — #4187's own acceptance criteria are amended (§2, §6.1).** *Recommended: adopt both
corrections.* AC1 asks this record to state that a re-sign changes "issuedAt only";
`head.ts:97-98` recomputes `refreshBy` from the new `issuedAt`, and that re-basing is the
entire mechanism — a re-sign that moved `issuedAt` alone would leave the head lapsing on its
original schedule, and round-10 would recur unchanged. AC3 asks the record to show the
self-source degrade "keeps refusing" a genuinely stale self-served head;
`operator/src/daemon/native-discovery.ts:846-851` returns `self-source-stale` for exactly that
shape, and it is a **peer's** stale head that refuses hard, at `:853`. Both corrections are
factually right against the code, and building to the uncorrected criteria would propagate an
error into the design's central mechanism. But amending the criteria changes what "done" means
for this issue, and that scope call belongs to the person who filed it rather than to the
record answering it. §8 Stage 0 executes the amendment once it is accepted.

### 10.2 Calls this record makes

These are recorded so the operator can override them, not put up for adjudication. The second
and third are settled by a mechanical fact about the code rather than by a tradeoff, and asking
for a signature on a settled engineering call spends a ruling that §10.1 needs. The first is
mixed: level-triggering versus a deadline is settled by argument, but **the fraction and the
tick are tuning defaults**, not facts about the code, and an operator may set either
differently without disturbing anything else in this design.

**The half-window level trigger, checked on a 300 000 ms tick (§4)** — the shape is a call,
the two numbers are tunable defaults. The alternatives are a deadline timer — fragile against
process restart, host suspend, and the very wedge conditions the loop must survive — and a
smaller fraction such as one third, which buys nothing that level-triggering does not already
buy. Half at a 24 h window is one re-sign per source per twelve hours.

**The primitive is a fourth `DurableSourceWriter` method (§5.1).** `maintainHead` never reads
the writer's committed state, so a stale `prevHead` installs a head at a position the writer
no longer holds — one its own `assertHeadMatchesState` then refuses. An empty-batch `append`
through the existing method does not carry either: `AppendAnnouncementCommand.announcement` is
required, and an announcement advances `sequence`, which makes the result a chain claim rather
than the same-position revalidation shape #3468 admits. Both alternatives are refused by a
fact about the code, not by preference. §5.5's crash window makes the *contents* of the fourth
method a live question — §10.1's third decision — but not its existence.

**The third consumer is pinned before the producer is armed (§7, §8 Stage 1).** This is a
sequencing step that Rule 4 already implies, not a decision, and putting it to a ruling invites
the answer "skip it", which is the wrong offer to make. Its happy path is pinned accepting
(`sync.test.ts:281-288`); its re-based-window shape and both failure branches are not. The cost
is extending one existing test.

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
3. **A signer-key rotation hard-wedges a durable source writer, with no in-writer recovery
   path.** `assertStateOwnership` throws on a `signerKeyId` mismatch out of both `loadState`
   and `readState` (`packages/discovery/serve/src/source-writer.ts:547`, `:951`, throwing at
   `:340-342`), so `append` is wedged too (`:785`) and nothing in the writer re-mints the
   source's state or head under the new key. Pre-existing and unrelated to the heartbeat —
   found while tracing this design, and worth its own issue.
4. **Consider a conformance-kit case for the idle re-sign.** `maintainsFreshness` in
   `packages/discovery/serve/src/head.ts` already checks a succession of heads; nothing exercises
   it against a producer that re-signs on a schedule.
