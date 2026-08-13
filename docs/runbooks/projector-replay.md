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

## What the procedure touches

Exactly one row, in the venue state file (`<stateDir>/venue.db`):

| table | rows | columns written |
| --- | --- | --- |
| `log_cursors` | 1 — `WHERE stream = 'venue:<chainId>:<jinnRouter>'` | `live_block_number`, `live_block_hash`, `finalized_block_number`, `finalized_block_hash`, `updated_at_ms` |

Nothing else is written or deleted. Not `scanned_block_hashes`, not `orphaned_blocks`, and none of
the projector's own tables in `jinn.db` (`projector_cursor`, `projector_observations`,
`projector_canonical_events`, `projector_availability_journal`).

**No signed material is touched.** A block cursor is operational state — a record of how far a scan
got — not an attestation. Rewinding it asserts nothing; everything downstream is re-derived from the
chain and re-verified against its digests. `projector_cursor` is deliberately left alone so the
announcement head chain (`sequence`, `entry_digest`, `head_json`) stays append-only and correctly
linked across the replay, and so canonical events that were already published stay suppressed by
`hasCanonicalEvent` instead of being announced twice.

Both cursor marks are set to the rewind point because the schema's own CHECK refuses a finalized
mark ahead of the live cursor. That regression is transient: the next `poll()` recomputes
`checkpoint = max(chain finalized, persisted finalized)` and restores the live height.

## Procedure

1. **Stop the daemon.** It holds the same SQLite file; a rewind landing mid-tick races the poll that
   is about to overwrite it.

2. **Pick the rewind target.** One block *below* the earliest block you need re-offered. To recover a
   whole task lifecycle, use the block before its `TaskCreated`; to recover only a settlement, the
   block before that settlement. The drop log line names the event and its block
   (`… (VerdictDeliveryClaimed at block 45420025) -- dropping`).

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
- **no canonical block hash for the target** — it will not write a hash the chain did not confirm,
  because the next `poll()` would read the mismatch as a reorg and roll back on a fiction.

## Known limitation

The replay re-offers the range to the *current* resolvers. If an event's signed record still cannot
be resolved — the requester's association has not published yet, the record plane is down — it drops
again, permanently, and the range must be replayed once more after the record is available. Confirm
the record is resolvable *before* replaying.
