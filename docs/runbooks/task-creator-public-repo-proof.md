# Task Creator public-repository G0b proof

This runbook operates the explicit-recipe G0b coding adapter. It never treats a
repository checkout, a base image, or a test patch as trusted merely because it
is public. The normal Task Creator generator, quota, escrow, claim policy, and
posting path remain unchanged.

## Hermetic gate

Run the offline proof first:

```sh
cd operator
yarn task-creator:public-repo-e2e
```

It uses a digest-qualified `localhost:5000` mock-registry reference and mock
IPFS/evaluator data. It proves these invariants without Docker, GitHub, IPFS,
or chain access:

- synthetic parser-contract empty/gold/broken Vitest JSON observations derive
  the expected parser output shape;
- Jinn and `unjs/destr` use the same `vitest-json.v1` parser contract and the
  approved explicit recipe adapter;
- the resulting `swe-rebench-v2-minted-pool.v2` row joins the unchanged
  `PoolTask` selection, synthetic quota, escrow, and claim guards; and
- the public row hash excludes the local gold patch.

This is not a public-testnet proof. It creates no image, IPFS object, task,
delivery, or verdict.

Run the separate deterministic on-chain lifecycle gate when Foundry is
available:

```sh
yarn task-creator:public-repo-anvil-e2e
```

It really spawns Anvil, deploys the TaskCoordinator/Router stack, and drives
parser-contract fixtures through task creation, claim, solution delivery,
evaluator claim, verdict delivery, finalization, and corpus-envelope
projection. It also has a receipt-bound, test-only Jinn contract fixture that
records task, environment, receipt, artifact, delivery, verdict, and corpus
references. Neither is a Docker/repository empirical grade.

## Fixture identities and source-data caveat

| Record | Base | Fix | Instance |
| --- | --- | --- | --- |
| Jinn Vitest parser-contract fixture only | `c7701007c7c7c3b1005e263ce151adf700465b58` | `5b76bade319857bd09a72c3c4aaf0949cfe078ee` | `Jinn-Network__mono__echo-5b76bade3198` |
| Jinn real differential source | `ae8093a8848e70e581f46d66dcdb56789c0808a3` | `ef9608876511b4dff000cda1537ff7c1a227677d` | `Jinn-Network__mono__echo-ef9608876511` |
| unjs/destr parser-contract fixture only | `37210516ccef951dcc870f17a5abee52122a3122` | `d9ba16d7ad5c3afb6d8c8e84f6d24dba616013fe` | `unjs__destr__echo-d9ba16d7ad5c` |

`5b76bade…` is a documentation-only historical merge and is retained solely
for Vitest JSON parser-contract coverage. It must never be used as a Jinn
empirical, admission, mint, or public-testnet proof.

The real Jinn source has the two reviewed regression paths
`operator/test/daemon/daemon-recovery-nonblocking.test.ts` and
`operator/test/harnesses/engine/recovery.test.ts`. It needs a generated,
sanitised differential-admission receipt: two stable broken and two stable
fixed targeted observations per path, their F2P/P2P sets, public test-patch
hash, gold-patch hash only, image/parser/platform/environment bindings, and
the evaluator semantics version. The published CID and canonical receipt hash
must both match the candidate and the eventual minted v2 row.

Status (rechecked 2026-07-13): no real Jinn differential receipt is checked in
or published, and no Jinn public-testnet success exists. The archive
export/import integration now passes locally, but that test did not produce a
signed Jinn image, CID, or receipt. The live sequence is blocked before
publication: `$HOME/secure/jinn-environment-publish.json` is missing (so its
IPFS registry and external signer command are unavailable), and
`JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS` is unset. Docker has a GHCR
credential configuration, which is necessary but insufficient. Separately,
`JINN_TASK_CREATOR_IPFS_GATEWAY_URL` is unset; it is needed for later
mint/network preflight and the network wrapper, not for the local
publication/receipt/offline-verification/Anvil sequence. A real receipt exists
only after the exact sequence below completes; it must not be represented by a
fixture, locally retagged image, or unsigned environment.
The real receipt command additionally requires an externally approved
`operatorSafe:signer` policy pair. It pins the exact explicit Jinn recipe and
its test-command template, then rejects an otherwise valid self-signed
environment from any other attester. There is deliberately no implicit trusted
attester in the command.

## Real Jinn differential receipt

This is a local empirical gate, not a testnet operation. All paths below are
operator-controlled and must be access-controlled. Replace angle-bracket values
with the public identifiers returned by the immediately preceding command;
never add signing material or registry credentials to a command argument, a
tracked file, or an environment-spec JSON file.

```sh
cd operator

# First review this side-effect-free config parse.
yarn task-creator:environment-publish --config "$HOME/secure/jinn-environment-publish.json"

# Then build, scan, SBOM, push, sign, upload, and atomically retain the exact
# signed spec. Record environmentCid, environmentHash, and imageReference from
# its JSON result.
JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE=1 \
  yarn task-creator:environment-publish \
    --config "$HOME/secure/jinn-environment-publish.json" \
    --output "$HOME/secure/jinn-signed-environment.json"

# Use the exact digest-qualified imageReference returned above; Docker uses the
# operator's ambient credential helper for this pull, not the builder's config.
docker pull --platform linux/amd64 '<imageReference>'
docker image inspect '<imageReference>' --format '{{json .}}'

# The proof command repeats the pull/inspect binding and then performs exactly
# two broken and two fixed runs for each of the two reviewed paths (eight total).
yarn task-creator:jinn-differential-e2e \
  --environment-spec "$HOME/secure/jinn-signed-environment.json" \
  --approved-attester '<operatorSafe>:<signer>' \
  --output "$HOME/secure/jinn-differential-receipt.json" \
  --ipfs-registry 'https://<credential-free-ipfs-registry>'

# Record receiptCid and receiptHash from the result, then verify the exact
# receipt bytes offline. This command makes no Docker, registry, or IPFS call.
yarn task-creator:jinn-differential-e2e \
  --verify "$HOME/secure/jinn-differential-receipt.json" \
  --environment-spec "$HOME/secure/jinn-signed-environment.json" \
  --approved-attester '<operatorSafe>:<signer>' \
  --expected-receipt-hash '<receiptHash returned by generation>'

# Only after generation and offline verification both return successfully,
# use the exact generated CIDs and receipt SHA to record receipt-bound local
# Anvil lifecycle evidence. This does not repeat or replace the empirical
# Docker result; the differential-admission receipt remains that result.
yarn task-creator:jinn-differential-anvil-e2e \
  --environment-spec "$HOME/secure/jinn-signed-environment.json" \
  --environment-cid '<environmentCid returned by publication>' \
  --receipt "$HOME/secure/jinn-differential-receipt.json" \
  --receipt-cid '<receiptCid returned by generation>' \
  --expected-receipt-hash '<receiptHash returned by generation>' \
  --approved-attester '<operatorSafe>:<signer>' \
  --evidence-output "$HOME/secure/jinn-receipt-bound-anvil-evidence.json"
```

The digest-qualified image inspection must show `linux/amd64`, a valid immutable
local `Id`, and a `RepoDigests` entry equal to `<imageReference>`. The receipt
and its receipt-bound Anvil lifecycle evidence may be checked in only after
generation returns a real receipt CID and SHA, the offline command succeeds,
and the receipt-bound Anvil command succeeds. The Anvil command verifies and
binds those exact environment/receipt CIDs and receipt SHA before it starts
Anvil; its evidence is lifecycle-only, not a second empirical Docker result.
Its eventual v2 entry must bind the same environment CID/hash, image reference,
receipt CID, and receipt hash.

## Live mint preflight and admission

The live commands require caller-owned external configuration. They do not
accept a private key, password, or registry credential; Docker's preconfigured
credential helper and each operator's existing config own those secrets.
`JINN_TASK_CREATOR_REGISTRY_AUTH_REF` must be a helper name of the form
`docker-credential-<name>`, never a token or password. The RPC and registry
URLs may not contain user-info, query parameters, or fragments because the
preflight and temporary runner document deliberately remain secret-free.

```sh
export JINN_TASK_CREATOR_RPC_URL='https://your-testnet-rpc.example'
export JINN_TASK_CREATOR_REGISTRY_URL='https://ghcr.io/jinn-network/task-environment'
export JINN_TASK_CREATOR_IPFS_GATEWAY_URL='https://your-ipfs-gateway.example/ipfs/'
export JINN_TASK_CREATOR_REGISTRY_AUTH_REF='docker-credential-ghcr'
export JINN_TASK_CREATOR_MINTER_OPERATOR='0x...'
export JINN_TASK_CREATOR_SOLVER_OPERATOR='0x...'
export JINN_TASK_CREATOR_EVALUATOR_OPERATOR='0x...'
# Comma-separated externally approved operatorSafe:signer pair(s), used only
# for the exact reviewed Jinn differential source. The values are public
# addresses, not a private key or credential.
export JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS='0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222'
export JINN_TASK_CREATOR_CANDIDATES_FILE="$HOME/secure/jinn-mono-candidates.json"
# Generated by `yarn task-creator:jinn-differential-e2e` only after it used
# a published signed environment spec and local digest-bound image.
export JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_PATH="$HOME/secure/jinn-differential-receipt.json"
# Use an actual CIDv0 (`Qm…`) or lowercase-base32 CIDv1 (`bafy…`), never a
# readable fixture label or a synthetic placeholder.
export JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_CID='QmYwAPJzv5CZsnAzt8auVTLF9rYx8S1R52eX5GJH2RGfZp'
export JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_HASH='sha256:...'

cd operator
yarn task-creator:mint-preflight:jinn-mono
# or: yarn task-creator:mint-preflight:unjs-destr
```

The Jinn mint preflight requires three distinct addresses, the exact real source
identity above, and a signed evaluator environment specification. It strictly
parses the candidate's v2 `environment` binding, then the authoritative mint
boundary fetches/parses/verifies that signed environment and its EIP-191
attestation before any legacy route can run. For this exact Jinn source it also
requires `JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS` and verifies the canonical
`resolveJinnMonoRecipeV1(baseCommit)` provider, recipe hash, and command
template; generic public repositories retain their normal explicit-environment
path. The live preflight and network wrapper also fetch the signed environment
from `JINN_TASK_CREATOR_IPFS_GATEWAY_URL` and reject an authentic but
unapproved signer before starting the operator-owned runner. Its secret-free
runner document preserves the approved attester pairs, IPFS gateway, and
environment binding; the runner must re-fetch and apply the same policy before
it launches external work. The exact Jinn source cannot be minted without that environment, reviewed
`fixCommit`, receipt content, receipt hash, and pre-published receipt CID. It
rejects placeholder shapes such as
`{ "image": "mock" }`, malformed receipts, attestation failures, and
receipt/environment/row/CID drift. It prints only identifiers and the impending
mint command, then exits without a registry push, IPFS upload, task, delivery,
or verdict.

The candidate file stays local and access-controlled. It may contain a local
gold patch for admission, but no published row or IPFS pool artifact may contain
that patch. Its required shape is:

```json
[
  {
    "poolTask": { "instance_id": "Jinn-Network__mono__echo-ef9608876511", "repo": "Jinn-Network/mono", "base_commit": "ae8093a8848e70e581f46d66dcdb56789c0808a3", "fix_commit": "ef9608876511b4dff000cda1537ff7c1a227677d", "language": "typescript", "test_patch": "public test patch" },
    "goldPatch": "local admission material; never publish",
    "fixCommit": "ef9608876511b4dff000cda1537ff7c1a227677d",
    "provenance": { "synthetic": true, "mintFamily": "commit-echo", "sourceLineageHash": "sha256:…" },
    "environment": { "environmentSpecCid": "published signed environment CID", "environmentHash": "sha256:…", "image": { "reference": "…@sha256:…", "digest": "sha256:…" }, "platform": "linux/amd64", "parser": { "id": "vitest-json.v1", "version": "v1", "digest": "sha256:…", "bundleId": "jinn.swe-rebench-v2.patch-bundle.v1" }, "attestation": { "scheme": "eip191", "algo": "secp256k1", "environmentHash": "sha256:…", "operatorSafe": "0x…", "signer": "0x…", "signature": "0x…" } },
    "differentialAdmission": { "receipt": "sanitised receipt object", "receiptHash": "sha256:…", "receiptCid": "Qm… or bafy… actual CID" }
  }
]
```

After checking the candidate’s rights references, base image, SBOM, secret scan,
signed environment attestation, receipt binding, and parser bundle digest,
deliberately opt in:

```sh
export JINN_TASK_CREATOR_MINT_EXECUTE=1
yarn task-creator:mint-preflight:jinn-mono --execute
```

This invokes the existing `jinn solver-nets mint-tasks swe-rebench-v2` admission
path with the v2 environment binding intact. It is allowed to perform the
configured evaluator/image/IPFS work, but it does not by itself prove on-chain
delivery or a verdict.

## Guarded network/factory execution

Mint admission and a network lifecycle are different operations. The network
command delegates to an operator-owned factory runner that must create/post the
task and coordinate the distinct minter, solver, and evaluator. The wrapper
writes a temporary, mode-`0600`, secret-free JSON file containing the selected
fixture, RPC URL, registry URL, credential-helper reference, operator addresses,
and local candidates-file path; it never copies a private key or registry
credential into that file.

```sh
export JINN_TASK_CREATOR_NETWORK_ORCHESTRATOR='/absolute/path/to/operator-network-runner'
yarn task-creator:network-proof:jinn-mono

# only after reviewing the generated config and operator runner:
export JINN_TASK_CREATOR_NETWORK_EXECUTE=1
yarn task-creator:network-proof:jinn-mono --execute
```

The runner receives `--task-creator-public-repo-config <temporary-json-path>`.
It must write task/artifact/delivery/verdict/corpus receipts itself. A runner
that performs only mint admission is not a network proof and must report that
fact rather than a success.

## Public-testnet evidence

The Anvil lifecycle gate above is required before a public testnet run. It is
safe and deterministic but remains a synthetic parser-contract fixture, so it
does not establish a real source-derived grade.

Only after the Anvil loop succeeds, repeat against the selected public testnet
with the three distinct configured operator identities above and a reviewed
source-derived candidate. Archive the task, artifact, delivery, verdict, and
corpus receipts. The guarded commands do not manufacture identities or funds,
and they intentionally make no claim that this public-testnet proof has run.
