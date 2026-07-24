# Bridge Derivation Run v0 Design

**Date:** 2026-07-20
**Issue:** [#1830](https://github.com/Jinn-Network/mono/issues/1830)
**Shape:** `feat`
**Base:** `origin/next` at `03dd6f75ae73898864021021aa03c46bd90bfb4e`

## Scope

Finish the historical execution-ledger bridge so a bounded dry run or a complete
run can derive canonical `jinn.episode.v1` records from immutable attempt and
verdict history. A derived record must carry typed transcript spans when a
snapshot can be parsed, degrade to patch plus verdict when it cannot, declare
`provenance: derived-from-history`, remain substrate-only, pass the held-out
gate before any publication side effect, and use the merged B5 manifest
publisher for anchoring and receipt-backed gas persistence.

The run remains an offline/local implementation and verification task. It must
not contact production services, publish records, or broadcast chain
transactions. The separately authorized live Base Sepolia residual on #1829 is
out of scope.

## Repository Findings

The secure spine already exists on the base:

- `bridge-verdict-source.ts` pages Ponder's `verdictEnvelopeMetas` in
  1,000-row pages and retains both clean verdict polarities.
- `bridge-fetch-evidence.ts` performs the authenticated
  verdict→task→attempt→solution join, verifies publisher identity and signed
  hashes, and treats snapshot enrichment as best effort.
- `bridgeAttempts()` applies exact instance and derived-repository held-out
  exclusion using the authenticated task identity before constructing or
  publishing a record.
- `publishManifestBatch()` partitions members, anchors each manifest through
  B5, and persists confirmed `gasUsed` and `feeWei` with recovery facts.
- B1's canonical `retrievalVisible` field defaults false, and the bridge never
  emits `retrieval:visible.v1`.
- C11's `jinn.episode.v1` contract carries the task, verifier, generator,
  distribution, grouping, and unified verification-strength facts the bridge
  needs.

Three gaps remain:

1. `toBridgeCapturedTask()` labels historical output `contributed`; the
   CapturedTask, Episode v1, and indexer-lite provenance vocabularies do not yet
   admit `derived-from-history`.
2. Snapshot stdout is reduced by `transcript-outline.ts` to one
   `solver:trajectory` tool-call step. This discards the same typed
   `jinn.agent_turn` / `jinn.tool_call` output and parser provenance that the
   #1473 live path already emits.
3. Although the source itself pages, `distill run` applies a default
   2,000-attempt cap. The current ledger exceeds that, so a default run is not a
   complete immutable-ledger walk.

## Approaches Considered

### 1. Move the canonical stream parsers into core and reuse them

Extract the pure Claude stream-json and Codex exec-json parser implementations
to `@jinn-network/core/trajectory`, add an in-memory `parseText()` entry point,
and retain the existing client imports as compatibility re-exports. The bridge
can then parse the transcript bytes already recovered from the snapshot without
a temporary file or a new harness-layer→client seam.

This is the chosen approach. It has one parser implementation, follows the C5
package direction, and lets live and historical paths record the same
source-format/parser/version triplet. The cost is a controlled parser move and
conformance coverage across core, client, and bridge callers.

### 2. Inject a client-owned parser port into the bridge

Keep the parser implementations in `client/src` and add a
`parseHistoricalTranscript` dependency to every bridge composition root.

This avoids moving code but is rejected because the current CLI is itself in
harness-layer. Wiring the production parser would either add a forbidden
harness-layer→client import or push bridge-specific composition into unrelated
client entry points. It also leaves the parser outside the domain package that
now owns trajectory parsing.

### 3. Add bridge-specific parsers beside `snapshot-transcript.ts`

Parse the two JSONL formats directly inside harness-layer.

This is rejected because the old outline path already demonstrated the failure
mode: two implementations of the same source formats diverge. Parser identity
and version would become labels on independently evolving behavior rather than
an auditable statement that history and live capture use the same parser.

## Design

### Canonical in-memory parser contract

`@jinn-network/core/trajectory` will own the Claude and Codex stream-to-span
implementations and the shared attribute helpers. Each parser keeps the existing
file-based `parse(path)` method for live capture and adds `parseText(text)` for
already-recovered historical bytes. `parse(path)` remains a non-throwing file
adapter over `parseText(text)`.

Every parsed span keeps:

- `jinn.span.kind` as `jinn.agent_turn` or `jinn.tool_call`;
- `jinn.transcript.sourceFormat`;
- `jinn.transcript.parser`;
- `jinn.transcript.parserVersion`;
- the existing bounded message/tool attributes and tool-result facts.

The client modules become compatibility re-exports, so the live engine,
backfill script, and existing tests consume the same classes without API drift.

### Snapshot enrichment and degradation

`snapshot-transcript.ts` continues to verify the donation wrapper hash, enforce
the decompression bomb guard, and locate only the known stdout paths. The
evidence fetcher passes the recovered `{harness, jsonl}` to the matching
canonical parser.

`BridgeEvidence` carries typed historical spans, not an outline string. A
non-empty parse produces typed steps between the patch and verdict steps.
Missing artifacts, remote fetch failure, hash mismatch, corrupt archives,
unsupported Hermes history, or an empty/unparseable transcript all return no
typed spans. The record still emits the authenticated patch and evaluator
verdict and receives the existing `patch-only` tag. Snapshot failure never
weakens task/verdict authentication and never fails the batch.

The bridge maps parser span inputs into Episode v1 trajectory steps with stable,
per-record span identifiers and preserves parser provenance attributes. Parser
events/status do not expand the C11 step schema in this issue; the evidence
available in the same-schema trajectory remains in the canonical span
attributes, while the immutable raw snapshot stays the audit source.

### Provenance and serving tier

Add `derived-from-history` to the write/read provenance union in:

- the core CapturedTask contract;
- the plugin Episode v1 contract;
- the indexer's lightweight Episode/trace projection.

Historical bridge tasks always set that exact value. Existing
`contributed`/`imported` defaults and compatibility reads remain unchanged.

The bridge sets `retrievalVisible: false` through the existing capture
conversion and never emits the legacy retrieval distribution tag. Both facts
are asserted on the final `jinn.episode.v1` payload, not only the pre-capture
task.

### Complete paging and bounded dry runs

The verdict source will walk pages until `pageInfo.hasNextPage` is false, subject
to its explicit safety page ceiling. With no caller limit it returns the whole
walked corpus. `--limit N` remains the operator's deterministic bounded-slice
control and limits authoritative attempt tuples without spending the cap on
duplicate enrichment projections.

The CLI will stop imposing an implicit 2,000-row default. It passes a limit only
when the user explicitly supplies one. If the source reaches its safety page
ceiling while the indexer still advertises another page, it fails loudly rather
than reporting a complete run from a partial ledger.

### Held-out chokepoint and manifest anchoring

The authenticated evidence identity remains the only identity trusted for I1.
Exact-instance, same-repository, weak-suite, and lookup exclusions stay in
`bridgeAttempts()` immediately after the authenticated join and before
`toBridgeCapturedTask()`, capture, upload, or anchor. Untrusted enrichment
projections remain discovery hints only.

Manifest mode continues to collect only survivors of that chokepoint, hand them
to B5's manifest publisher, and copy confirmed receipt facts into
`BridgeResult`. This issue does not add a second anchor path or estimate gas.
Tests inject a manifest publisher with confirmed receipts and assert the exact
persisted/returned `gasUsed` and `feeWei` facts.

## Test Strategy

TDD proceeds in acceptance slices:

1. A 1,001+ row two-page source fixture must fail until the unbounded default
   walks past the first page; a still-open page at the safety ceiling must fail
   loudly.
2. Canonical parser conformance tests exercise `parseText()` and prove the
   existing file path delegates to identical output.
3. Snapshot evidence tests require typed Claude/Codex spans and the exact
   parser name/version; missing and corrupt snapshots require the patch-only
   degradation.
4. Bridge payload tests require `derived-from-history`,
   `retrievalVisible: false`, no legacy retrieval mark, typed trajectory order,
   and C11 schema acceptance.
5. Chokepoint tests plant held-out records beside clean records and assert no
   held-out candidate reaches either per-record or manifest publication.
6. A bounded, fully injected pipeline dry run joins verdicts, parses a snapshot,
   degrades another, partitions a manifest batch, and returns confirmed gas
   without any network, IPFS, or chain call.

Focused tests cover core trajectory parsing, plugin schemas, bridge source,
evidence fetch, bridge, manifest, pipeline, CLI, and indexer signal parsing.
Proportional completion verification adds core/plugin/client/indexer
typechecks, the relevant package test suites, client build, diff checks, and
security review.

## Invariants and Risks

- Immutable source records are never edited or superseded.
- No live infrastructure is contacted during implementation or verification.
- Held-out identity comes only from authenticated task facts.
- Snapshot parsing cannot promote unauthenticated facts or suppress a valid
  patch/verdict record.
- A manifest contains only post-gate records, and only confirmed receipts count
  as gas evidence.
- Existing contributed/imported readers remain backward compatible.
- The parser extraction must be a mechanical ownership move plus `parseText`;
  no source-format behavior changes are allowed without explicit conformance
  tests.
- C6 may relocate harness-layer after this base. Keeping the new reusable parser
  API in core and the bridge changes local to its package minimizes the
  eventual mechanical move.
