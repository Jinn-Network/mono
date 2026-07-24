# Impl-state sharing by codeDigest — spike follow-ups (#945)

> **For agentic workers:** This is a **spike close-out plan**, not a production TDD implementation plan. The finding was human-accepted and F0–F3 were filed on 2026-07-24. Implement each follow-up with `writing-plans` → `test-driven-development` → `executing-plans` / `subagent-driven-development`. Do **not** merge production client code under #945.

**Goal:** Close spike #945 with the human-accepted recommendation (complete voluntary HarnessCheckpoint + digest discovery; do not auto-pin on every delivery) and keep its filed follow-up Issue train explicit and executable.

**Architecture:** Reuse the ratified `HarnessCheckpoint` artifact (`packages/sdk/src/checkpoint.ts`, `jinn checkpoint publish|install`) as the network-legible source behind `codeDigest`. First register the immutable `learner-public.v1` hash/package profile and use it everywhere the learner digest or public package is derived. Then replace the empty-buffer and circular-manifest stubs with an immutable `harness.checkpoint.v2` plus a separate event-derived anchor receipt. Finally expose digest→checkpoint discovery, including the profile, via indexer + MCP.

**Tech Stack:** TypeScript client + `@jinn-network/sdk` checkpoint schema, IPFS pin path used by CLI, Ponder `harness_checkpoint` table, DiscoveryAPI / MCP, Vitest.

**Finding (Stage 1):** [`docs/superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md`](../specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md)

**Issue:** [#945](https://github.com/Jinn-Network/mono/issues/945)

## Global Constraints

- Spike #945 ships **docs only** (finding + this plan). No production `client/` / `packages/` runtime changes under the spike PR.
- Follow-up work targets base `next`; Issue Types and PR titles use handbook shapes (`design` / `docs` / `feat`).
- Recommendation spine is **Option B** (complete HarnessCheckpoint). Option A (CID-on-delivery) and corpus `search_records` ranking of checkpoints are **deferred**.
- Economics v0 = **free + attributed**; no x402 checkpoint pricing in the first feat train.
- Integrity always means resolve a supported named profile, require the manifest's canonical ignore list to match it, validate roots, and re-run `hashImplStateDir` — never trust CID alone.
- `learner-public.v1` is frozen: ignore `.git`, `operator-requests`, `secrets`, and `transcripts`; hash/package only the roots classified in the finding; reject unknown roots and special files without an override.
- Every learner digest surface, including daemon status and commit export, resolves the same profile.
- v0 checkpoint publication is frozen-only. Train mode, scrub findings, unknown roots, and profile mismatches refuse before pinning.
- The pinned/signed v2 manifest never contains its own CID-derived key or transaction receipt. The CLI returns the receipt separately and the indexer derives it from the anchor event.
- Install treats all remote values as untrusted: both artifact CIDs are
  canonical CIDv1 `raw` + `sha2-256`, the package CID addresses the exact ustar
  bytes, bounded archive preflight/extraction runs in owner-only staging, and
  contained atomic destination commit is mandatory.
- The signed v2 core carries a mandatory `redactionManifestHash` over the
  RFC 8785 JCS form of the registered scrub report; install recomputes it.
- `checkpoint.ts` must ship as registered `jinn checkpoint publish|install|list` CLI verbs with production dependencies and CLI-level tests.
- American English in identifiers and Issue titles (`digest`, `distill`, ` favor` not British variants).

---

## Spike success criteria (close #945)

The spike closes when **all** of the following are true:

1. Finding answers every #945 investigate checkbox (mechanism, integrity, safety, economics, trust/lineage, recommendation) — see verification checklist below.
2. Recommendation is explicit and actionable: **complete HarnessCheckpoint; no auto-upload on every train delivery; lock the public profile first.**
3. This plan exists at the path above and maps ACs → ordered follow-up Issues with shapes, ACs, and dependencies.
4. No production runtime code was introduced solely to “prove” the spike.

Human ratification and the #2117–#2120 filing satisfy these documentation gates.
Merging the spike PR closes #945. The follow-up Issues are filed with native
blocker edges; closing #945 does **not** require their implementation.

---

## Out of scope for spike #945

| In scope (this PR / session) | Out of scope |
|---|---|
| Finding doc | Real `pinToIpfs` for `implStateDir` |
| This follow-up plan | Changing `freezeStateHashIgnore` / learner digests |
| Local commit of the two docs | Extending `ExecutionPayloadV2` |
| | Auto-share on delivery / `implStateShare.onDelivery` |
| | x402 pricing of checkpoints |
| | Explorer UI polish beyond naming the follow-up |
| | Corpus hybrid ranking of checkpoints in `search_records` |
| | Pushing, PR lifecycle, Project field mutation (coordinator owns) |

---

## AC → follow-up map

| #945 AC | Finding | Follow-up Issue(s) |
|---|---|---|
| Mechanism options | §2 | F0 (docs/design) records B as chosen; F2–F3 implement B; F4 optional A |
| Integrity | §3 | F1 (hashIgnore) + F2 (re-hash on install) |
| Safety / redaction | §4 | F1 (never hash secrets) + F2 (allowlist + scrub) + F0 (spec) |
| Economics | §5 | F0 (document free+attributed); pricing deferred — no Issue until density |
| Trust / lineage | §6 | F2 (fork install + provenance fields) + F0 (mandatory named `hashProfile` on manifest) |
| Recommendation | §7 | Entire train F0→F3; human accept closes spike |

---

## File map (for later `feat` implementers — do not touch in spike)

| Path | Role |
|---|---|
| `client/src/harnesses/freeze.ts` | `hashImplStateDir(dir, { ignoreRelPaths })` |
| `client/src/harnesses/impls/learner/harness.ts` | Today: `freezeStateHashIgnore = ['.git']` — replace raw learner defaults with registered `learner-public.v1` |
| `client/src/harnesses/types.ts` | Add named public-profile selection; do not expose an ad hoc publish ignore list |
| `client/src/daemon/freeze-fence.ts` | Resolve the same profile used by packaging |
| `client/src/main.ts` harness status | Resolve the same profile so operator status equals envelope/checkpoint identity |
| `client/src/cli/commands/codedigest-revert-check.ts` | Use the learner profile when hashing exported commits |
| `client/src/cli/commands/checkpoint.ts` | Replace empty pin; add safe package install and a production `CommandModule` |
| `client/src/cli/index.ts` | Register `jinn checkpoint`; include help/registry regressions |
| Shared CID/archive/path-safety helpers | Canonical content binding, fixed limits, preflight, owner-only contained extraction/commit |
| `packages/sdk/src/checkpoint.ts` | Add immutable `harness.checkpoint.v2` with mandatory `hashProfile`; keep the anchor receipt outside the manifest |
| `packages/indexer/ponder.schema.ts` + checkpoint enrichment | Project `hashProfileId` / canonical ignore list and derive tx/block from the event |
| `client/src/discovery/*` + `client/src/mcp/server.ts` | Digest→checkpoint lookup + MCP tool |
| `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §7 | Amend for ignore/allowlist/scrub/discovery |
| `log/decisions/` DR-2026-05-06-d amend note | Trust-stack record for default hash-ignore change |

---

## Ordered follow-up Issues

### F0 / [#2117](https://github.com/Jinn-Network/mono/issues/2117) — `docs`: amend §7 + short DR-2026-05-06-d note

**Proposed title:** `docs(harness): amend checkpoint §7 + DR-d for hashIgnore / digest discovery`

**Shape:** Prefer single Issue Type `docs` if the amend is light and Captain already accepts the spike recommendation; use `design` only if Captain wants a fresh design session before any `feat`. Default after spike accept: **`docs`**.

**Depends on:** Human accept of #945 finding recommendation.

**Blocks:** F1–F3 (feats may start in parallel with F0 only if F0’s contracts are locked in the finding — they are: `harness.checkpoint.v2`, mandatory `hashProfile`, the learner root table, frozen-only publish, and scrub gate). Prefer F0 merges first.

**Acceptance criteria:**

- [ ] `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §7 locks the immutable `harness.checkpoint.v2` / separate anchor-receipt contract, opt-in frozen-only publish, named profile, exhaustive learner root classification, fail-closed scrub, digest-indexed discovery, and stub-removal acceptance.
- [ ] Short amend under DR-2026-05-06-d (or sibling note in `log/decisions/`) records `learner-public.v1`, including its four ignored roots, supported public roots, unknown-root refusal, and why Layer-4 re-derivation matches published bytes.
- [ ] Explicit non-goals: no ExecutionPayloadV2 extension; no auto-pin on delivery in v0; economics = free + attributed.
- [ ] Links back to #945 finding + this plan.

**Verification:** Doc PR review; CODEOWNERS / Discussion only if a canonical root doc is touched (these paths are not SPEC/BRAND/THESIS — ordinary docs review suffices).

---

### F1 / [#2118](https://github.com/Jinn-Network/mono/issues/2118) — `feat(client): lock learner-public.v1 hash/package profile`

**Proposed title:** `feat(client): lock learner-public.v1 hash/package profile`

**Shape:** `feat`

**Depends on:** F0 / #2117.

**Blocks:** F2 (publish cannot be integrity-safe while secrets remain in the digest).

**Acceptance criteria:**

- [ ] A single registry defines `learner-public.v1` with canonical ordered ignores `['.git', 'operator-requests', 'secrets', 'transcripts']` and the complete allowed-root table from the finding.
- [ ] The learner freeze fence and `codeDigestForCommit` resolve that profile; no duplicated raw defaults remain.
- [ ] `client/src/main.ts` harness status resolves the default harness's profile before hashing; status, a stamped envelope, commit export, and checkpoint publish report the same digest for one tree.
- [ ] A shared classifier rejects unknown top-level paths, wrong file/directory kinds, symlinks, and special files. There is no v0 bypass.
- [ ] Tests prove differences under each ignored root do not change the digest, while changes under each public root do; without the profile, private-root changes differ.
- [ ] Tests prove the future package walker receives the exact same selected path set and ignore semantics as the hasher.
- [ ] A status-versus-envelope equivalence regression includes private-root content and proves those bytes change neither surface.
- [ ] Other harnesses do not inherit learner defaults; checkpoint publication refuses them until they register a reviewed public profile.
- [ ] Operator migration note calls out that historical learner digests including private roots will not match post-change digests, including L1 / leaderboard continuity.

**Verification (implementer):**

```bash
cd client && yarn test path/to/freeze-secrets-ignore.test.ts
```

Expected: PASS; boundary cases cover every ignored root, every public root class,
unknown roots, wrong kinds, special files, and freeze/revert/package parity.

**Suggested first test sketch (for the feat’s own TDD plan):**

```typescript
it('private learner roots do not change codeDigest under learner-public.v1', async () => {
  // arrange trees with identical public roots and different private roots
  // hash through the registered profile, not a caller-provided raw list
  // assert digests equal
});
```

---

### F2 / [#2119](https://github.com/Jinn-Network/mono/issues/2119) — `feat(client): real HarnessCheckpoint publish/install with re-hash verify`

**Proposed title:** `feat(client): real HarnessCheckpoint publish/install with re-hash verify`

**Shape:** `feat`

**Depends on:** F1 (required). F0 (preferred).

**Blocks:** F3 (discovery is useless until real CIDs exist).

**Acceptance criteria:**

- [ ] `jinn checkpoint publish` is opt-in and refuses `mode === 'train'` unconditionally; no warning-only or acknowledgement flag exists in v0.
- [ ] Publish resolves the harness's registered profile, validates roots/kinds, and runs the fail-closed scrub before any pin.
- [ ] Publish pins the actual public tree selected by `learner-public.v1`, replacing `data: ''`; the packaged path set is exactly the hasher's non-ignored path set.
- [ ] `harness.checkpoint.v2` requires
  `hashProfile: { id, ignoreRelPaths }` and `redactionManifestHash`; the
  signature covers both. The hash is `sha256:<hex>` over the RFC 8785 JCS UTF-8
  bytes of the registered `jinn.checkpoint-redaction.v1` report defined in the
  finding; publish returns that report locally, and install recomputes it.
  Unknown scanner profiles or a report-hash mismatch refuse. New writers emit
  v2.
- [ ] The exact signed JSON bytes are pinned and schema-parse when fetched by `checkpointCid`; no registry-populated variant is constructed.
- [ ] `IdentityRegistry.setMetadata("harness.checkpoint:<checkpointCid>", checkpointCid)` anchors the immutable CID. The CLI returns `{ checkpointCid, manifest, anchorReceipt }`, with the receipt outside the manifest.
- [ ] v1 compatibility is read-only: valid historical v1 may parse, but no new v1 is emitted and install never invents receipt fields absent from fetched bytes.
- [ ] `checkpointCid` and `implStateDirCid` pass a shared canonical CIDv1
  `raw` + `sha2-256` parser before use. Exact raw manifest bytes match
  `checkpointCid`; `implStateDirCid` addresses the exact uncompressed ustar
  bytes. Transport is either that raw block or a bounded single-root,
  single-block CARv1 whose root/block CID is `implStateDirCid`; missing,
  conflicting/duplicate, or extra blocks fail. v0 accepts no dag-pb/UnixFS
  package or implicit reconstruction.
- [ ] v0 package bytes are deterministic uncompressed POSIX ustar; compression
  and PAX/extended records are refused. Exported ceilings are 1 MiB manifest,
  320 MiB CAR transfer, 256 MiB tar/expanded bytes, 20,000 total entries,
  10,000 regular files, 10,000 directories, depth 32, 16 MiB/file, and 255
  UTF-8 path bytes.
- [ ] A full archive preflight occurs before writes and rejects
  absolute/drive/UNC paths, invalid UTF-8 or non-NFC paths,
  NUL/backslash/dot/`..` segments, duplicate/Unicode-case-fold/prefix
  collisions, missing/out-of-order parent directories, links, devices, FIFOs,
  sockets, sparse/extended entries, and all non-file/directory records. It
  verifies canonical ustar name/prefix splitting, logical ordering, types,
  zero owner/time fields, normalized archive modes, checksums, padding, and end
  blocks.
- [ ] Extraction uses no shell command. It streams into a unique trusted-parent
  `mkdtemp` directory verified `0700`, re-enforces byte/entry/file/directory/
  depth limits, prevents link following or replacement, proves containment for
  every output, ignores remote ownership/mode, creates current-process-owned
  directories `0700` and files `0600`, cleans on failure, and never
  interpolates remote CIDs or names into its path.
- [ ] Manifest `implName` is validated before final path selection. The destination is contained beneath configured `implStateDirRoot`, unsafe parent links are rejected, existing state is not overwritten by default, and verified staging is committed atomically.
- [ ] `client/src/cli/commands/checkpoint.ts` exports a production-wired `CommandModule` for `jinn checkpoint publish|install|list`; `client/src/cli/index.ts` registers it and help/argument errors follow the standard envelope.
- [ ] CLI validates subcommands, required arguments, canonical names/versions/CIDs, frozen mode, configured IPFS/wallet dependencies, and destination policy before mutation.
- [ ] Tests cover train refusal, unknown/special-file refusal, scrub refusal,
  scrub-report canonicalization/recomputation/tampering, CID-byte/schema
  equality, receipt separation, profile tampering/unknown id, package/hash
  parity, signature/digest mismatch, every malicious-archive class plus
  directory/depth floods, non-canonical header/path-split/checksum rejection,
  every limit/cleanup rule, CLI registry/help/arguments, and a CLI-level
  mocked-IPFS publish→install round trip.

**Verification (implementer):**

```bash
cd client && yarn test test/cli/checkpoint*.test.ts
cd packages/sdk && yarn test  # v2 manifest/hashProfile schema
```

Expected: publish no longer pins an empty buffer or a different pre-anchor
manifest; install rejects tampered trees, unsupported/tampered profiles, unsafe
archives, and unsafe destinations; the product CLI reaches the complete flow.

**Key stub to delete (must not ship as success path):**

```typescript
// client/src/cli/commands/checkpoint.ts — today
const implStateDirCid = await args.deps.pinToIpfs({ kind: 'implStateDir', data: '' });
```

Replace with profile resolve → validate/scrub → walk → deterministic
uncompressed ustar → pin the exact bytes as a raw-CID block whose materialized
files re-hash to `args.codeDigest`. Pin the immutable v2 manifest exactly once,
then anchor that CID and keep the receipt outside it.

---

### F3 / [#2120](https://github.com/Jinn-Network/mono/issues/2120) — `feat(discovery/mcp): resolve impl-state by codeDigest`

**Proposed title:** `feat(discovery/mcp): resolve impl-state by codeDigest via harness_checkpoint`

**Shape:** `feat`

**Depends on:** F2 (meaningful end-to-end). Indexer columns already exist — confirm enrichment path writes `codeDigest` + `implStateDirCid` before claiming done.

**Blocks:** Optional explorer “source available” affordance (can be a thin follow-on `feat` under explorer area).

**Acceptance criteria:**

- [ ] Checkpoint enrichment projects `hashProfileId` and the canonical ignore-list JSON from v2, while transaction hash/block/publisher remain authoritative event-derived fields.
- [ ] DiscoveryAPI method (name locked in feat plan, e.g. `getCheckpointByCodeDigest`) returns checkpoint CID + `implStateDirCid` + publisher/event anchor fields + `hashProfile` when an enriched row exists for `sha256:<hex>`.
- [ ] MCP tool (e.g. `get_checkpoint_by_codedigest` or `fetch_impl_state` that resolves then points at install/acquire) usable from consolidator/Improve workflows.
- [ ] Empty / unpublished digest → graceful empty result (not throw-as-outage).
- [ ] Onchain DiscoveryAPI stub returns empty (same pattern as other enrichment-only reads).
- [ ] Tests: http mock GraphQL hit; not-ready / empty cases.
- [ ] Malformed/unknown profile data never appears as installable source; tests cover v1 compatibility and v2 profile projection.

**Verification (implementer):**

```bash
cd client && yarn test test/discovery/http.checkpoint-by-codedigest.test.ts
# plus MCP registration smoke if present in suite
```

---

### F4 — optional later `feat`: opt-in share on frozen delivery (Option A)

**Proposed title:** `feat(client): opt-in implStateShare.onDelivery=frozen`

**Shape:** `feat`

**Depends on:** F1–F3 stable in canary; operator demand evidence.

**Acceptance criteria (sketch only — file when ready):**

- [ ] Config `implStateShare.onDelivery: 'never' | 'frozen' | 'always'` default `never`.
- [ ] On frozen success path only (when `frozen`), may attach `implStateDirCid` to envelope artifacts / checkpoint auto-publish — never on train unless `always`.
- [ ] Reuses F2 packaging/redaction; does not extend `ExecutionPayloadV2` unless a separate design Issue says so.
- [ ] Economics remain free+attributed unless a separate pricing Issue ships.

**Do not file F4 until F1–F3 have soak time.**

---

## Dependency graph

```text
#945 spike accept (human)
        │
        ▼
       F0  docs/design amend (§7 + DR-d)
        │
        ▼
       F1  feat: secrets out of hashIgnore
        │
        ▼
       F2  feat: real checkpoint publish/install
        │
        ▼
       F3  feat: digest → checkpoint discovery/MCP
        │
        └──► F4 (optional) onDelivery share
```

---

## Human verification checklist (accept spike finding)

Reviewer walks this list against the finding + this plan. Check every box before closing #945 / merging the spike docs PR.

### Mechanism (#945 investigate 1)

- [ ] At least two mechanism options compared (finding has A delivery-CID, B checkpoint, C MCP-only).
- [ ] Corpus/discovery fit is stated (`inspect_record` / `acquire_artifact` vs `harness_checkpoint` index).
- [ ] A clear winner is named (B) with deferred options recorded (A later, C local glue only).

### Integrity (#945 investigate 2)

- [ ] Consumer verify path is “materialise + `hashImplStateDir` + match advertised digest.”
- [ ] Ignore-list parity called out as load-bearing; secrets-in-hash contradiction explained.

### Safety / redaction (#945 investigate 3)

- [ ] Secrets / credential bags: never hash, never publish.
- [ ] Path / identity scrub + fail-closed posture named.
- [ ] Train-mode sharing is refused in v0; frozen-only.
- [ ] Opt-in + directory allowlist recommended for v0.

### Economics (#945 investigate 4)

- [ ] v0 = free + attributed; x402 deferred to existing acquire rails.
- [ ] Shared-digest / federated L1 densification treated as feature; author vs runner Prestige not collapsed.
- [ ] “M2” ambiguity acknowledged (L1 per-digest vs explorer Milestone 2).

### Trust / lineage (#945 investigate 5)

- [ ] Import modeled as fork; local L1 revert unaffected.
- [ ] Minimum provenance: signature, publisher, parentCheckpointCid, codeDigest, implStateDirCid, mandatory named hashProfile, on-chain anchor with event-derived receipt.

### Recommendation (#945 investigate 6)

- [ ] Smallest path is ordered: hashIgnore → real publish/install → digest discovery.
- [ ] Spec/DR warrant is explicit (amend §7 + short DR-d note; no greenfield artifact type).
- [ ] Follow-up Issues listed with shapes and ACs (this plan F0–F3).
- [ ] Spike PR contains **only** finding + plan docs (no runtime code).

### Process / authority

- [ ] Worktree remained detached; logical branch `autopilot/945` was not checked out by the stage agent.
- [ ] No push / Project mutation / Autopilot session commands from the stage agent.

---

## Plan self-review

| Check | Result |
|---|---|
| Spec / finding coverage | All six #945 ACs map to F0–F3 (and F4 deferred) |
| Placeholders | None — Issue titles, shapes, ACs, deps, verify commands concrete |
| Spike vs feat boundary | Production code steps deferred to per-feat `writing-plans` sessions |
| Consistency with finding | Option B spine; secrets-first; free+attributed; no ExecutionPayloadV2 in v0 |

---

## Headless decisions (Stage 2 audit log)

1. **Chose `docs` as default for F0** after spike accept (not a second full `design` session) because the finding already selects Option B and only needs §7 / DR-d ratification text.
2. **Kept F4 unfiled** until F1–F3 soak — matches finding non-goals.
3. **Stage agents did not file Issues via `gh`/`file-issue`** because their authority forbade shared GitHub mutation; the human-ratification pass filed #2117–#2120 after acceptance.
4. **Did not implement production code** — spike output is finding + this plan only.
