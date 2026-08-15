# Task 6 — Incremental native discovery and canonical reorg corrections

Completed on `codex/phase-b-native-operator` in two bounded commits:

- `c1f9fe77d feat(client): checkpoint verified native discovery`
- `eff5078f9 feat(projector): append canonical reorg corrections`

## Native discovery / WorkLoop

- Added a durable per-source checkpoint carrying source identity, sequence, entry digest, and the exact accepted signed Head high-water.
- First adoption uses cold sync; subsequent boots use returning sync from the persisted `(sequence, entryDigest)` cursor. Accepted cards are a durable local queue, acknowledged only after a completed WorkLoop pass.
- Native WorkLoop consumption is isolated from the legacy adapter. The explicit legacy branch retains `archive.since('')`; native mode never reaches it.
- Signed heads and entries gate every native card. A byte-identical Head is still revalidated for signer freshness/revocation and local `refreshBy` expiry before it counts as verified/no-work.
- Durable admission verifies that the *terminal fetched entry* has both the exact advertised sequence and digest before the injected verifier/card decoder can move the checkpoint.
- Queue tests cover duplicate archive-page entries, stale/unauthorized heads, no-change polls, exact restart return cursor, SSE resume, unacknowledged replay, and acknowledged-card non-redelivery.

## Canonical reorg handling

- Venue state schema v4 adds `scanned_block_hashes`: a persisted block-number/hash history, including empty blocks. Its reorg transition atomically records the whole displaced suffix, marks the prior canonical rows orphaned, records replacement hashes, writes the orphan audit rows, and updates the cursor in one `VenueStateDatabase` transaction.
- The v3→v4 migration is additive and retains existing cursor and outbox data. History pruning is strictly below the finalized boundary; the boundary row remains.
- `ChainLogBatch.reorg` now exposes an explicit `canonicalRebuildBoundary` plus exactly the block hashes proven displaced after comparing retained hashes against replacement-chain hashes.
- Projector cursor storage now journals canonical admitted events and active availability actions. On a reorg it reconstructs state by reducing retained events through the finalized boundary, replays the rescan, and marks local event provenance orphaned without mutating archive history.
- Every active availability whose exact origin hash is displaced receives one signed append-only `withdrawn/reorged` announcement. Availability IDs include block hash, so a replacement block at the same transaction/log position cannot collide with the original historical announcement.
- Replaying preserved post-boundary events rebuilds state but does not republish them. Replacement events publish normally after corrections.
- Archive/head readback recovers publication that finished before the projector cursor transaction: a restart recognizes the immutable already-published retraction, records it locally, and does not append a duplicate correction.

## Verification

All commands used Node `v22.23.1` / npm `11.19.0`.

- `yarn --cwd client vitest run test/daemon/native-discovery.test.ts test/daemon/work-loop.test.ts --reporter=dot` — 27 tests passed.
- `yarn --cwd packages/marketplace/projector vitest run src/announce.test.ts src/finality.test.ts --reporter=dot` — 38 tests passed.
- `yarn --cwd packages/marketplace/venue-base vitest run src/log-source/chain-log-source.test.ts src/log-source/cursor-store.test.ts src/state/database.test.ts --reporter=dot` — 26 tests passed.
- `yarn --cwd client vitest run test/daemon/projector-loop.test.ts test/daemon/projector-cursor.test.ts test/daemon/projector-log-source.test.ts --reporter=dot` — 29 tests passed.
- `yarn --cwd packages/marketplace/projector typecheck`
- `yarn --cwd packages/marketplace/venue-base typecheck`
- `yarn --cwd client tsc --noEmit`
- `git diff --check`
- `yarn --cwd packages/marketplace/projector test` — 156 tests passed.
- `yarn --cwd packages/marketplace/venue-base test` — completed successfully.

The focused projector coverage includes single- and multi-block forks, an empty displaced block, exact one-withdrawal-per-active-availability assertions, repeated/restarted no-duplicate behavior, and a simulated archive-published/cursor-transaction-crash recovery.

`pack:smoke` was attempted for projector and venue-base. Its dependency-pack stage reached the
new package archives, but its nested npm consumer ran under the shell's Node 20.10.0 and failed
(`node:util.styleText` is unavailable there). The implementation checks above all used the
required Node 22.23.1 runtime; no source failure was reported by the package smoke itself.
