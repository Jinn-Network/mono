# Jinn Intent & Manifest Schema Versioning — Technical Spec

> Version: 1.1
> Date: 2026-04-27
> Author: Ale
> Status: Proposed (not yet adopted)
> Supersedes: none
> Informs: `docs/reviews/2026-04-22-architecture-audit-j75.md` §6 gap #5, §7.2.2, §8 decision #2
> Extends: `spec/2026-04-14-client-surface.md`

## 1. Purpose and scope

This spec defines the **versioning policy** for intent kinds and their
associated manifests across the Jinn protocol surface (intent specs,
restoration submissions, evaluator verdicts, ERC-8004 artifact
envelopes). It also defines how a Jinn client **advertises** the set
of kinds and manifest versions it supports, and how downstream
consumers (subgraphs, evaluators, third-party readers) decide
compatibility.

The audit (`docs/reviews/2026-04-22-architecture-audit-j75.md` §6
gap #5; §7.2.2; §8 decision #2) flagged that today's kinds — `portfolio.v0`,
`prediction.v0`, `prediction.apy.v0` — *look* like semver but carry no
policy. Clients silently fail to parse intents written by a different
build; subgraphs and evaluators have no rule for what `.v1` promises.
This spec closes that gap.

### 1.1 In scope

- The grammar of `kind` strings.
- The relationship between `kind` major and manifest `schemaVersion`
  minor / patch.
- The `supportedKinds` field added to `jinn version --json`.
- Consumer compatibility behaviour at unknown `schemaVersion`
  (subgraph and evaluator).
- Migration guidance: how a kind bumps `vN → v(N+1)`, and the
  reader-side accept-both window for additive field renames.

### 1.2 Out of scope

- The contents of any specific manifest (defined per-kind in
  `client/src/types/<kind>.ts` and the kind's own spec doc).
- Storage format on ERC-8004 / IPFS (envelope shape lives elsewhere).
- The external-impl distribution mechanism
  (`spec/2026-05-external-restorer-impls.md`; audit §8 decision #1).
- Trust boundary for third-party impls (audit §8 decision #3).
- Path 1 plug-ins (`spec/2026-04-30-plug-in-surface.md` §4) use the
  same `kind` grammar; their `compatibility.supportedKinds` field
  follows the §2 grammar identically.

### 1.3 Non-goals

- This is not a hash-pinned schema registry. Audit §8 decision #2
  considered (c) hash-pinning and rejected it for v0; semver is the
  policy. A future spec may layer hash-pinning on top.
- This is not a content-migration tool. Old artifacts on-chain remain
  on-chain under their original `schemaVersion`; the policy here
  governs how *new* code reads them.

## 2. Kind grammar

A `kind` is a string of the form:

```
<domain>.v<major>
```

where:

- `<domain>` is one or more lowercase ASCII segments separated by
  hyphens (`-`). Each segment matches `[a-z][a-z0-9]*`.
- `<major>` is a non-negative decimal integer with no leading zeros
  (`0`, `1`, `2`, …; not `01`).
- The literal `.v` separates domain from version.

### 2.1 Examples

| Kind                      | Domain          | Major | Notes                                    |
|---------------------------|-----------------|-------|------------------------------------------|
| `prediction.v0`           | `prediction`    | 0     | Single-segment domain.                   |
| `prediction-apy.v0`       | `prediction-apy`| 0     | Sub-domain via hyphen, **not dot**.      |
| `portfolio.v0`            | `portfolio`     | 0     | Single-segment domain.                   |
| `lending-health.v1`       | `lending-health`| 1     | Hyphenated sub-domain; second major.     |

### 2.2 Reserved separators

- **Dot (`.`)** is reserved. Exactly one dot appears in a `kind`,
  immediately before the literal `v<major>`. A kind string therefore
  always splits into exactly two parts on `.` — domain and version
  token.
- **Hyphen (`-`)** is the only valid separator inside `<domain>`.
  Sub-domains, qualifiers, and compound names (`prediction-apy`,
  `lending-health`, `portfolio-rebalance`) MUST use hyphens.
- **Underscore (`_`)** and uppercase characters are forbidden.

This is a deliberate change from current practice. `prediction.apy.v0`
(dotted sub-domain, shipped as of 2026-04-22) is a **legacy form**
retained for already-deployed artifacts; new kinds MUST use hyphens.
See §6.3 for the migration path.

### 2.3 Semantics of the major

`vN → v(N+1)` is a **breaking change**. A consumer that supports
`prediction.v0` MUST NOT assume any compatibility with `prediction.v1`.
Specifically, a `vN+1` kind MAY:

- Remove or rename required fields.
- Change field types or units.
- Alter loop semantics (claim → run → deliver) for that kind.
- Replace the manifest envelope shape entirely.

Conversely, a `vN+1` kind MUST be a **distinct kind string** — the
same domain at a new major. Consumers route on the full `kind`; there
is no implicit fallback from `v1` to `v0`.

## 3. Manifest schemaVersion

Every manifest emitted under a kind (intent spec, submission, verdict,
artifact envelope) carries a `schemaVersion` field as a **semver
string** (`MAJOR.MINOR.PATCH`).

```json
{
  "kind": "prediction.v0",
  "schemaVersion": "1.2.0",
  "...": "..."
}
```

### 3.1 Bump rules

For a fixed `kind`:

| Change                                                | Bump      | Reader compat                                    |
|-------------------------------------------------------|-----------|--------------------------------------------------|
| Add an optional field                                 | minor     | Old readers ignore unknown fields (§4.3 below).  |
| Add a required field                                  | **major** | Old readers fail closed; treat as new kind candidate. |
| Rename a field (with reader-side accept-both bridge)  | minor     | One release of accept-both required (§6.1).      |
| Remove a field                                        | **major** | Treated as breaking; consider a new kind.        |
| Tighten a constraint (range, enum subset)             | **major** | Old payloads may now fail validation.            |
| Loosen a constraint (range, enum superset)            | minor     | Old readers may reject; reader-side accept-both. |
| Fix a typo in a description / comment                 | patch     | No reader impact.                                |

A manifest `MAJOR` reaching `2.0.0` within the same kind is an
escalation signal: prefer minting a new kind (`prediction.v1`) over
shipping a manifest `2.0.0` under `prediction.v0`. The kind's major is
the user-visible breaking-change axis; manifest `MAJOR` exists for
edge cases (e.g., field removal under regulatory pressure) where a
full kind bump is inappropriate.

### 3.2 Default schemaVersion

The first manifest published under a new kind starts at `1.0.0`. There
is no `0.x` development band; once a kind is named in code that ships,
its manifest is `1.0.0` or higher.

### 3.3 Relationship to legacy `schemaVersion` literals

Existing manifests carry composed string literals like
`prediction.v0.submission.v1` (see `client/src/types/prediction.ts`).
Under this spec, that becomes:

- `kind: "prediction.v0"` (unchanged at the spec level)
- `schemaVersion: "1.0.0"` (semver)
- A separate `manifestRole` discriminator (`"submission" | "verdict" |
  "spec"`) where one is needed inside a kind.

Reader-side, this spec REQUIRES that consumers accept both forms for
one release window (see §6.1). Writer-side, new manifests SHOULD use
the split form.

## 4. Client advertisement

This section extends `spec/2026-04-14-client-surface.md` §4.7
(`jinn version`).

### 4.1 `supportedKinds` field

`jinn version --json` MUST emit a `supportedKinds` array on its
top-level object:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-04T12:00:00Z",
  "client": { "version": "0.4.0", "commit": "..." },
  "protocol": { "phase": "phase-1b", "specVersion": 1 },
  "network": "testnet",
  "deployments": { "...": "..." },
  "tokens":      { "...": "..." },
  "supportedKinds": [
    "prediction.v0>=1.0.0",
    "prediction-apy.v0>=1.1.0",
    "portfolio.v0>=1.0.0"
  ]
}
```

Note: the top-level `schemaVersion: 1` here is the **client-surface**
schema version (per `spec/2026-04-14-client-surface.md`), not a kind
manifest version. The two namespaces are independent.

### 4.2 Entry grammar

Each entry in `supportedKinds` is a string:

```
<kind>>=<semver>
```

- `<kind>` follows §2.
- `>=` is the only constraint operator in v1 of this spec. The client
  asserts: "I can read every manifest under `<kind>` whose
  `schemaVersion` is `>= <semver>` and `< <next-major>`, where
  `<next-major>` is the next major after `<semver>`'s major."
- `<semver>` is the **lowest** manifest minor.patch the client
  guarantees to parse. Higher minors within the same major MUST also
  parse, by the additive rule in §3.1.
- The entry MUST contain **no whitespace** anywhere — not around the
  `>=`, not inside `<kind>`, and not inside `<semver>`. Whitespace
  inside an entry is a malformed advertisement and consumers MUST
  reject the whole `supportedKinds` array.

The literal `>=` immediately abutting the `v<major>` of the kind makes
naive splitting brittle (the boundary between `<kind>` and the operator
is `v0>=` — three characters of overlap with the kind grammar). Parsers
MUST anchor on the §2 kind grammar, not on a substring search for `>=`.
The full entry conforms to the regex:

```
^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*\.v(0|[1-9][0-9]*)>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

with one exception: the legacy `prediction.apy.v0` form (§6.3) replaces
the kind portion with the literal `prediction.apy.v0`.

A client that supports multiple disjoint majors of the same kind MAY
emit one entry per major:

```
"prediction.v0>=1.4.0"
"prediction.v0>=2.0.0"
```

Consumers MUST treat the union of these ranges as the supported set.

### 4.3 Forward-compat reading

Independent of `supportedKinds`, all clients MUST:

- Ignore unknown fields in any manifest they accept (additive minor
  bumps remain backwards-compatible).
- Treat a manifest whose `schemaVersion` major exceeds the highest
  major in the client's `supportedKinds` entry for that kind as
  **unreadable** (see §5).

### 4.4 CLI surface (non-JSON)

When `--json` is not set, `jinn version` MUST render `supportedKinds`
as a sorted, one-per-line list under a `Supported kinds:` header.
Wording is informative; agents MUST use the JSON form.

## 5. Consumer compatibility policy

This section governs subgraphs, evaluators, and any third-party reader
that ingests intents, submissions, or verdicts published by Jinn
clients.

### 5.1 Three classes of consumer

| Class             | Examples                          | Default behaviour at unknown `schemaVersion` |
|-------------------|-----------------------------------|----------------------------------------------|
| **Indexer**       | Subgraph, archive crawler         | **Drop** the record; emit a structured warning. |
| **Live evaluator**| Daemon evaluator impl, attestor   | **Surface as error**: write a verdict-shaped envelope with `error.code = "unsupported_schema"` and refuse to vote. |
| **Inspector**     | Explorer UI, `jinn intents show`  | **Surface as warning**: render the raw envelope; mark the record `unparsed: true`; do not silently hide. |

The default is "drop vs surface-as-error" rather than "best-effort
parse" because a manifest the consumer has never seen MAY have moved a
load-bearing field. Best-effort parsing of unknown-schema records is
explicitly forbidden.

### 5.2 Decision rule

For a manifest with `kind = K` and `schemaVersion = V`:

1. If the consumer's supported set for `K` is empty → unsupported kind.
   Indexers drop; evaluators surface as `error.code = "unsupported_kind"`;
   inspectors render raw.
2. If `V`'s major is **greater than** any supported major for `K` →
   unsupported schema (forward-incompat). Same dispositions as (1)
   with `error.code = "unsupported_schema"`.
3. If `V`'s major matches a supported major and `V >= advertised
   minimum` → **parse**.
4. If `V`'s major matches a supported major but `V < advertised
   minimum` → unsupported schema (backward-incompat). Same dispositions
   as (1).

Indexers MUST log the dropped record's `kind`, `schemaVersion`,
`txHash`, and `cid` (when available) at warning level so an operator
can trace it. Silent drops are a defect.

### 5.3 Evaluator error envelope

When an evaluator surfaces an unsupported manifest as an error, the
envelope reuses the verdict shape with the error fields populated:

```json
{
  "kind": "<K>",
  "schemaVersion": "<V observed>",
  "manifestRole": "verdict",
  "error": {
    "code": "unsupported_schema" | "unsupported_kind",
    "evaluatorSupported": ["prediction.v0>=1.0.0", "..."]
  }
}
```

The evaluator MUST NOT vote pass/fail on a manifest it cannot parse.
Subgraph indexers MUST treat such an envelope as a non-vote — it
neither contributes to nor blocks the underlying intent's outcome.

### 5.4 Configurability

A consumer MAY expose a knob to switch from "drop" to "surface as
error" for indexer-class behaviour (e.g. a subgraph can flip to
parking unknown records in a quarantine table). The default for v1
remains drop-with-warning.

## 6. Migration guidance

### 6.1 Reader-side accept-both for additive renames

When a manifest field is renamed under a minor bump (§3.1), the
producing release SHOULD ship readers that accept **both** the old
and new field name for **at least one full release**. Concretely:

- Release N: writer emits `oldName` only. Reader accepts `oldName` only.
- Release N+1: writer emits `newName` (preferred) **and** `oldName`
  (kept). Reader accepts both, prefers `newName`. Manifest
  `schemaVersion` minor bumps in this release.
- Release N+2: writer drops `oldName`. Reader still accepts both.
  Manifest `schemaVersion` minor bumps.
- Release N+3 or later: reader MAY drop `oldName` acceptance. This is
  a **major** bump under §3.1 because old payloads — including any
  still on IPFS — would now fail to parse.

The accept-both window covers the case where an indexer or evaluator
upgrades on a different cadence than the daemon emitting new
manifests. One release of overlap is the floor; longer windows are
preferred when older artifacts are pinned on-chain (the common case).

### 6.2 Reader-side accept-both for the legacy composed `schemaVersion`

Existing manifests use composed literals (`prediction.v0.submission.v1`)
in `schemaVersion`. New manifests use semver (`1.0.0`) plus an explicit
`manifestRole`. For at least one release after this spec is adopted,
all readers MUST:

- Parse a `schemaVersion` value matching `^\d+\.\d+\.\d+$` per §3.
- Parse a `schemaVersion` value matching the legacy
  `^<kind>\.(spec|submission|verdict)\.v\d+$` shape and synthesise a
  `1.0.0` (for `v1`), `2.0.0` (for `v2`), … plus a derived
  `manifestRole`.

After the accept-both window, readers MAY drop the legacy form. That
drop is a major bump on the affected kind's manifest.

### 6.3 Sub-domain hyphenation migration

The kind `prediction.apy.v0` is the only currently-shipped kind that
violates §2.2 (dot in sub-domain). It is **grandfathered** for the
lifetime of `v0`. Specifically:

- Existing on-chain artifacts under `prediction.apy.v0` retain that
  kind string forever.
- Clients MUST advertise it as `prediction.apy.v0>=1.0.0` exactly
  (the dot is part of the literal string).
- The next major MUST use the hyphenated form: `prediction-apy.v1`.
  At that point clients advertise both:
  ```
  "prediction.apy.v0>=1.0.0"
  "prediction-apy.v1>=1.0.0"
  ```
  until the legacy major is retired.
- No other kind may be minted with a dotted sub-domain.

### 6.4 Announcing a kind major bump

When a kind moves from `vN` to `v(N+1)`:

1. A spec proposal under `spec/YYYY-MM-DD-<topic>.md` documents the
   motivation, the field-level diff, and the reader-side migration.
2. The new kind ships in a client release **alongside** continued
   support for the old major. `supportedKinds` lists both:
   ```
   "prediction.v0>=1.4.0"
   "prediction.v1>=1.0.0"
   ```
3. Writers begin emitting the new kind only after consumers
   (subgraph, evaluator) have shipped support — verified by reading
   their `supportedKinds` advertisement.
4. The old major is retired in a later release. Retirement removes the
   old entry from `supportedKinds` and is itself a breaking client
   change (bumps the client-surface `schemaVersion` per
   `spec/2026-04-14-client-surface.md` §9).

### 6.5 Pinned-artifact graceful degradation

ERC-8004 and IPFS pin artifacts indefinitely. A client running long
after a kind retirement MAY still encounter old envelopes. The
expected behaviour is §5.2 disposition for "unsupported kind" — drop
or surface, never best-effort. There is no ceiling on how old an
encountered envelope may be.

## 7. Examples

### 7.1 New kind, first release

```
kind:          lending-health.v0
schemaVersion: 1.0.0
manifestRole:  spec
```

`jinn version --json` includes:

```
"supportedKinds": ["lending-health.v0>=1.0.0", "..."]
```

### 7.2 Additive minor bump

Release adds optional `targetUtilisationBps`. The writer now emits:

```
kind:          lending-health.v0
schemaVersion: 1.1.0
```

The advertised minimum **does not change**:

```
"supportedKinds": ["lending-health.v0>=1.0.0"]
```

The reader still parses every prior `1.0.x` envelope (it just ignores
unknown fields per §4.3) and parses the new `1.1.0` envelopes by the
"higher minors within the same major MUST also parse" clause of §4.2.
Bumping the advertised minimum to `1.1.0` would be wrong: the §5.2
decision rule (rule 4) would then drop every still-pinned `1.0.x`
artifact, even though the reader is perfectly capable of parsing it.

The general rule: **the advertised minimum tracks the oldest
`schemaVersion` the reader can still parse, not the newest one the
writer emits.** Within a single major, the advertised minimum normally
stays put across many writer-side minor bumps. It only advances when
the reader drops support for an old minor — and dropping reader
support for an old in-major minor is itself a major bump under §3.1
(it makes pinned payloads fail), so in practice the advertised minimum
moves only at kind-major boundaries.

### 7.3 Field rename across releases

`apyBps` renamed to `expectedApyBps` (audit feedback: clarity).

| Release | Writer emits      | Reader accepts             | `schemaVersion` |
|---------|-------------------|----------------------------|-----------------|
| N       | `apyBps`          | `apyBps`                   | `1.2.0`         |
| N+1     | `expectedApyBps`, `apyBps` | both              | `1.3.0`         |
| N+2     | `expectedApyBps`  | both                       | `1.4.0`         |
| N+3     | `expectedApyBps`  | both (no change)           | `1.4.0`         |
| N+4     | `expectedApyBps`  | `expectedApyBps`           | `2.0.0`         |

The drop in N+4 is a manifest **major** bump (§3.1), because old
on-chain payloads now fail.

### 7.4 Major kind bump

`prediction.v0 → prediction.v1` because verdict semantics change
(introduces partial-credit scoring incompatible with `v0`).

`spec/2026-MM-DD-prediction-v1.md` documents the diff. Client release
advertises:

```
"supportedKinds": ["prediction.v0>=1.4.0", "prediction.v1>=1.0.0"]
```

Subgraph and evaluator must ship `prediction.v1` support before
writers begin emitting it (§6.4 step 3).

## 8. Conformance checklist

A client claiming conformance to this spec MUST:

- [ ] Emit `supportedKinds` on `jinn version --json` per §4.
- [ ] Validate every emitted manifest's `kind` against the §2 grammar
      (modulo §6.3 grandfathering).
- [ ] Validate every emitted manifest's `schemaVersion` against
      `^\d+\.\d+\.\d+$` (or accept the legacy form per §6.2).
- [ ] On read, apply the §5.2 decision rule. Indexer-class code drops;
      evaluator-class code surfaces as error; never best-effort parse.
- [ ] Log every drop / surface with `kind`, `schemaVersion`, and a
      reference to the source record (txHash / cid / db id).

A consumer (subgraph, evaluator) claiming conformance MUST additionally:

- [ ] Read producers' `supportedKinds` advertisements before writers
      begin emitting a new kind.
- [ ] Implement §5.3's error-envelope shape for evaluator-class
      surfaces.

## 9. Open questions

- Whether to allow constraint operators beyond `>=` in
  `supportedKinds` (e.g. `~>`, `<`). Deferred until a real need
  appears.
- Whether to publish a machine-readable schema registry separate from
  the in-repo `client/src/types/<kind>.ts` files. Out of scope for
  v1; a future spec layered on top of this one MAY add it.
- How long the §6.1 accept-both window should run by default.
  Recommendation is "at least one release"; some kinds may need
  multiple. Per-kind docs can name a specific window.
- Interaction with on-chain ERC-8004 envelope shape if/when that
  envelope itself versions independently of the inner manifest. Out
  of scope; covered by the ERC-8004 envelope spec when written.

## 10. References

- `docs/reviews/2026-04-22-architecture-audit-j75.md` — audit; this
  spec closes §6 gap #5, addresses §7.2.2, and records the policy
  half of §8 decision #2.
- `spec/2026-04-14-client-surface.md` — client surface this spec
  extends (`jinn version` adds `supportedKinds`).
- `client/src/types/prediction.ts`,
  `client/src/types/prediction-apy.ts`,
  `client/src/types/portfolio.ts` — current Zod schemas; targets of
  the §6.2 / §6.3 migration.
- `client/src/intents/kinds/index.ts` — `SPEC_KINDS` map; the
  authoritative in-repo registry of kinds; the §8 conformance
  checklist runs against entries here.
