# Conformance Runbook

**Scope:** `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §4.10

This runbook explains how to run the Jinn envelope conformance suite against your executor
builds and how to interpret the results.

---

## Why conformance?

Every executor that participates in the Jinn Network produces a `SignedEnvelope` for each
restoration and verdict it delivers. Conformance testing verifies that those envelopes:

1. **Conform structurally** (Layer 1) — schema, payload, hash, signature, trajectory chain,
   span profile, artifact vocabulary, and verdict integrity.
2. **Honour traced-I/O boundaries** (Layer 2, attested tier only) — all LLM calls, MCP tool
   calls, subprocess spawns, socket connections, and artifact writes go through the measured
   wrappers declared in the TEE scope document.

Failing conformance means your envelope will be rejected by verifiers and evaluators. Running
it locally before submitting saves debugging time.

---

## How to run

```bash
# Basic: human-readable summary, exits 0 on PASS / 1 on FAIL
jinn conformance --envelope-cid <cid>

# Skip Layer 2 source-bundle checks (non-attested tier, or quick smoke-check)
jinn conformance --envelope-cid <cid> --skip-layer2

# Machine-readable JSON output for CI automation
jinn conformance --envelope-cid <cid> --json
```

The CID is the IPFS CID of your `SignedEnvelope` object (the same value stored on-chain /
delivered to the marketplace). The tool fetches it from your configured IPFS gateway
(`ipfsGatewayUrl` in `~/.jinn-client/config.json`, default: `https://gateway.autonolas.tech`).

**Example output (human-readable):**

```
Conformance report for bafybeiabc123...
  Tier   : self-signed
  Summary: 6/11 passed, 0 failed, 5 skipped
  Layer 1: PASS
  Layer 2: N/A (not attested tier)
  Overall: PASS

  [ok  ] [L1] envelope.schema
  [ok  ] [L1] envelope.payload
  [ok  ] [L1] envelope.hash-signature
  [-   ] [L1] trajectory.schema: envelope.trajectory is null
  [-   ] [L1] trajectory.hash-chain: envelope.trajectory is null
  [-   ] [L1] trajectory.span-profile: envelope.trajectory is null
  [ok  ] [L1] artifacts.vocabulary
  [ok  ] [L1] artifacts.linkage
  [-   ] [L1] verdict.back-ref: restoration role — not applicable
  [-   ] [L1] verdict.verification-record: restoration role — not applicable
  [ok  ] [L1] secret-scrub.compliance
```

`[-]` = skipped (legitimately not applicable). `[ok]` = passed. `[FAIL]` = failed.

---

## Layer 1 checks (structural — every envelope, every tier)

| Check ID | What it tests |
|---|---|
| `envelope.schema` | Full envelope against `SignedEnvelopeSchema` (Zod). |
| `envelope.payload` | Payload against `SOLVER_TYPE_PAYLOADS[solverType][role]` for the declared SolverType + role. |
| `envelope.hash-signature` | Recomputes `keccak256(JCS(envelope - signature))` and verifies it matches `signature.hash`; then recovers the signer from `(hash, sig)` and checks it matches `signature.signer`. |
| `trajectory.schema` | Full trajectory against `JinnTrajectoryV1Schema`. Skipped when `envelope.trajectory` is null. |
| `trajectory.hash-chain` | Every span's `jinn.prevSpanHash` matches the hash of the previous span (span[0] links to genesis = `keccak256(JCS({ runStart: taskCid }))`). Skipped when trajectory is absent. |
| `trajectory.span-profile` | Every span has the required attributes for its `jinn.span.kind` per `SPAN_PROFILE`. Unknown kinds fail immediately. |
| `artifacts.vocabulary` | Required artifact types are present: `output.<solverType>` (always for solution), `system_snapshot` (solution), `trajectory` (when `envelope.trajectory` is non-null). |
| `artifacts.linkage` | Bidirectional: every `artifact.metadata.producedBy.spanId` references a real span; every `jinn.artifact.emit` span's `jinn.artifact.cid` is in `envelope.artifacts[]`. |
| `verdict.back-ref` | Verdict-role only: `payload.solutionEnvelope.sha256` matches the fetched bytes of the referenced solution envelope. Legacy `payload.restorationEnvelope` is accepted on read. Skipped on solution envelopes. |
| `verdict.verification-record` | Verdict-role only: `payload.verificationOfRestoration` is structurally valid (claimedTier, sdkVersion, timestamp, non-empty checks[], overall). |
| `secret-scrub.compliance` | No raw credentials in span attributes (Bearer tokens, API keys, JWTs, hex private keys) on attribute names matching `*.authorization`, `*.apiKey`, `*.bearer`, `*.password`, `*.secret`, `*.token`, `*.privateKey`. Properly scrubbed `<redacted:name>` markers pass. |

---

## Layer 2 checks (traced-I/O boundary — attested tier only)

Layer 2 checks only run when `envelope.evidenceTier === 'attested'` and the source bundle
is available (`envelope.executor.source.bundleCid`). They verify the executor source code
honours the measured-wrapper contract.

| Check ID | What it tests |
|---|---|
| `source.traced-http` | No string literal containing an LLM provider hostname (`api.anthropic.com`, `api.openai.com`, etc.) outside `src/trajectory/wrappers/http.ts` or `llm.ts`. |
| `source.mcp-shim` | No `@modelcontextprotocol/sdk` import or `MCPClient`/`Client` instantiation outside `src/trajectory/wrappers/mcp.ts`. |
| `source.subprocess` | No `child_process`, `execa`, `Bun.spawn`, or `Deno.Command` import/call outside `src/trajectory/wrappers/subprocess.ts`. |
| `source.raw-sockets` | No `net.createConnection`, `tls.connect`, or their imports outside `src/trajectory/wrappers/socket.ts` or `http.ts`. |
| `source.dynamic-code` | No `eval(...)`, `new Function(...)`, `vm.runIn*()`, or non-literal `import(expr)` anywhere. Statically-analysable relative imports (`import('./plugin.js')`) pass. |
| `source.artifact-emit` | No file that imports `fs` AND references IPFS/CID semantics AND calls `fs.writeFile` directly, unless the file is the canonical artifact-emit helper (`src/trajectory/artifacts.ts` or `src/harnesses/engine/packaging.ts`). |

**V2 runtime stubs (always skipped in V1):**

| Check ID | What it will test in V2 |
|---|---|
| `runtime.seccomp` | Executor seccomp-bpf policy matches TEE attestation manifest. |
| `runtime.namespace` | Executor runs in declared Linux namespace isolation profile. |
| `runtime.tls-transcript` | Captured TLS transcripts cover all outbound connections; every SNI is in the declared egress allowlist. |

---

## Layer 2 = `N/A`

When `layer2Passed = 'N/A'` in the report (or `Layer 2: N/A (not attested tier)` in
human output), your envelope declares `evidenceTier: 'self-signed'` or `'committed'`. Layer 2
checks only apply to the `'attested'` tier. This is expected for most V1 operators.

---

## Common failures and fixes

### `envelope.schema`: schemaVersion
```
envelope.schema FAIL: schemaVersion: Invalid literal value, expected 'jinn.execution.v1'
```
Your envelope was built with a newer or older version of the assembly library. Upgrade
`operator/src/harnesses/engine/envelope-assembly.ts` to match the current schema.

### `envelope.hash-signature`: hash mismatch
```
envelope.hash-signature FAIL: signature.hash 0xabc... does not match keccak256(JCS(…))=0xdef...
```
A field was mutated after signing. Check that nothing modifies the envelope object after
`assembleAndSignEnvelope` returns. Common culprit: adding/deleting keys in a JSON
serialise-deserialise round-trip before upload.

### `trajectory.hash-chain`: prevSpanHash
```
trajectory.hash-chain FAIL: span[3] (mySpanId): prevSpanHash 0x... !== expected 0x...
```
Your trajectory builder set the wrong `jinn.prevSpanHash` on span[3]. Use
`computePrevSpanHash(span[n-1])` from `src/trajectory/hash-chain.ts` to derive each
value, and `computeGenesisHash(taskCid)` for span[0].

### `trajectory.span-profile`: missing required attribute
```
trajectory.span-profile FAIL: span[1] (bbbb…) kind=jinn.llm_call missing required attributes: gen_ai.system
```
Add the missing attribute to your span before recording. See `SPAN_PROFILE` in
`src/trajectory/span-profile.ts` for the full list per kind.

### `artifacts.vocabulary`: missing output type
```
artifacts.vocabulary FAIL: missing required artifactTypes: output.portfolio.v0
```
Your envelope does not include an artifact with `artifactType: 'output.portfolio.v0'`.
The output artifact must be uploaded to IPFS and listed in `envelope.artifacts[]` with
the correct `artifactType`.

### `secret-scrub.compliance`: raw credential
```
secret-scrub.compliance FAIL: span sp42 attr "http.request.header.authorization" appears to contain a raw credential
```
A `Bearer` token or API key was left unredacted in a span attribute. Replace the value
with `<redacted:authorization>` before serialising the trajectory.

### `source.traced-http`: raw LLM egress (Layer 2)
```
source.traced-http FAIL: src/lib/claude.ts:12: await fetch('https://api.anthropic.com/v1/messages'…)
```
Route all LLM calls through the measured HTTP wrapper at
`src/trajectory/wrappers/http.ts`. Remove direct `fetch`/`axios` calls to provider
hosts from all files outside the wrapper allowlist.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | PASS — all non-skipped checks passed. |
| `1` | FAIL — one or more checks failed. See the report for details. |
| `40` | Unexpected error (network, parse failure, etc.). |

---

## What V2 adds

When the V2 TEE integration plan ships, the three runtime stubs will become real checks:
- `runtime.seccomp` — reads the attested binary's seccomp manifest and verifies it matches
  the reference policy in the TEE attestation quote.
- `runtime.namespace` — verifies the network namespace and bind-mount policy.
- `runtime.tls-transcript` — verifies captured TLS key logs (BoringSSL SSLKEYLOGFILE /
  eBPF tap) cover every outbound connection and every SNI is in the declared egress
  allowlist.

No harness refactor will be required — the stubs are already placed in the correct ordering
and the V2 plan will replace their bodies.

---

*See `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §4.10 for the
full normative definition of each check.*
