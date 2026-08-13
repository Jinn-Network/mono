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

2. **Pick the rewind target — the narrowest one that covers what you are recovering.** One block
   *below* the earliest event you need re-offered, and no further. The drop log line names the event
   and its block (`… (VerdictDeliveryClaimed at block 45420025) -- dropping`), so
   `--to-block 45420025 - 1` is read straight off it.

   It must also sit **below the persisted `finalized_block_number`**; the tool refuses otherwise.

   **For requester-side adoption, "the earliest event you need" is `TaskCreated`** — the
   whole-lifecycle rewind is the correct target, not an over-reach. A requester adopting a delivery
   another operator produced needs its whole attempt log rebuilt: `TaskCreated`,
   `TaskAttemptCreated` (which is what emits `attempt-engaged`), `SolutionDeliveryClaimed` (which is
   what emits `delivery-recorded`), then the verdict. A rewind that starts after `TaskCreated`
   leaves the attempt without its engagement and `observe()` still fails.

   > Earlier revisions of this runbook warned that the wide rewind *cannot* produce
   > `delivery-recorded` on a requester and *writes a false rejection* into the canonical log. Both
   > were true before #2644 and are no longer. The requester now resolves the counterparty's
   > published Delivery record off the record plane and re-checks it against the coordinator's own
   > keccak anchor, so `SolutionDeliveryClaimed` yields a real `delivery-recorded`; and a requester
   > that cannot resolve it **drops** the event rather than emitting
   > `rejected`/`invalid-reference`. Do not carry the old warning forward.

   What is still true, and still costs you if ignored:

   - **A replay is one-shot per range.** Every block in the window is journalled on the replay tick —
     and therefore suppressed forever by `hasCanonicalEvent` — even if that tick then fails to
     announce. The wide rewind spends the whole lifecycle in one shot. Re-read the "What the replay
     it causes writes" table before typing `--apply`.
   - **A requester still never sees the counterparty's mech `Deliver`.** That has not changed
     (`create-base-venue.ts` subscribes the router, the coordinator, the marketplace, and *this*
     operator's own `priorityMech`). What changed is that the record plane now supplies the witness
     instead, so the missing `Deliver` is no longer fatal to the fold.

   **PRE-FLIGHT — mandatory, and do it BEFORE stopping the daemon.** The replay re-offers the range
   to the *current* resolvers exactly once. If a record is unresolvable at that moment the event
   drops — recoverably now, but only by spending another rewind. Both serving planes must be up and
   serving the exact records, with bytes that match their digests:

   ```bash
   # The counterparty's plane — the solution Delivery record it published.
   curl -sS http://127.0.0.1:7402/records/<delivery sha256> | shasum -a 256
   # This operator's own plane — the Task record the projector's digest join fetches back.
   curl -sS http://127.0.0.1:7401/records/<task sha256> | shasum -a 256
   ```

   Each must return 200 **and** hash to the digest in its own path. A 200 serving the wrong bytes is
   worse than a 404: the resolver refuses it and you have spent the rewind either way.

   **Confirm RPC health too, immediately before `--apply`.** The requester's role gate reads the
   coordinator twice per `SolutionDeliveryClaimed`, and `buildReadTodayDeliveryFacts`
   (`client/src/daemon/composition-root.ts`) currently returns `undefined` on a read *failure* the
   same way it does for a requestId that genuinely is not ours. That reads as "not the requester",
   which is the one remaining path to a false rejection. Round-trip both reads against the
   configured endpoint first:

   ```bash
   cast call <coordinator> 'getRequestRef(bytes32)(uint256,uint32,bool)' <requestId> --rpc-url <rpc>
   cast call <coordinator> \
     'getAttempt(uint256,uint32)((uint256,uint32,address,bytes32,bytes32,uint256,uint32,uint8))' \
     <taskId> <attemptIndex> --rpc-url <rpc>
   ```

   Both signatures carry their **output** types on purpose. `cast call` prints raw returndata when
   the return signature is omitted, and `getAttempt` returns a struct — without the tuple you get an
   undecoded blob and have to count 32-byte words to find the field you came for. The tuple is
   `AttemptRecord` as declared in `client/src/daemon/composition-root.ts`'s `GET_ATTEMPT_VIEW_ABI`:
   `(taskId, attemptIndex, operator, requestId, solutionCidDigest, solutionWeight, verdictCount,
   status)`.

   `getRequestRef` must return `exists = true` with your `(taskId, attemptIndex)`, and `getAttempt`'s
   **5th field**, `solutionCidDigest`, must be the non-zero anchor you are hunting the record for —
   decoded output looks like
   `(1236, 0, 0xc679BD…, 0x594af10a…, 0x743a947f…, 1000000000000000000, 1, 4)`. A revert, a timeout
   or a 429 here means **do not apply yet** — the replay is one-shot, and a flaky read spends it. See
   PR #2644's body follow-up 9 on gate 1's chain-read leg for the structural fix.

   The delivery digest is not on the coordinator (today generation anchors only its keccak), so read
   it off the counterparty's catalog. If the daemon already tried and dropped, its log names both the
   role and the anchor to search for:

   ```
   [projector-enrich] role=requester DROPPING SolutionDeliveryClaimed for task 1236 attempt 0
     (requestId 0x…, anchor 0x…): no record-plane Delivery witness -- …
   ```

   Live example from the two-operator gate (#2644): `http://127.0.0.1:7402/records/ed1ba7ab…908c`
   for the delivery and `http://127.0.0.1:7401/records/c0c3d703…1204` for the task.

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
resolved — the requester's association has not published yet, a serving plane is down — it drops
again, and the range must be replayed once more after the record is available. This is why step 2's
pre-flight is mandatory rather than advisory.

**A requester cannot witness the counterparty's mech `Deliver`.** No rewind width fixes that — it is
a subscription-set question (`create-base-venue.ts`), not a cursor question. Since #2644 the record
plane supplies the witness in its place, so this is a fact about where the bytes come from, not a
ceiling on what a requester can fold. A requester that cannot reach the record plane drops the
`SolutionDeliveryClaimed` and leaves it replayable; it does not write a rejection.
