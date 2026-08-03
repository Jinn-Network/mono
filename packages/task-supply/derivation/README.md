# @jinn-network/task-derivation

> Phase C maturity: experimental and publication disabled. This package has no independent
> product consumer and makes no compatibility promise until two products and approved derivation
> semantics establish a reusable boundary.

Strategies that turn a **described execution environment** plus strategy inputs into
admitted, sealed Task + EvaluationSpec pairs in a supply pool.

## What this package does, and what it does not claim

It derives candidates, pipes them through an injected admission port, and writes the
survivors to a digest-addressed pool. It asserts nothing about whether the environment
behaves as described: that is what environment attestations are for, and whether they are
sufficient is the consumer's trust-policy join — never a property this package's output
claims. An admission receipt says the grader discriminated on the machine that ran it,
under the controls that run declared, and nothing more.

## Untrusted input (normative — design §7.3)

An imported statement is **upstream-authored text**. Public datasets and upstream pull
requests are attacker-influencable in principle, and the statement is delivered into every
solver's context — a prompt-injection channel. Consumers MUST treat task text as untrusted
data. Test material is upstream-authored code executed in containers; solve-time and
evaluation-time sandboxing belong to the executor's and evaluator's designs and are not
granted by any receipt this pipeline mints. Admission proves grading properties; it does
not and cannot prove content safety.

What consumers may rely on: `provenance.kind` labelling (filterable), admission receipts,
environment attestations, and pass-rate curation.

## No secrecy (D5)

For public repositories every v1 task's answer is discoverable — an imported answer sits in
the repository's history one `git log` away. This package builds no secrecy mechanism and
makes no secrecy claim. All test material is `accessClass: "public"`, set explicitly. There
is no grant infrastructure anywhere in the stack.

## Gold patches never enter the pool

The gold patch is what admission needs and what a solver must not receive. It goes to a
separate, local-only `GoldStore`, keyed by the digest the receipt records as
`goldPatchHash`. `PoolEntry` has no field that could carry it. Do not publish, sync, or
serve the gold directory; the store writes a `DO-NOT-PUBLISH` marker into it.

Three independent reasons the bytes cannot travel with a published pair: the pool's entry
type has no gold field, the two stores are separate directories the pool holds no reference
to, and the kit runs a recursive byte scan over the whole pool directory after a real run.
The scan looks for the gold in plaintext **and** in base64, because base64 is the one
encoding by which patch material rides into a sealed spec at all (`testMaterial[].content`).

## The admission port's answer is data, not truth

The port is a foreign adapter owned by the composing application and may be remote. Before
a receipt is published and cited, `runDerivation` checks every binding by which that receipt
names the pair it is supposed to be about: `goldPatchHash` against the stored gold
(`gold-mismatch`), and `task.documentDigest`, `task.evaluationSpecDigest` and
`environment.recordDigest` against the sealed pair and the record
(`receipt-mismatch`). A stale, swapped or buggy response fails the pair instead of being
written into `PoolEntry.receiptDigest`, which is the field every downstream consumer joins
on to claim this pair earned a receipt.

## Operational notes

- **Crash residue.** Both stores publish by directory/file rename, so a process killed
  mid-`put` leaves a `<pool>/.staging/<addr>.<suffix>/` directory or a
  `<gold>/.<addr>.<suffix>` file behind. Neither is ever read: `get` and `list` see only
  published entries, so residue is a disk-hygiene matter, not a correctness one. There is no
  automatic sweep — delete the dot-prefixed leftovers when reclaiming space.
- **`JINN_UPDATE_FIXTURES=1`.** Set in the environment, this turns the golden-fixture kit
  (`src/kit/golden.test.ts`) from a byte-exactness check into a fixture rewriter. It exists
  for `yarn fixtures:update`; exporting it in a shell where you then run `yarn test`
  silently disarms the check. CI never sets it.

## `provenance.sourceCommitment` (this field's first writer)

Rule `network.jinn.source-commitment/1`. The commitment is
`sha256:<hex>` over the RFC 8785 canonical JSON of exactly five strings:

    {"dataset":…,"instanceId":…,"revision":…,"rule":"network.jinn.source-commitment/1","statementDigest":"sha256:…"}

where `statementDigest` is sha256 over the statement's UTF-8 bytes, verbatim. Canonical
JSON rather than a delimiter-joined string so a separator inside a dataset name cannot
forge a different tuple; the rule id inside the hashed bytes so a future rule cannot
collide with this one; the statement inside it so an upstream row edited in place yields a
different commitment. Recompute it with `sourceCommitmentPreImage` — the pre-image is
exported for exactly that reason.

## The environment-record reference

The sealed EvaluationSpec's `deterministic-process` block carries
`"network.jinn.environment.record": {"digest": {"sha256": "<bare hex>"}}`. Bare hex, like
every other DigestSet in the stack. `image`, `platform` and `parser` stay inline **copied
from the record**, so admission's inline-match rule holds by construction: a `Candidate`
has no field for any of the three, so a strategy has nowhere to put a disagreeing value. A
first-class field is proposed upstream; this key is the interim carrier.

## Licence (D12)

Each task records `payload.rights.sourceLicense` as an SPDX expression, inherited from the
row and filtered against a licence allowlist the caller supplies explicitly. Declared, not
detected: this package checks that a producer supplied an expression, never that the
expression is true of the source.

## Not in v1

No injection strategies, no statement generation, no echo mining, no emergent-bug
harvesting (all named extensions). No posting — production ends at the pool. No pricing. No
row fetching: callers materialize rows; this package opens no socket and holds no key.

## Usage

```ts
import { randomUUID } from "node:crypto";
import {
  PERMISSIVE_LICENSE_ALLOWLIST,
  createFilesystemGoldStore,
  createFilesystemSupplyPool,
  importStrategy,
  loadDerivationEnvironment,
  runDerivation,
  type AdmissionPort,
} from "@jinn-network/task-derivation";

// The adapter binding C3's admitCandidate + sealReceipt to this port belongs to the
// composing application: both need injected deps and a signer, and this package holds
// neither.
declare const admission: AdmissionPort;

const env = loadDerivationEnvironment(await readEnvironmentRecordBytes());

const summary = await runDerivation(
  {
    admission,
    pool: createFilesystemSupplyPool({ dir: "./pool", uniqueSuffix: () => randomUUID() }),
    goldStore: createFilesystemGoldStore({ dir: "./gold", uniqueSuffix: () => randomUUID() }),
  },
  importStrategy,
  env,
  {
    rows: await materializeUpstreamRows(),
    upstream: { dataset: "nebius/SWE-rebench", revision: "refs/convert/parquet-2026-05-01" },
    defaultTimeoutSeconds: 900,
    licensePolicy: { allow: PERMISSIVE_LICENSE_ALLOWLIST },
  },
);

console.log(summary.written.length, summary.refused, summary.failed);
```

A refusal is an outcome, not an error: refused candidates are summarized and discarded, and
nothing is written for them. A per-candidate `DerivationError` becomes a `failed` row and
the run continues; anything else — a port outage, a full disk — propagates and aborts the
run, because a summary full of spurious failures is worse than a run that stops.
