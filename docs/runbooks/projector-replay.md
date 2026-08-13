# Runbook — re-projecting an already-swept block range

**When to use this.** A marketplace event that should have produced an announcement or a canonical
observation did not, and the projector's cursor has already moved past its block. Symptoms: a
`[projector-enrich] … -- dropping` line in the daemon log; `projector_observations` /
`projector_canonical_events` empty (or missing the event) while the chain plainly carries it; a
requester-side adoption that never fires because `descriptor.derived.deliveries` is empty.

**Why waiting does not help.** A dropped event is never re-offered. `ChainLogSource.poll()`
(`packages/marketplace/venue-base/src/log-source/chain-log-source.ts`) commits its advanced block
cursor inside its own transaction *before* it returns the logs, so each log reaches
`ProjectorLoop.tick()`'s `enrich` exactly once, ever. Fixing the resolver is necessary but not
sufficient — the range has to be deliberately re-offered.

**Why deleting the cursor row does not work.** `poll()`'s cold-start branch resumes at
`options.startBlock ?? finalized.blockNumber`, and nothing in this repository ever sets
`startBlock`. A wiped `log_cursors` row therefore jumps to the **current finalized head** and skips
the range a second time, silently. There is a regression test pinning exactly this
(`client/test/daemon/projector-replay.test.ts`, "DELETING the cursor row skips the range").

## What the rewind itself writes

Exactly one row, in the venue state file (`<stateDir>/venue.db`):

| table | rows | columns written |
| --- | --- | --- |
| `log_cursors` | 1 — `WHERE stream = 'venue:<chainId>:<jinnRouter>'` | `live_block_number`, `live_block_hash`, `finalized_block_number`, `finalized_block_hash`, `updated_at_ms` |

The rewind writes nothing else and deletes nothing. Not `scanned_block_hashes`, not
`orphaned_blocks`, and none of the projector's own tables in `jinn.db` (`projector_cursor`,
`projector_observations`, `projector_canonical_events`, `projector_availability_journal`).
`projector_cursor` is deliberately left alone so the announcement head chain (`sequence`,
`entry_digest`, `head_json`) stays append-only and correctly linked across the replay, and so
canonical events that were already published stay suppressed by `hasCanonicalEvent` instead of being
announced twice.

**The rewind signs nothing.** A block cursor is operational state — a record of how far a scan got —
not an attestation.

Both cursor marks are set to the rewind point because the schema's own CHECK refuses a finalized
mark ahead of the live cursor. The *live* regression is transient: the next `poll()` recomputes
`checkpoint = max(chain finalized, persisted finalized)` and restores the live height. The
*finalized* regression is why the target must sit **below** the persisted finalized mark — that same
monotone recompute would make an *advance* of it permanent, and the tool refuses such a target
(see "It refuses rather than guesses").

## What the replay it causes writes

This is the larger set, and it is the part worth reading before you type `--apply`.

The rewind is inert until the daemon restarts. From then on the replay is an **ordinary projector
tick over a range that has already been swept once**, and every writer downstream of `poll()` runs
again over it:

| writer | when | what a replay does to it |
| --- | --- | --- |
| `teeNativeMarketplaceEvents` → `native_marketplace_events` | **inside `poll()`**, before the projector sees a log | Rows carry the finality tier the log was *first fetched at*. A replayed range is refetched below `finalized` (catch-up fast path), so rows first written `safe` come back `finalized`. `apply()` **upgrades the tier in place**. Before that fix it threw, and since `apply()` is one transaction the throw discarded the **whole batch** — including the newly mined blocks above the old cursor, which are never re-listed. |
| projector loop → `projector_canonical_events`, `projector_observations`, `projector_cursor` | after `enrich` | Journals the re-offered events and advances the cursor. **This makes a replay one-shot per range**: `hasCanonicalEvent` then suppresses those events forever. The journal write happens *even when announcement publication throws* (`projector-loop.ts`'s announce-failure catch path returns empty announcements and falls through to the same `cursorStore.write`). A range that journals but fails to announce is spent — rewind again to retry. |
| `anchorCheckedMaterial` / requester adoption | during announcement projection | No per-record `try`/`catch`. One record that cannot be anchored aborts the rest of that tick's announcements — and, per the row above, that tick's events are journalled anyway. |

None of that is signed material written *by the rewind*. It is signed material the daemon may now
publish because it can finally see the events — which is the point of the procedure, and also why
**the narrowest workable target is the recommended one** (next section).

## Procedure

1. **Stop the daemon.** It holds the same SQLite file; a rewind landing mid-tick races the poll that
   is about to overwrite it.

2. **Pick the rewind target — the NARROWEST one that covers the event you lost.** One block *below*
   that event, and no further. The drop log line names the event and its block
   (`… (VerdictDeliveryClaimed at block 45420025) -- dropping`), so `--to-block 45420025 - 1` is
   read straight off it.

   It must also sit **below the persisted `finalized_block_number`**; the tool refuses otherwise.

   **Do not reach for the whole-lifecycle rewind** (the block before `TaskCreated`) just because it
   sounds more thorough. On a requester it is worse than narrow *and it does not buy what it looks
   like it buys*:

   - **It cannot produce the `delivery-recorded` observations adoption wants.** That observation is
     emitted from `SolutionDeliveryClaimed` only when the router claim is corroborated by the
     counterparty's mech `Deliver` — and a requester never subscribes to the counterparty's mech
     (`create-base-venue.ts` subscribes the router, the coordinator, the marketplace, and *its own*
     `priorityMech`). The `Deliver` is structurally not in its log stream. Widening the rewind
     re-offers the same blocks it already cannot interpret.
   - **It writes a FALSE REJECTION into the canonical log.** With no pending mech delivery for the
     requestId, `observe.ts` takes the `mechDelivery === undefined` branch and emits an
     `attempt-terminal.v1` of `rejected` / `invalid-reference` ("no external Mech Deliver fact for
     router requestId"). Land that beside the verdict's own terminal and the attempt folds
     `contradictory` — which `adoptPostedTask` then refuses outright. The wide rewind can convert a
     merely-unadopted attempt into a permanently unadoptable one.
   - **It maximizes the one-shot surface.** Every extra block is more events journalled — and
     therefore suppressed forever — on a tick that may still fail to announce.

   Widen only when you have a specific event outside the narrow window that you know this operator
   can interpret, and re-read the "What the replay it causes writes" table first.

3. **Dry run.** It prints the current row, the row it would write, and the range that would replay.
   Nothing is written.

   ```bash
   cd client
   yarn projector-replay \
     --state ~/.jinn-client/venue/venue.db \
     --rpc https://base-sepolia.publicnode.com \
     --chain-id 84532 \
     --router 0x6f47863ac4120a5a97af224a5e30c3ec2c9ea247 \
     --to-block <target>
   ```

   The stream key defaults to `venue:<chain-id>:<router lowercased>`; pass `--stream` if the host
   overrode `ChainLogSourceOptions.stream`.

   Read the dry-run output. `replays blocks A..B` is the range whose events will be journalled —
   and therefore spent — whether or not they announce.

4. **Apply.** Re-run the same command with `--apply`.

5. **Restart the daemon** and watch the projector. The next tick re-fetches
   `(target, finalized]` and re-offers every log in it to `enrich`.

6. **Verify.** Rows should appear where there were none:

   ```bash
   sqlite3 ~/.jinn-client/jinn.db \
     'SELECT COUNT(*) FROM projector_observations;
      SELECT COUNT(*) FROM projector_canonical_events;
      SELECT sequence FROM projector_cursor;'
   ```

   A non-zero `sequence` means announcements were emitted.

## It refuses rather than guesses

The tool fails closed on every ambiguity, and each refusal names the row and the reason:

- **no `log_cursors` row for the stream** — it will not create one, because a created row cold-starts
  at head. Check the stream key.
- **target at or above the live cursor** — a rewind must go backwards; advancing here would skip
  unscanned blocks outright.
- **target at or above the persisted finalized mark** — the rewind writes *both* marks, so such a
  target would ADVANCE the durable finalized checkpoint rather than rewind it, and `poll()` never
  moves that mark back (`checkpoint = max(chain finalized, persisted finalized)`). Every block in
  `(old finalized, target]` would become permanently unrollbackable, so a later reorg through that
  span could no longer be retracted. A replay re-reads history; it must never assert finality about
  it.
- **no canonical block hash for the target** — it will not write a hash the chain did not confirm,
  because the next `poll()` would read the mismatch as a reorg and roll back on a fiction.

## Known limitations

**A replay is one-shot per range.** The projector journals the re-offered events and advances its
cursor on the same tick, *including* the tick where announcement publication throws. Once journalled,
`hasCanonicalEvent` suppresses those events for good. If the replay tick fails to announce, rewind
again — do not wait for it to retry, because it will not.

**It re-offers the range to the *current* resolvers.** If an event's signed record still cannot be
resolved — the requester's association has not published yet, the record plane is down — it drops
again, permanently, and the range must be replayed once more after the record is available. Confirm
the record is resolvable *before* replaying.

**A requester cannot witness the counterparty's mech `Deliver`.** No rewind width fixes that; see
step 2. It is a subscription-set question (`create-base-venue.ts`), not a cursor question.
