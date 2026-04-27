# Envelope V1 — Plan G: Subgraph GraphQL Schema + KnowledgeTree Synthetic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the deployable subgraph that indexes Plan E's ERC-8004 Identity + Validation Registry writes and projects them as a queryable GraphQL graph rooted at each intent. The subgraph exposes `Intent`, `ExecutionEnvelope`, `Artifact`, `SourceBundle`, `Agent`, plus a synthetic `KnowledgeTree` aggregate that joins restorations + verdicts + attested-fraction counts for a given intent CID. The client's `discovery/subgraph.ts` gets a second life: a new `getKnowledgeTree(intentCid)` query, a `getEnvelopesBySource(sourceBundleCid)` lineage query, and rewritten versions of today's `queryArtifacts` / `queryNodes` against the V1 schema.

**Architecture:** New top-level deployable at `subgraph/` — a standard Graph subgraph project with `package.json`, `subgraph.yaml`, `schema.graphql`, AssemblyScript `src/mapping.ts`, copied ABIs, and `matchstick-as` tests. Data flow: Plan E writes metadata tuples to the on-chain Identity Registry (and challenger verdicts to the Validation Registry). The subgraph's `Register` handler dispatches on `documentType` (`adw:AgentCard` | `adw:Intent` | `adw:ExecutionEnvelope` | `adw:SourceBundle` | `adw:Artifact`) and populates the matching entity. Envelope-to-intent and verdict-to-parent-envelope linking happens in the mapping via lookups into prior entities. `KnowledgeTree` is an aggregate entity rewritten every time a related envelope registers — no resolver magic, just entity writes from the mapping. Client queries hit the subgraph via a thin GraphQL client (kept dep-free, as today).

**Tech Stack:** AssemblyScript (compiled to WASM by the Graph toolchain), `@graphprotocol/graph-cli`, `@graphprotocol/graph-ts`, `matchstick-as` for subgraph unit tests, Docker (local `graph-node` + IPFS + Postgres for dev), Vitest (client-side query tests).

**Non-goals for this slice:**
- No trajectory content indexing — scope §5 explicit non-goal. The subgraph indexes envelope/artifact/trajectory *metadata* only (CIDs, sha256, types). Querying span-level content ("spans where model = claude-opus-4-7") is a buyer-side or V2 indexer.
- No mainnet deployment. V1 deploys to Base Sepolia only; mainnet wiring is post-Phase 1b.
- No cross-chain aggregation. One subgraph per chain. Cross-chain is a V2 concern.
- No search-as-a-service / buyer catalog. Catalog surfaces and gating live in sibling epic D8.
- No changes to Plan E's on-chain writes — this plan strictly consumes them.
- No client UI / explorer. Frontend is out of scope entirely.

**Before you start:** Plans A (JCS), B (intent.v1), C (generic envelope), E (envelope registration on ERC-8004) must be merged. Plan G reads what Plan E writes; without Plan E's metadata tuples, the subgraph has nothing to index. Plan D (trajectory) is independent but helpful — envelopes will still populate even without trajectory CIDs (those fields are nullable).

**Reference:** `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §3.3 ("Subgraph knowledge graph" row, "Trajectory content indexing" row), §4.9 (subgraph GraphQL deliverable), §5 non-goal "Trajectory content indexing". Legacy precedent: `legacy/jinn-cli-agents-reference/docs/reference/ponder-graphql.md` is the Ponder indexer from the old repo — different indexer (Ponder vs Graph), but useful for cross-referencing data shapes and query patterns.

---

## File structure

New files:
- `subgraph/package.json` — deps on `@graphprotocol/graph-cli`, `@graphprotocol/graph-ts`, `matchstick-as`.
- `subgraph/subgraph.yaml` — datasources for `IdentityRegistry` + `ValidationRegistry` per chain.
- `subgraph/schema.graphql` — GraphQL schema (Agent, Metadata, Intent, ExecutionEnvelope, Artifact, SourceBundle, KnowledgeTree, ValidationRequest, ValidationResponse).
- `subgraph/networks.json` — per-network contract address + start block config (Base Sepolia initially).
- `subgraph/src/mapping.ts` — top-level `handleRegister` + `handleValidationRequest` + `handleValidationResponse` dispatchers (dispatch-on-documentType).
- `subgraph/src/handlers/agent.ts` — `handleAgentCard`.
- `subgraph/src/handlers/intent.ts` — `handleIntent`.
- `subgraph/src/handlers/envelope.ts` — `handleEnvelope` (restoration or verdict branches, parent-envelope linking).
- `subgraph/src/handlers/source-bundle.ts` — `handleSourceBundle`.
- `subgraph/src/handlers/artifact.ts` — `handleArtifact`.
- `subgraph/src/handlers/knowledge-tree.ts` — `upsertKnowledgeTree` (called from envelope handler after an envelope write).
- `subgraph/src/handlers/validation.ts` — `handleValidationRequest` / `handleValidationResponse`.
- `subgraph/src/lib/metadata.ts` — utility: `getMetadataValue(tuples, key): string | null`, `decodeBytesToString(Bytes): string`, dispatch helper.
- `subgraph/abis/IdentityRegistry.json` — copy from the 8004 contracts Plan E uses.
- `subgraph/abis/ValidationRegistry.json` — same.
- `subgraph/tests/agent.test.ts` — matchstick-as tests for the AgentCard handler.
- `subgraph/tests/intent.test.ts` — tests for the Intent handler.
- `subgraph/tests/envelope.test.ts` — tests for restoration + verdict handling + parent linking.
- `subgraph/tests/source-bundle.test.ts` — tests for SourceBundle.
- `subgraph/tests/artifact.test.ts` — tests for Artifact + parent-envelope linking.
- `subgraph/tests/knowledge-tree.test.ts` — tests for KnowledgeTree aggregate updates.
- `subgraph/tests/validation.test.ts` — tests for Validation Registry handlers.
- `subgraph/README.md` — deployment guide (local graph-node docker + Studio deploy).
- `subgraph/docker-compose.yml` — local dev (graph-node + IPFS + Postgres).
- `subgraph/.gitignore` — build artefacts.

Modified files:
- `client/src/discovery/subgraph.ts` — rewrite `queryArtifacts` + `queryNodes` against V1 schema; add `getKnowledgeTree`, `getEnvelopesBySource`, `getIntent`, `getEnvelopesForIntent`.
- `client/test/discovery/subgraph.test.ts` — new file; tests use `fetch` mocks returning canned GraphQL responses (no live subgraph required).
- Root `package.json` — if the monorepo has workspaces, add `subgraph` to the list. (If not, subgraph stands alone — no root change.)
- `.github/workflows/subgraph-build.yml` (if CI exists) — build check. Optional; flagged in Task 13.

---

## Task 1: Scaffold the `subgraph/` project

**Files:**
- Create: `subgraph/package.json`
- Create: `subgraph/.gitignore`
- Create: `subgraph/tsconfig.json` (minimal — `assemblyscript` compiles via the Graph CLI, not tsc)
- Create: `subgraph/networks.json` (stub for Base Sepolia)

- [ ] **Step 1: Confirm directory doesn't exist**

```bash
ls /Users/adrianobradley/harbor/jinn-v1-plans/subgraph 2>&1
```

Expected: "No such file or directory". If the dir exists, abort — someone started already.

- [ ] **Step 2: Create the project directory + `package.json`**

```bash
mkdir -p subgraph/src/handlers subgraph/src/lib subgraph/tests subgraph/abis
```

Write `subgraph/package.json`:

```json
{
  "name": "@jinn/subgraph",
  "version": "0.1.0",
  "description": "ERC-8004 subgraph indexing Jinn intents, execution envelopes, artifacts, and source bundles into a queryable knowledge graph.",
  "license": "MIT",
  "private": true,
  "scripts": {
    "codegen": "graph codegen",
    "build": "graph build",
    "test": "graph test",
    "create-local": "graph create --node http://localhost:8020/ jinn/jinn-v1",
    "remove-local": "graph remove --node http://localhost:8020/ jinn/jinn-v1",
    "deploy-local": "graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 jinn/jinn-v1",
    "deploy-studio": "graph deploy --studio jinn-v1"
  },
  "dependencies": {
    "@graphprotocol/graph-cli": "0.80.0",
    "@graphprotocol/graph-ts": "0.35.1"
  },
  "devDependencies": {
    "matchstick-as": "0.6.0"
  }
}
```

- [ ] **Step 3: Write `subgraph/.gitignore`**

```
node_modules/
build/
generated/
*.log
.DS_Store
```

- [ ] **Step 4: Write `subgraph/tsconfig.json`** (used by editors, not the build)

```json
{
  "extends": "@graphprotocol/graph-ts/tsconfig.json",
  "include": ["src"]
}
```

If that base config is missing at install time, fall back to a minimal:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "node",
    "strict": true,
    "experimentalDecorators": true,
    "types": ["@graphprotocol/graph-ts"],
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write stub `subgraph/networks.json`**

Plan E's Base Sepolia deployment will land real addresses; stub here with placeholder format. Fill the `TODO` values from Plan E's deployment record once available:

```json
{
  "base-sepolia": {
    "IdentityRegistry": {
      "address": "0x0000000000000000000000000000000000000000",
      "startBlock": 0
    },
    "ValidationRegistry": {
      "address": "0x0000000000000000000000000000000000000000",
      "startBlock": 0
    }
  }
}
```

Add a comment in `README.md` (next task) reminding the operator to update these before deploy.

- [ ] **Step 6: Install deps**

```bash
cd subgraph && npm install
```

Expected: installs cleanly. If yarn is preferred and the monorepo uses workspaces, adapt. At the time of writing, The Graph tooling is more frequently tested with npm; switch only if a workspace issue forces it.

- [ ] **Step 7: Commit**

```bash
git add subgraph/package.json subgraph/.gitignore subgraph/tsconfig.json subgraph/networks.json subgraph/package-lock.json
git commit -m "chore(subgraph): scaffold @jinn/subgraph project

Standalone deployable under subgraph/ — Graph CLI + graph-ts +
matchstick-as. networks.json stubbed with Base Sepolia; real addresses
land once Plan E deploys."
```

---

## Task 2: Author `schema.graphql`

**Files:**
- Create: `subgraph/schema.graphql`

- [ ] **Step 1: Write the full GraphQL schema**

The schema mirrors scope §3.3 and the plan brief, with the ordering constraint that The Graph requires `@derivedFrom` reverse relations to reference an existing field on the other entity. Types:

```graphql
# Agent — the Identity Registry row. One per on-chain register() call. documentType distinguishes subtype.
type Agent @entity(immutable: false) {
  id: ID!                        # agent ID from Identity Registry (uint256 as string)
  agentURI: String!
  owner: Bytes!
  documentType: String!          # 'adw:AgentCard' | 'adw:Intent' | 'adw:ExecutionEnvelope' | 'adw:SourceBundle' | 'adw:Artifact'
  metadata: [Metadata!]! @derivedFrom(field: "agent")
  createdAt: BigInt!
  createdAtBlock: BigInt!
  createdAtTx: Bytes!
}

# Metadata — thin tuple keyed to an Agent. Plan E may register 5–15 tuples per agent.
type Metadata @entity(immutable: true) {
  id: ID!                        # `${agentId}-${metadataKey}`
  agent: Agent!
  metadataKey: String!
  metadataValue: Bytes!
  metadataValueString: String!   # utf-8 decoded convenience (subgraph mapping does the decode)
}

# Intent — derived from an Agent with documentType='adw:Intent'. One-to-one with Agent entity.
type Intent @entity(immutable: false) {
  id: ID!                        # intent CID
  kind: String!
  creator: Bytes!
  createdAt: BigInt!
  requestId: Bytes!
  agent: Agent!                  # backing Identity Registry row
  restorationEnvelopes: [ExecutionEnvelope!]! @derivedFrom(field: "intent")
  knowledgeTree: KnowledgeTree   # nullable until first envelope registers
}

# ExecutionEnvelope — restoration or verdict. Plan E writes documentType='adw:ExecutionEnvelope'.
type ExecutionEnvelope @entity(immutable: false) {
  id: ID!                        # envelope CID
  kind: String!
  role: String!                  # 'restoration' | 'verdict'
  evidenceTier: String!          # 'self-signed' | 'committed' | 'attested' | 'consensus' | 'proved'
  intent: Intent!
  parentEnvelope: ExecutionEnvelope  # nullable; for verdicts, references the restoration
  childVerdicts: [ExecutionEnvelope!]! @derivedFrom(field: "parentEnvelope")
  measurement: Bytes             # nullable; only populated at attested tier
  participant: Bytes!            # Safe address
  generatedAt: BigInt!
  createdAtBlock: BigInt!
  createdAtTx: Bytes!
  artifacts: [Artifact!]! @derivedFrom(field: "parentEnvelope")
  sourceBundle: SourceBundle     # nullable; resolved by bundleCid lookup if a bundle has already registered
  agent: Agent!
  # Validation records (if challengers have re-verified this envelope)
  validationRequests: [ValidationRequest!]! @derivedFrom(field: "envelope")
  validationResponses: [ValidationResponse!]! @derivedFrom(field: "envelope")
}

# Artifact — Plan E registers documentType='adw:Artifact' with parentEnvelopeCid metadata.
type Artifact @entity(immutable: false) {
  id: ID!                        # artifact CID
  artifactType: String!
  parentEnvelope: ExecutionEnvelope!
  tags: [String!]                # parsed from metadata JSON if present
  agent: Agent!
  createdAtBlock: BigInt!
  createdAtTx: Bytes!
}

# SourceBundle — registered once per release, referenced by executor.source.bundleCid.
type SourceBundle @entity(immutable: false) {
  id: ID!                        # bundle CID
  measurement: Bytes!
  buildRecipeKind: String!       # 'dockerfile' | 'nix' | 'bazel'
  humanUrl: String
  publishedBy: Bytes!            # Safe or EOA that registered
  envelopesUsing: [ExecutionEnvelope!]! @derivedFrom(field: "sourceBundle")
  agent: Agent!
  createdAtBlock: BigInt!
  createdAtTx: Bytes!
}

# KnowledgeTree — synthetic aggregate. Written by the envelope handler.
type KnowledgeTree @entity(immutable: false) {
  id: ID!                        # intent CID
  intent: Intent!
  totalRestorations: Int!
  totalVerdicts: Int!
  attestedRestorations: Int!
  attestedVerdicts: Int!
  attestedFraction: BigDecimal!  # (attestedRestorations + attestedVerdicts) / (totalRestorations + totalVerdicts)
  lastUpdatedBlock: BigInt!
}

# Validation Registry entities — mirror the on-chain challenger flow.
type ValidationRequest @entity(immutable: true) {
  id: ID!                        # request ID (bytes32 hex)
  envelope: ExecutionEnvelope!   # nullable in GraphQL sense — but we resolve at write time; if lookup fails the event is discarded with a log
  challenger: Bytes!
  scope: String!                 # e.g. 'attestation' | 'reproducible-build'
  requestedAt: BigInt!
  response: ValidationResponse   # nullable until the response fires
  createdAtBlock: BigInt!
  createdAtTx: Bytes!
}

type ValidationResponse @entity(immutable: true) {
  id: ID!                        # response ID (bytes32 hex)
  request: ValidationRequest!
  envelope: ExecutionEnvelope!
  validator: Bytes!
  overall: String!               # 'valid' | 'invalid'
  detail: String                 # optional free-form detail
  respondedAt: BigInt!
  createdAtBlock: BigInt!
  createdAtTx: Bytes!
}
```

- [ ] **Step 2: Codegen**

```bash
cd subgraph && npm run codegen
```

Expected: `generated/schema.ts` written with TS types for each entity. Fails if schema has syntax errors. Don't commit the `generated/` directory (it's in `.gitignore`); check it locally for sanity.

- [ ] **Step 3: Commit**

```bash
git add subgraph/schema.graphql
git commit -m "feat(subgraph): schema.graphql — V1 entities + KnowledgeTree aggregate

Matches scope §3.3. Entity set: Agent, Metadata, Intent, ExecutionEnvelope,
Artifact, SourceBundle, KnowledgeTree, ValidationRequest, ValidationResponse.
@derivedFrom relations for restoration/verdict/artifact/envelopes-using-source."
```

---

## Task 3: Copy ABIs from contracts repo + write `subgraph.yaml`

**Files:**
- Create: `subgraph/abis/IdentityRegistry.json`
- Create: `subgraph/abis/ValidationRegistry.json`
- Create: `subgraph/subgraph.yaml`

- [ ] **Step 1: Locate Plan E's 8004 contract artefacts**

```bash
ls contracts/out/IdentityRegistry.sol/IdentityRegistry.json 2>/dev/null
ls contracts/artifacts/contracts/discovery/IdentityRegistry.sol/IdentityRegistry.json 2>/dev/null
ls legacy/jinn-cli-agents-reference/ 2>/dev/null  # fallback reference
```

At least one should exist after Plan E lands. Take the Foundry `out/` or Hardhat `artifacts/` JSON. Extract just the ABI array (The Graph needs `[{...}]`, not the whole Foundry/Hardhat wrapper).

- [ ] **Step 2: Write `subgraph/abis/IdentityRegistry.json`**

Minimum required events per scope §3.3: `Register` (and `MetadataUpdate` if Plan E emits updates). Example ABI skeleton (fill with the real ABI):

```json
[
  {
    "type": "event",
    "name": "Register",
    "inputs": [
      { "name": "agentId", "type": "uint256", "indexed": true },
      { "name": "owner", "type": "address", "indexed": true },
      { "name": "agentURI", "type": "string", "indexed": false },
      {
        "name": "metadata",
        "type": "tuple[]",
        "components": [
          { "name": "metadataKey", "type": "string" },
          { "name": "metadataValue", "type": "bytes" }
        ],
        "indexed": false
      }
    ],
    "anonymous": false
  }
]
```

If Plan E uses a different event name (e.g. `Registered` or `AgentRegistered`), update accordingly — the source of truth is the deployed contract's emitted events, not this plan doc.

- [ ] **Step 3: Write `subgraph/abis/ValidationRegistry.json`**

Two events minimum: `ValidationRequested` (challenger files) and `ValidationResponded` (verdict attached). Fill from Plan E.

- [ ] **Step 4: Write `subgraph/subgraph.yaml`**

```yaml
specVersion: 1.0.0
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum/contract
    name: IdentityRegistry
    network: base-sepolia
    source:
      address: "{{IdentityRegistry.address}}"
      abi: IdentityRegistry
      startBlock: {{IdentityRegistry.startBlock}}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/mapping.ts
      entities:
        - Agent
        - Metadata
        - Intent
        - ExecutionEnvelope
        - Artifact
        - SourceBundle
        - KnowledgeTree
      abis:
        - name: IdentityRegistry
          file: ./abis/IdentityRegistry.json
      eventHandlers:
        - event: Register(indexed uint256,indexed address,string,(string,bytes)[])
          handler: handleRegister
  - kind: ethereum/contract
    name: ValidationRegistry
    network: base-sepolia
    source:
      address: "{{ValidationRegistry.address}}"
      abi: ValidationRegistry
      startBlock: {{ValidationRegistry.startBlock}}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/mapping.ts
      entities:
        - ValidationRequest
        - ValidationResponse
        - ExecutionEnvelope
      abis:
        - name: ValidationRegistry
          file: ./abis/ValidationRegistry.json
      eventHandlers:
        - event: ValidationRequested(indexed bytes32,indexed address,indexed bytes32,string)
          handler: handleValidationRequested
        - event: ValidationResponded(indexed bytes32,indexed bytes32,indexed address,string,string)
          handler: handleValidationResponded
```

The handlebars-like `{{...}}` templating is resolved by the Graph CLI against `networks.json` at build time via `graph build --network base-sepolia`.

- [ ] **Step 5: Commit**

```bash
git add subgraph/abis subgraph/subgraph.yaml
git commit -m "feat(subgraph): subgraph.yaml + IdentityRegistry/ValidationRegistry ABIs

Two datasources targeting Base Sepolia (addresses templated via
networks.json). Handlers: handleRegister, handleValidationRequested,
handleValidationResponded. Entity list covers the V1 schema."
```

---

## Task 4: Metadata utility + dispatch shell

**Files:**
- Create: `subgraph/src/lib/metadata.ts`
- Create: `subgraph/src/mapping.ts` (shell — dispatch stub)

- [ ] **Step 1: Write `subgraph/src/lib/metadata.ts`**

AssemblyScript's `Bytes` → utf-8 decoding: use `Bytes.toString()` (graph-ts provides it). Helper accepts the `metadata` tuple array from the `Register` event and returns a map-like accessor.

```typescript
import { Bytes } from "@graphprotocol/graph-ts";

export class MetadataPair {
  metadataKey: string;
  metadataValue: Bytes;

  constructor(key: string, value: Bytes) {
    this.metadataKey = key;
    this.metadataValue = value;
  }
}

export function getMetadataString(pairs: MetadataPair[], key: string): string | null {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].metadataKey == key) {
      return pairs[i].metadataValue.toString();
    }
  }
  return null;
}

export function getMetadataBytes(pairs: MetadataPair[], key: string): Bytes | null {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].metadataKey == key) {
      return pairs[i].metadataValue;
    }
  }
  return null;
}

/**
 * Convert the generated event's metadata tuple array to a flat MetadataPair[]
 * the handlers can read without repeatedly calling .toMap() at the graph-ts layer.
 */
export function toMetadataPairs(raw: Array<Entry>): MetadataPair[] {
  const out: MetadataPair[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(new MetadataPair(raw[i].metadataKey, raw[i].metadataValue));
  }
  return out;
}

// Minimal struct to match the generated event-tuple shape. The actual
// generated type lives under ./generated/IdentityRegistry/IdentityRegistry.ts
// and re-exports the struct; callers pass that through.
export class Entry {
  metadataKey: string;
  metadataValue: Bytes;
}
```

- [ ] **Step 2: Write `subgraph/src/mapping.ts` dispatch stub**

```typescript
import { log } from "@graphprotocol/graph-ts";
import { Register } from "../generated/IdentityRegistry/IdentityRegistry";
import { ValidationRequested, ValidationResponded } from "../generated/ValidationRegistry/ValidationRegistry";
import { toMetadataPairs, getMetadataString } from "./lib/metadata";

import { handleAgentCardImpl } from "./handlers/agent";
import { handleIntentImpl } from "./handlers/intent";
import { handleEnvelopeImpl } from "./handlers/envelope";
import { handleSourceBundleImpl } from "./handlers/source-bundle";
import { handleArtifactImpl } from "./handlers/artifact";
import { handleValidationRequestedImpl, handleValidationRespondedImpl } from "./handlers/validation";

export function handleRegister(event: Register): void {
  const pairs = toMetadataPairs(event.params.metadata);
  const documentType = getMetadataString(pairs, "documentType");
  if (documentType == null) {
    log.warning("Register with no documentType metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }

  if (documentType == "adw:AgentCard") {
    handleAgentCardImpl(event, pairs);
  } else if (documentType == "adw:Intent") {
    handleIntentImpl(event, pairs);
  } else if (documentType == "adw:ExecutionEnvelope") {
    handleEnvelopeImpl(event, pairs);
  } else if (documentType == "adw:SourceBundle") {
    handleSourceBundleImpl(event, pairs);
  } else if (documentType == "adw:Artifact") {
    handleArtifactImpl(event, pairs);
  } else {
    log.warning("Unknown documentType {} — skipping agent {}", [documentType, event.params.agentId.toString()]);
  }
}

export function handleValidationRequested(event: ValidationRequested): void {
  handleValidationRequestedImpl(event);
}

export function handleValidationResponded(event: ValidationResponded): void {
  handleValidationRespondedImpl(event);
}
```

- [ ] **Step 3: Write empty handler stubs** (compile-only)

Create `subgraph/src/handlers/{agent,intent,envelope,source-bundle,artifact,validation,knowledge-tree}.ts` — each exports a no-op function with the right signature. The next tasks fill them.

Example `agent.ts`:

```typescript
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { MetadataPair } from "../lib/metadata";

export function handleAgentCardImpl(event: Register, pairs: MetadataPair[]): void {
  // TODO: Task 5
}
```

- [ ] **Step 4: Codegen + build** (smoke)

```bash
cd subgraph && npm run codegen && npm run build
```

Expected: zero errors. Build produces `build/subgraph.yaml` + compiled WASM. The dispatch is correct even if no entities are written.

- [ ] **Step 5: Commit**

```bash
git add subgraph/src
git commit -m "feat(subgraph): dispatch shell + metadata utility

handleRegister reads documentType and dispatches to per-type handlers.
Per-type handlers stubbed; implementations in subsequent tasks."
```

---

## Task 5: AgentCard handler + matchstick test

**Files:**
- Modify: `subgraph/src/handlers/agent.ts`
- Create: `subgraph/tests/agent.test.ts`

- [ ] **Step 1: Write the failing matchstick test**

`subgraph/tests/agent.test.ts`:

```typescript
import { assert, describe, test, clearStore, afterEach, newMockEvent } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { handleRegister } from "../src/mapping";
import { Register } from "../generated/IdentityRegistry/IdentityRegistry";

function mockRegisterAgentCard(
  agentId: BigInt,
  owner: Address,
  agentURI: string,
  metadata: ethereum.Tuple[],
): Register {
  const mock = changetype<Register>(newMockEvent());
  mock.parameters = new Array();
  mock.parameters.push(new ethereum.EventParam("agentId", ethereum.Value.fromUnsignedBigInt(agentId)));
  mock.parameters.push(new ethereum.EventParam("owner", ethereum.Value.fromAddress(owner)));
  mock.parameters.push(new ethereum.EventParam("agentURI", ethereum.Value.fromString(agentURI)));
  mock.parameters.push(new ethereum.EventParam("metadata", ethereum.Value.fromTupleArray(metadata)));
  return mock;
}

function kv(key: string, value: string): ethereum.Tuple {
  const t = new ethereum.Tuple();
  t.push(ethereum.Value.fromString(key));
  t.push(ethereum.Value.fromBytes(Bytes.fromUTF8(value)));
  return t;
}

describe("AgentCard handler", () => {
  afterEach(() => clearStore());

  test("creates Agent entity with documentType=adw:AgentCard", () => {
    const metadata = [
      kv("documentType", "adw:AgentCard"),
      kv("endpoint", "https://example.org/agents/1"),
      kv("ownerAddress", "0x1111111111111111111111111111111111111111"),
    ];
    const event = mockRegisterAgentCard(
      BigInt.fromI32(1),
      Address.fromString("0x1111111111111111111111111111111111111111"),
      "https://example.org/agents/1",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", "1", "documentType", "adw:AgentCard");
    assert.fieldEquals("Agent", "1", "agentURI", "https://example.org/agents/1");
  });

  test("writes per-tuple Metadata entities keyed by agentId-metadataKey", () => {
    const metadata = [
      kv("documentType", "adw:AgentCard"),
      kv("endpoint", "https://example.org/agents/2"),
    ];
    const event = mockRegisterAgentCard(
      BigInt.fromI32(2),
      Address.fromString("0x2222222222222222222222222222222222222222"),
      "https://example.org/agents/2",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Metadata", 2);
    assert.fieldEquals("Metadata", "2-endpoint", "metadataValueString", "https://example.org/agents/2");
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd subgraph && npm test -- agent
```

Expected: fails because `handleAgentCardImpl` is a no-op.

- [ ] **Step 3: Implement `handleAgentCardImpl`**

```typescript
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Metadata } from "../../generated/schema";
import { MetadataPair } from "../lib/metadata";

export function handleAgentCardImpl(event: Register, pairs: MetadataPair[]): void {
  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:AgentCard";
  agent.createdAt = event.block.timestamp;
  agent.createdAtBlock = event.block.number;
  agent.createdAtTx = event.transaction.hash;
  agent.save();

  for (let i = 0; i < pairs.length; i++) {
    const m = new Metadata(agentId + "-" + pairs[i].metadataKey);
    m.agent = agentId;
    m.metadataKey = pairs[i].metadataKey;
    m.metadataValue = pairs[i].metadataValue;
    m.metadataValueString = pairs[i].metadataValue.toString();
    m.save();
  }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd subgraph && npm test -- agent
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add subgraph/src/handlers/agent.ts subgraph/tests/agent.test.ts
git commit -m "feat(subgraph): AgentCard handler + matchstick coverage

Writes Agent + per-tuple Metadata entities. matchstick-as tests cover
the happy path and metadata composite key."
```

---

## Task 6: Intent handler + test

**Files:**
- Modify: `subgraph/src/handlers/intent.ts`
- Create: `subgraph/tests/intent.test.ts`

- [ ] **Step 1: Write failing test**

The Intent handler reads metadata keys `intentCid`, `kind`, `creator`, `createdAt`, `requestId` (per Plan E — double-check the exact metadata key names match what Plan E writes). The Intent entity's `id` is the `intentCid`, not the `agentId` — because agents come and go but the intent CID is the stable cross-reference anchor (§3.3).

**Before writing the test, extract Task 5's mock helpers into a shared module** so every handler test can reuse them. Create `subgraph/tests/helpers.ts`:

```typescript
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as/assembly/index";
import { Register } from "../generated/IdentityRegistry/IdentityRegistry";

export function mockRegister(
  agentId: BigInt,
  owner: Address,
  agentURI: string,
  metadata: ethereum.Tuple[],
): Register {
  const mock = changetype<Register>(newMockEvent());
  mock.parameters = new Array();
  mock.parameters.push(new ethereum.EventParam("agentId", ethereum.Value.fromUnsignedBigInt(agentId)));
  mock.parameters.push(new ethereum.EventParam("owner", ethereum.Value.fromAddress(owner)));
  mock.parameters.push(new ethereum.EventParam("agentURI", ethereum.Value.fromString(agentURI)));
  mock.parameters.push(new ethereum.EventParam("metadata", ethereum.Value.fromTupleArray(metadata)));
  return mock;
}

export function kv(key: string, value: string): ethereum.Tuple {
  const t = new ethereum.Tuple();
  t.push(ethereum.Value.fromString(key));
  t.push(ethereum.Value.fromBytes(Bytes.fromUTF8(value)));
  return t;
}
```

Then update Task 5's `agent.test.ts` to import `mockRegister` and `kv` from `./helpers` instead of defining them locally. Verify `npm test -- agent` still passes.

Now write the Intent handler test:

```typescript
// subgraph/tests/intent.test.ts
import { assert, describe, test, clearStore, afterEach } from "matchstick-as/assembly/index";
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { handleRegister } from "../src/mapping";
import { mockRegister, kv } from "./helpers";

describe("Intent handler", () => {
  test("creates Intent keyed by intentCid, linked to backing Agent", () => {
    const metadata = [
      kv("documentType", "adw:Intent"),
      kv("intentCid", "bafyIntent1"),
      kv("kind", "portfolio.v0"),
      kv("creator", "0x3333333333333333333333333333333333333333"),
      kv("createdAt", "1700000000000"),
      kv("requestId", "0x" + "cd".repeat(32)),
    ];
    const event = mockRegister(/* agentId=10 */ BigInt.fromI32(10), /* owner */ Address.fromString("0x33..."), "ipfs://bafyIntent1", metadata);
    handleRegister(event);
    assert.entityCount("Intent", 1);
    assert.fieldEquals("Intent", "bafyIntent1", "kind", "portfolio.v0");
    assert.fieldEquals("Intent", "bafyIntent1", "agent", "10");
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", "10", "documentType", "adw:Intent");
  });

  test("skips event with missing intentCid metadata and logs warning", () => {
    const metadata = [
      kv("documentType", "adw:Intent"),
      kv("kind", "portfolio.v0"),
      // no intentCid
    ];
    const event = mockRegister(BigInt.fromI32(11), Address.fromString("0x33..."), "ipfs://...", metadata);
    handleRegister(event);
    assert.entityCount("Intent", 0);
    // Agent still gets written? Decision: NO — we skip the Agent write too, since the entire record is malformed.
    assert.entityCount("Agent", 0);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
import { log } from "@graphprotocol/graph-ts";
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Intent, Metadata } from "../../generated/schema";
import { MetadataPair, getMetadataString } from "../lib/metadata";

export function handleIntentImpl(event: Register, pairs: MetadataPair[]): void {
  const intentCid = getMetadataString(pairs, "intentCid");
  if (intentCid == null) {
    log.warning("adw:Intent without intentCid metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }

  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:Intent";
  agent.createdAt = event.block.timestamp;
  agent.createdAtBlock = event.block.number;
  agent.createdAtTx = event.transaction.hash;
  agent.save();

  // Write metadata tuples
  for (let i = 0; i < pairs.length; i++) {
    const m = new Metadata(agentId + "-" + pairs[i].metadataKey);
    m.agent = agentId;
    m.metadataKey = pairs[i].metadataKey;
    m.metadataValue = pairs[i].metadataValue;
    m.metadataValueString = pairs[i].metadataValue.toString();
    m.save();
  }

  const intent = new Intent(intentCid);
  intent.kind = getMetadataString(pairs, "kind") || "unknown";
  const creatorStr = getMetadataString(pairs, "creator");
  intent.creator = creatorStr == null ? event.params.owner : Address.fromString(creatorStr);
  const createdAtStr = getMetadataString(pairs, "createdAt");
  intent.createdAt = createdAtStr == null ? event.block.timestamp : BigInt.fromString(createdAtStr);
  const requestIdStr = getMetadataString(pairs, "requestId");
  intent.requestId = requestIdStr == null ? Bytes.empty() : Bytes.fromHexString(requestIdStr);
  intent.agent = agentId;
  intent.save();
}
```

Note: `Address.fromString`, `BigInt.fromString`, `Bytes.fromHexString` come from `@graphprotocol/graph-ts`. Add the imports.

- [ ] **Step 3: Run — expect pass; commit**

```bash
cd subgraph && npm test -- intent
git add subgraph/src/handlers/intent.ts subgraph/tests/intent.test.ts
git commit -m "feat(subgraph): Intent handler

Writes Intent keyed by intentCid, links to backing Agent. Skips events
missing intentCid with a warning."
```

---

## Task 7: SourceBundle handler + test

**Files:**
- Modify: `subgraph/src/handlers/source-bundle.ts`
- Create: `subgraph/tests/source-bundle.test.ts`

Source bundles come before envelopes because the envelope handler resolves `sourceBundle` by looking up an existing `SourceBundle` entity. If the bundle hasn't registered yet (race), the envelope's `sourceBundle` stays null and a later bundle registration won't back-fill (the subgraph is append-only per-event — no retroactive joins). Plan E's recommended registration order: bundle first, then envelopes using it.

- [ ] **Step 1: Test** — assert SourceBundle written with `id = bundleCid`, measurement Bytes, buildRecipeKind, publishedBy.

- [ ] **Step 2: Implement** following the Intent pattern — write Agent, Metadata tuples, then write `SourceBundle` keyed by `bundleCid` metadata.

- [ ] **Step 3: Run — pass; commit**

```bash
git commit -m "feat(subgraph): SourceBundle handler"
```

---

## Task 8: ExecutionEnvelope handler + test

**Files:**
- Modify: `subgraph/src/handlers/envelope.ts`
- Create: `subgraph/tests/envelope.test.ts`

This is the largest handler. Responsibilities:
1. Write Agent + Metadata tuples (standard pattern).
2. Write `ExecutionEnvelope` keyed by `envelopeCid` metadata.
3. Link to `Intent` via `intentCid` metadata — fail-soft if Intent entity doesn't exist yet (write envelope with `intent` pointing at a placeholder? no — instead, drop the envelope with a log if the intent is missing).
4. For verdicts: resolve `parentEnvelope` by `parentEnvelopeCid` metadata. Same fail-soft policy.
5. Resolve optional `sourceBundle` by `executor.source.bundleCid` metadata (if present).
6. Call `upsertKnowledgeTree(intentCid)` (Task 10) to bump aggregates.

- [ ] **Step 1: Write failing tests**

Three cases:
- **Restoration envelope happy path**: Intent pre-exists; restoration writes; KnowledgeTree gets `totalRestorations=1`.
- **Verdict happy path**: Intent pre-exists; restoration pre-exists; verdict links to parent; KnowledgeTree gets `totalVerdicts=1`.
- **Verdict with missing parent**: parent envelope hasn't registered yet; verdict skipped with warning; no entity written.

- [ ] **Step 2: Implement**

```typescript
import { log } from "@graphprotocol/graph-ts";
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Metadata, ExecutionEnvelope, Intent, SourceBundle } from "../../generated/schema";
import { MetadataPair, getMetadataString, getMetadataBytes } from "../lib/metadata";
import { upsertKnowledgeTree } from "./knowledge-tree";

export function handleEnvelopeImpl(event: Register, pairs: MetadataPair[]): void {
  const envelopeCid = getMetadataString(pairs, "envelopeCid");
  const intentCid = getMetadataString(pairs, "intentCid");
  const role = getMetadataString(pairs, "role");
  const kind = getMetadataString(pairs, "kind");
  const evidenceTier = getMetadataString(pairs, "evidenceTier");

  if (envelopeCid == null || intentCid == null || role == null || kind == null || evidenceTier == null) {
    log.warning("adw:ExecutionEnvelope missing required metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }

  const intent = Intent.load(intentCid);
  if (intent == null) {
    log.warning("ExecutionEnvelope {} references unknown intentCid {} — skipping", [envelopeCid, intentCid]);
    return;
  }

  if (role == "verdict") {
    const parentCid = getMetadataString(pairs, "parentEnvelopeCid");
    if (parentCid == null) {
      log.warning("Verdict envelope {} without parentEnvelopeCid — skipping", [envelopeCid]);
      return;
    }
    const parent = ExecutionEnvelope.load(parentCid);
    if (parent == null) {
      log.warning("Verdict envelope {} references unknown parentEnvelopeCid {} — skipping", [envelopeCid, parentCid]);
      return;
    }
  }

  // Write Agent + Metadata as usual
  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:ExecutionEnvelope";
  agent.createdAt = event.block.timestamp;
  agent.createdAtBlock = event.block.number;
  agent.createdAtTx = event.transaction.hash;
  agent.save();
  for (let i = 0; i < pairs.length; i++) {
    const m = new Metadata(agentId + "-" + pairs[i].metadataKey);
    m.agent = agentId;
    m.metadataKey = pairs[i].metadataKey;
    m.metadataValue = pairs[i].metadataValue;
    m.metadataValueString = pairs[i].metadataValue.toString();
    m.save();
  }

  const env = new ExecutionEnvelope(envelopeCid);
  env.kind = kind;
  env.role = role;
  env.evidenceTier = evidenceTier;
  env.intent = intentCid;
  if (role == "verdict") {
    env.parentEnvelope = getMetadataString(pairs, "parentEnvelopeCid");
  }
  env.measurement = getMetadataBytes(pairs, "measurement");
  const participantStr = getMetadataString(pairs, "participant");
  env.participant = participantStr == null ? event.params.owner : Address.fromString(participantStr);
  const generatedAtStr = getMetadataString(pairs, "generatedAt");
  env.generatedAt = generatedAtStr == null ? event.block.timestamp : BigInt.fromString(generatedAtStr);
  env.createdAtBlock = event.block.number;
  env.createdAtTx = event.transaction.hash;

  const sourceBundleCid = getMetadataString(pairs, "sourceBundleCid");
  if (sourceBundleCid != null && SourceBundle.load(sourceBundleCid) != null) {
    env.sourceBundle = sourceBundleCid;
  }

  env.agent = agentId;
  env.save();

  upsertKnowledgeTree(intentCid, role, evidenceTier, event.block.number);
}
```

- [ ] **Step 3: Run — pass; commit**

```bash
git commit -m "feat(subgraph): ExecutionEnvelope handler with role dispatch

Restoration / verdict branches; parent-envelope + source-bundle linking
with fail-soft warnings on missing references. Delegates KnowledgeTree
bumps to upsertKnowledgeTree."
```

---

## Task 9: Artifact handler + test

**Files:**
- Modify: `subgraph/src/handlers/artifact.ts`
- Create: `subgraph/tests/artifact.test.ts`

- [ ] **Step 1: Test** — Artifact with `parentEnvelopeCid` pre-registered should save; artifact with missing parent should skip with warning.

- [ ] **Step 2: Implement** — key: `artifactCid`; link to `ExecutionEnvelope` via `parentEnvelopeCid` metadata; parse `tags` metadata if it's a JSON string (AssemblyScript has no JSON parser in graph-ts — defer tag parsing to the client side if necessary; write raw JSON string as-is into a separate `tagsRaw` field, or split on `,` if Plan E emits comma-separated tags. Coordinate with Plan E's spec before finalising.)

For V1 simplicity: write tags as a string array only if Plan E emits them as comma-separated. If Plan E emits JSON, store the raw string under a separate `tagsRaw` field and leave parsed `tags` to the client. Pick one and document in the commit.

- [ ] **Step 3: Run — pass; commit**

```bash
git commit -m "feat(subgraph): Artifact handler with parent-envelope linking"
```

---

## Task 10: KnowledgeTree aggregator + test

**Files:**
- Modify: `subgraph/src/handlers/knowledge-tree.ts`
- Create: `subgraph/tests/knowledge-tree.test.ts`

- [ ] **Step 1: Test sequence**

1. Register Intent.
2. Register one restoration envelope → KnowledgeTree total=1, attestedRestorations depends on tier.
3. Register a second restoration → total=2.
4. Register a verdict under restoration #1 → totalVerdicts=1.
5. Assert `attestedFraction` computed as `(attestedR + attestedV) / (totalR + totalV)` with BigDecimal precision.

- [ ] **Step 2: Implement**

```typescript
import { BigInt, BigDecimal } from "@graphprotocol/graph-ts";
import { KnowledgeTree } from "../../generated/schema";

export function upsertKnowledgeTree(
  intentCid: string,
  role: string,
  evidenceTier: string,
  block: BigInt,
): void {
  let tree = KnowledgeTree.load(intentCid);
  if (tree == null) {
    tree = new KnowledgeTree(intentCid);
    tree.intent = intentCid;
    tree.totalRestorations = 0;
    tree.totalVerdicts = 0;
    tree.attestedRestorations = 0;
    tree.attestedVerdicts = 0;
    tree.attestedFraction = BigDecimal.zero();
  }

  const isAttested = evidenceTier == "attested" || evidenceTier == "consensus" || evidenceTier == "proved";
  if (role == "restoration") {
    tree.totalRestorations = tree.totalRestorations + 1;
    if (isAttested) tree.attestedRestorations = tree.attestedRestorations + 1;
  } else if (role == "verdict") {
    tree.totalVerdicts = tree.totalVerdicts + 1;
    if (isAttested) tree.attestedVerdicts = tree.attestedVerdicts + 1;
  }

  const total = tree.totalRestorations + tree.totalVerdicts;
  const attested = tree.attestedRestorations + tree.attestedVerdicts;
  if (total == 0) {
    tree.attestedFraction = BigDecimal.zero();
  } else {
    tree.attestedFraction = BigDecimal.fromString(attested.toString())
      .div(BigDecimal.fromString(total.toString()));
  }

  tree.lastUpdatedBlock = block;
  tree.save();
}
```

Rationale for treating `attested` + `consensus` + `proved` as "attested" for aggregate purposes: the scope's tier ladder places `consensus` and `proved` strictly above `attested`. A buyer asking "what fraction of this tree is attested-or-better?" wants them counted. Document this in the README query examples.

- [ ] **Step 3: Run — pass; commit**

```bash
git commit -m "feat(subgraph): KnowledgeTree aggregate on each envelope write

Counts per-intent restorations, verdicts, and attested-tier fractions.
'attested' treated inclusively — consensus and proved tiers count as
attested-or-better in the aggregate."
```

---

## Task 11: Validation Registry handlers + test

**Files:**
- Modify: `subgraph/src/handlers/validation.ts`
- Create: `subgraph/tests/validation.test.ts`

- [ ] **Step 1: Test** — ValidationRequested writes a ValidationRequest linked to an existing ExecutionEnvelope; ValidationResponded writes a ValidationResponse and links it via a 1:1 back-reference to the request.

- [ ] **Step 2: Implement**

```typescript
import { log } from "@graphprotocol/graph-ts";
import { ValidationRequested, ValidationResponded } from "../../generated/ValidationRegistry/ValidationRegistry";
import { ValidationRequest, ValidationResponse, ExecutionEnvelope } from "../../generated/schema";

export function handleValidationRequestedImpl(event: ValidationRequested): void {
  const envelopeCid = event.params.envelopeCid; // ASSUMPTION: event carries envelopeCid as an indexed bytes32 or string
  // In practice Plan E will define the exact param name. Adjust here once confirmed.
  const env = ExecutionEnvelope.load(envelopeCid.toString());
  if (env == null) {
    log.warning("ValidationRequested for unknown envelope {} — skipping", [envelopeCid.toString()]);
    return;
  }
  const req = new ValidationRequest(event.params.requestId.toHexString());
  req.envelope = envelopeCid.toString();
  req.challenger = event.params.challenger;
  req.scope = event.params.scope;
  req.requestedAt = event.block.timestamp;
  req.createdAtBlock = event.block.number;
  req.createdAtTx = event.transaction.hash;
  req.save();
}

export function handleValidationRespondedImpl(event: ValidationResponded): void {
  const reqId = event.params.requestId.toHexString();
  const req = ValidationRequest.load(reqId);
  if (req == null) {
    log.warning("ValidationResponded without matching request {} — skipping", [reqId]);
    return;
  }
  const resp = new ValidationResponse(event.params.responseId.toHexString());
  resp.request = reqId;
  resp.envelope = req.envelope;
  resp.validator = event.params.validator;
  resp.overall = event.params.overall;
  resp.detail = event.params.detail;
  resp.respondedAt = event.block.timestamp;
  resp.createdAtBlock = event.block.number;
  resp.createdAtTx = event.transaction.hash;
  resp.save();

  req.response = resp.id;
  req.save();
}
```

Wire exact event parameter names once Plan E's Validation Registry contract is finalised. If a param is named differently, adjust but keep the linking semantics identical.

- [ ] **Step 3: Run — pass; commit**

```bash
git commit -m "feat(subgraph): Validation Registry handlers

Request/response pair with back-reference. Fail-soft on orphan responses
or requests for unknown envelopes."
```

---

## Task 12: Local deployment — docker-compose + README

**Files:**
- Create: `subgraph/docker-compose.yml`
- Create: `subgraph/README.md`

- [ ] **Step 1: `docker-compose.yml`** (standard graph-node + IPFS + Postgres)

```yaml
version: "3"
services:
  graph-node:
    image: graphprotocol/graph-node:v0.35.1
    ports:
      - "8000:8000"  # GraphQL
      - "8001:8001"
      - "8020:8020"  # admin (for graph create/deploy)
      - "8030:8030"
      - "8040:8040"
    depends_on:
      - ipfs
      - postgres
    environment:
      postgres_host: postgres
      postgres_user: graph-node
      postgres_pass: let-me-in
      postgres_db: graph-node
      ipfs: "ipfs:5001"
      ethereum: "base-sepolia:https://sepolia.base.org"
      GRAPH_LOG: info
  ipfs:
    image: ipfs/kubo:v0.24.0
    ports:
      - "5001:5001"
  postgres:
    image: postgres:14
    ports:
      - "5432:5432"
    command: ["postgres", "-cshared_preload_libraries=pg_stat_statements"]
    environment:
      POSTGRES_USER: graph-node
      POSTGRES_PASSWORD: let-me-in
      POSTGRES_DB: graph-node
      PGDATA: /var/lib/postgresql/data
```

- [ ] **Step 2: `README.md`** — deployment guide

Include:
- Prerequisites (Node 22, npm, Docker).
- Local dev: `docker compose up -d` → `npm run codegen` → `npm run create-local` → `npm run deploy-local` → GraphQL at `http://localhost:8000/subgraphs/name/jinn/jinn-v1`.
- Deployment to The Graph Studio: register a new subgraph in Studio, grab the deploy key, `graph auth --studio <key>`, `npm run deploy-studio`. Provide deploy-key env var name (`GRAPH_STUDIO_DEPLOY_KEY`) so CI can pick it up later.
- Environment matrix — Base Sepolia (V1), with notes that mainnet is post-V1.
- Example queries — include:
  - Query for a single intent's knowledge tree.
  - Query for envelopes running a specific source bundle.
  - Query for validation responses on an envelope.
  - Query for attested-fraction leaderboard per intent.
- Updating contract addresses — edit `networks.json`, re-build with `--network base-sepolia`.
- Testing — `npm test` runs matchstick.
- Troubleshooting — common errors (`postgres not ready`, `graph-node cant reach RPC`, `deploy-local can't connect to 8020`).

- [ ] **Step 3: Smoke test locally** (optional but recommended by the human operator)

```bash
cd subgraph
docker compose up -d
sleep 20  # graph-node startup
npm run codegen
npm run build
npm run create-local
npm run deploy-local
```

Expected: GraphQL endpoint at `http://localhost:8000/subgraphs/name/jinn/jinn-v1` responds to a query. Note: this only indexes from the configured start block forward; without test data on-chain there will be no entities.

- [ ] **Step 4: Commit**

```bash
git add subgraph/docker-compose.yml subgraph/README.md
git commit -m "docs(subgraph): local dev + Studio deploy guide

docker-compose brings up graph-node + IPFS + Postgres. README covers
local + Studio deploy paths, Base Sepolia config, and example queries
for KnowledgeTree / source-bundle lineage / validation records."
```

---

## Task 13: Optional — CI build check

**Files:**
- Create (optional): `.github/workflows/subgraph-build.yml`

- [ ] **Step 1: Decide**

If the monorepo has existing GH Actions CI, add a subgraph job that runs `codegen`, `build`, `test`. If no CI yet, skip and file a follow-up. Check:

```bash
ls .github/workflows 2>/dev/null
```

- [ ] **Step 2 (conditional): Write workflow**

```yaml
name: Subgraph build
on:
  pull_request:
    paths:
      - "subgraph/**"
  push:
    branches: [main]
    paths:
      - "subgraph/**"
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: subgraph
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: subgraph/package-lock.json
      - run: npm ci
      - run: npm run codegen
      - run: npm run build
      - run: npm test
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/subgraph-build.yml
git commit -m "ci: subgraph codegen+build+test on PR"
```

---

## Task 14: Client — rewrite `discovery/subgraph.ts` against V1 schema

**Files:**
- Modify: `client/src/discovery/subgraph.ts`
- Create: `client/test/discovery/subgraph.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `client/test/discovery/subgraph.test.ts` — use `vi.spyOn(global, 'fetch')` to stub the subgraph endpoint. Tests:

- `queryArtifacts` returns the new schema's `Artifact` entities (with `artifactType`, `tags`, `parentEnvelope`).
- `queryNodes` returns `Agent` entities with `documentType === 'adw:AgentCard'`.
- `getIntent(cid)` returns the Intent + its Agent.
- `getEnvelopesForIntent(cid)` returns an array with both restorations and verdicts linked to that intent.
- `getKnowledgeTree(intentCid)` returns a single object combining intent + restorations + verdicts + aggregate counts in one GraphQL round-trip.
- `getEnvelopesBySource(bundleCid)` returns all envelopes where `sourceBundle.id === bundleCid`.
- Network error propagates as a thrown Error.
- GraphQL errors in the response body throw with a useful message.

Write assertions against exact fixture JSON the stubbed `fetch` returns. Keep fixtures inline at the top of the file for readability.

- [ ] **Step 2: Implement the new queries**

Replace `client/src/discovery/subgraph.ts` with:

```typescript
/**
 * Jinn V1 subgraph client.
 *
 * Queries the ERC-8004 + envelope subgraph deployed from subgraph/.
 * All queries hit a single GraphQL endpoint (config.url) and return
 * typed results matching subgraph/schema.graphql.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §3.3, §4.9.
 */

export interface SubgraphConfig {
  url: string;
}

export interface AgentEntity {
  id: string;
  agentURI: string;
  owner: string;
  documentType: string;
  createdAt: string;
  createdAtBlock: string;
  metadata: Array<{ metadataKey: string; metadataValueString: string }>;
}

export interface IntentEntity {
  id: string;
  kind: string;
  creator: string;
  createdAt: string;
  requestId: string;
  agent: AgentEntity;
}

export interface ExecutionEnvelopeEntity {
  id: string;
  kind: string;
  role: 'restoration' | 'verdict';
  evidenceTier: string;
  intent: { id: string };
  parentEnvelope: { id: string } | null;
  measurement: string | null;
  participant: string;
  generatedAt: string;
  sourceBundle: { id: string } | null;
  agent: AgentEntity;
}

export interface ArtifactEntity {
  id: string;
  artifactType: string;
  parentEnvelope: { id: string };
  tags: string[] | null;
  agent: AgentEntity;
}

export interface SourceBundleEntity {
  id: string;
  measurement: string;
  buildRecipeKind: string;
  humanUrl: string | null;
  publishedBy: string;
  agent: AgentEntity;
}

export interface KnowledgeTreeResult {
  id: string;
  intent: IntentEntity;
  totalRestorations: number;
  totalVerdicts: number;
  attestedRestorations: number;
  attestedVerdicts: number;
  attestedFraction: string; // BigDecimal serializes as string over GraphQL
  lastUpdatedBlock: string;
  restorations: ExecutionEnvelopeEntity[];   // joined client-side from a nested query
  verdictsByRestoration: Record<string, ExecutionEnvelopeEntity[]>;
}

/**
 * Fetch one knowledge tree rooted at an intent CID in a single query.
 */
export async function getKnowledgeTree(
  config: SubgraphConfig,
  intentCid: string,
): Promise<KnowledgeTreeResult | null> {
  const query = `query GetTree($id: ID!) {
    knowledgeTree(id: $id) {
      id
      intent {
        id kind creator createdAt requestId
        agent { id agentURI owner documentType createdAt createdAtBlock
          metadata { metadataKey metadataValueString } }
        restorationEnvelopes {
          id kind role evidenceTier measurement participant generatedAt
          intent { id }
          sourceBundle { id }
          agent { id agentURI owner documentType createdAt createdAtBlock
            metadata { metadataKey metadataValueString } }
          childVerdicts {
            id kind role evidenceTier measurement participant generatedAt
            intent { id }
            parentEnvelope { id }
            sourceBundle { id }
            agent { id agentURI owner documentType createdAt createdAtBlock
              metadata { metadataKey metadataValueString } }
          }
        }
      }
      totalRestorations totalVerdicts attestedRestorations attestedVerdicts
      attestedFraction lastUpdatedBlock
    }
  }`;

  const data = await graphqlRequest<{ knowledgeTree: any | null }>(config.url, query, { id: intentCid });
  if (data.knowledgeTree == null) return null;

  const tree = data.knowledgeTree;
  const restorations = (tree.intent.restorationEnvelopes || []).map((r: any) => ({ ...r, parentEnvelope: null }));
  const verdictsByRestoration: Record<string, ExecutionEnvelopeEntity[]> = {};
  for (const r of tree.intent.restorationEnvelopes || []) {
    verdictsByRestoration[r.id] = r.childVerdicts || [];
  }

  return {
    id: tree.id,
    intent: tree.intent,
    totalRestorations: Number(tree.totalRestorations),
    totalVerdicts: Number(tree.totalVerdicts),
    attestedRestorations: Number(tree.attestedRestorations),
    attestedVerdicts: Number(tree.attestedVerdicts),
    attestedFraction: tree.attestedFraction,
    lastUpdatedBlock: tree.lastUpdatedBlock,
    restorations,
    verdictsByRestoration,
  };
}

/**
 * Fetch all envelopes (restorations + verdicts) that ran against a given source bundle.
 */
export async function getEnvelopesBySource(
  config: SubgraphConfig,
  sourceBundleCid: string,
  limit = 100,
): Promise<ExecutionEnvelopeEntity[]> {
  const query = `query GetEnvelopesBySource($src: String!, $first: Int) {
    executionEnvelopes(where: { sourceBundle: $src }, first: $first) {
      id kind role evidenceTier measurement participant generatedAt
      intent { id }
      parentEnvelope { id }
      sourceBundle { id }
      agent { id agentURI owner documentType createdAt createdAtBlock
        metadata { metadataKey metadataValueString } }
    }
  }`;
  const data = await graphqlRequest<{ executionEnvelopes: ExecutionEnvelopeEntity[] }>(
    config.url, query, { src: sourceBundleCid, first: limit },
  );
  return data.executionEnvelopes;
}

/**
 * Fetch a single intent by CID (+ backing Agent).
 */
export async function getIntent(config: SubgraphConfig, intentCid: string): Promise<IntentEntity | null> {
  const query = `query GetIntent($id: ID!) {
    intent(id: $id) {
      id kind creator createdAt requestId
      agent { id agentURI owner documentType createdAt createdAtBlock
        metadata { metadataKey metadataValueString } }
    }
  }`;
  const data = await graphqlRequest<{ intent: IntentEntity | null }>(config.url, query, { id: intentCid });
  return data.intent;
}

/**
 * Fetch envelopes for an intent without the KnowledgeTree aggregate overhead.
 */
export async function getEnvelopesForIntent(
  config: SubgraphConfig, intentCid: string, limit = 100,
): Promise<ExecutionEnvelopeEntity[]> {
  const query = `query GetEnvelopesForIntent($id: String!, $first: Int) {
    executionEnvelopes(where: { intent: $id }, first: $first) {
      id kind role evidenceTier measurement participant generatedAt
      intent { id } parentEnvelope { id } sourceBundle { id }
      agent { id agentURI owner documentType createdAt createdAtBlock
        metadata { metadataKey metadataValueString } }
    }
  }`;
  const data = await graphqlRequest<{ executionEnvelopes: ExecutionEnvelopeEntity[] }>(
    config.url, query, { id: intentCid, first: limit },
  );
  return data.executionEnvelopes;
}

/**
 * Legacy-style artifact query, rewritten against the new schema.
 * Kept for call-site compat; filters on artifactType prefix if provided.
 */
export async function queryArtifacts(
  config: SubgraphConfig,
  filters?: { artifactTypePrefix?: string; limit?: number },
): Promise<ArtifactEntity[]> {
  const query = `query GetArtifacts($first: Int) {
    artifacts(first: $first) {
      id artifactType tags
      parentEnvelope { id }
      agent { id agentURI owner documentType createdAt createdAtBlock
        metadata { metadataKey metadataValueString } }
    }
  }`;
  const data = await graphqlRequest<{ artifacts: ArtifactEntity[] }>(
    config.url, query, { first: filters?.limit ?? 100 },
  );
  const rows = data.artifacts;
  if (filters?.artifactTypePrefix) {
    return rows.filter((a) => a.artifactType.startsWith(filters.artifactTypePrefix!));
  }
  return rows;
}

/**
 * Legacy node (AgentCard) query.
 */
export async function queryNodes(
  config: SubgraphConfig, limit?: number,
): Promise<AgentEntity[]> {
  const query = `query GetNodes($first: Int) {
    agents(where: { documentType: "adw:AgentCard" }, first: $first) {
      id agentURI owner documentType createdAt createdAtBlock
      metadata { metadataKey metadataValueString }
    }
  }`;
  const data = await graphqlRequest<{ agents: AgentEntity[] }>(
    config.url, query, { first: limit ?? 100 },
  );
  return data.agents;
}

// ── Minimal GraphQL client (no dependency) ───────────────────────────────────

async function graphqlRequest<T>(url: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Subgraph query failed: ${response.status} ${response.statusText}`);
  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`Subgraph errors: ${json.errors.map(e => e.message).join(', ')}`);
  if (!json.data) throw new Error('Subgraph returned no data');
  return json.data;
}
```

- [ ] **Step 3: Run tests**

```bash
cd client
yarn vitest run test/discovery/subgraph.test.ts
```

Expected: pass.

- [ ] **Step 4: Update call sites**

```bash
cd client
grep -rn "queryArtifacts\|queryNodes\|getMetadataValue" src
```

Update any call site to the new shape (metadata entries are `{ metadataKey, metadataValueString }` now, not `{ key, value }`). If `getMetadataValue` helper is still useful, re-export it from the new file.

- [ ] **Step 5: Typecheck + test + commit**

```bash
cd client
yarn typecheck && yarn test
git add client/src/discovery/subgraph.ts client/test/discovery/subgraph.test.ts
git commit -m "refactor(client): rewrite discovery/subgraph.ts against V1 schema

New queries: getKnowledgeTree, getEnvelopesBySource, getIntent,
getEnvelopesForIntent. Legacy queryArtifacts + queryNodes rewritten
against the V1 schema (artifactType prefix filter, adw:AgentCard
where-clause). metadata shape aligned with subgraph Metadata entity."
```

---

## Task 15: Integration test — end-to-end against local subgraph

**Files:**
- Create: `client/test/discovery/subgraph-integration.test.ts` (gated by env var so CI can skip)

This is the only task that requires a running graph-node + docker. Skip in CI by default (gate via `process.env.JINN_SUBGRAPH_INTEGRATION === '1'`). Use it for manual verification.

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getKnowledgeTree, getIntent } from '../../src/discovery/subgraph.js';

const RUN = process.env['JINN_SUBGRAPH_INTEGRATION'] === '1';
const LOCAL_URL = 'http://localhost:8000/subgraphs/name/jinn/jinn-v1';

describe.skipIf(!RUN)('subgraph integration (local graph-node)', () => {
  beforeAll(async () => {
    // Sanity — endpoint responsive
    const res = await fetch(LOCAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ _meta { block { number } } }' }),
    });
    if (!res.ok) throw new Error('local subgraph not reachable');
  });

  it('returns null for unknown intent', async () => {
    const tree = await getKnowledgeTree({ url: LOCAL_URL }, 'bafyDoesNotExist');
    expect(tree).toBeNull();
  });

  it('resolves a real intent after on-chain registration', async () => {
    // This test presumes an operator has registered at least one intent on
    // Base Sepolia against the deployed 8004 contract. Without live data
    // this assertion is skipped — run with a known-good intentCid as env.
    const intentCid = process.env['JINN_SUBGRAPH_TEST_INTENT'];
    if (!intentCid) return;
    const intent = await getIntent({ url: LOCAL_URL }, intentCid);
    expect(intent).not.toBeNull();
    expect(intent!.id).toBe(intentCid);
  });
});
```

- [ ] **Step 2: Manual run instructions in `README.md`**

Add a subsection to `subgraph/README.md` on running the integration test:

```bash
# Terminal 1
cd subgraph && docker compose up

# Terminal 2
cd subgraph && npm run deploy-local

# Terminal 3 — register a test intent on Base Sepolia via the client (manual)
# then:
cd client
JINN_SUBGRAPH_INTEGRATION=1 JINN_SUBGRAPH_TEST_INTENT=<intentCid> yarn vitest run test/discovery/subgraph-integration.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add client/test/discovery/subgraph-integration.test.ts subgraph/README.md
git commit -m "test(client): optional integration test against local subgraph

Gated on JINN_SUBGRAPH_INTEGRATION=1 to skip in default CI. README
documents the manual end-to-end loop."
```

---

## Task 16: Final verification + hand-off notes

**Files:** None — verification only.

- [ ] **Step 1: Subgraph test suite**

```bash
cd subgraph
npm run codegen && npm run build && npm test
```

Expected: all pass.

- [ ] **Step 2: Client typecheck + tests**

```bash
cd client
yarn typecheck && yarn test
```

Expected: all pass.

- [ ] **Step 3: Grep — no stragglers**

```bash
grep -rn "metadataKey.*key.*value\b\|metadata_: {" client/src 2>&1
```

Expected: empty. Any remaining call sites still using the legacy `{ key, value }` shape are stragglers — fix them.

- [ ] **Step 4: Verify schema coverage**

Open `subgraph/schema.graphql` and confirm every entity has:
- At least one matchstick test covering its write path.
- A client-side query in `client/src/discovery/subgraph.ts` (or a documented reason for omission).

- [ ] **Step 5: Update hand-off doc**

Append a section to the scope doc's companion design spec (once it exists — currently `2026-04-23-jinn-execution-envelope-tee-scope.md`) noting that Plan G is the canonical subgraph deliverable and lists the GraphQL endpoint pattern for downstream consumers. If the design spec doesn't exist yet, file a beads follow-up:

```bash
bd create "Document Plan G's subgraph endpoint + query set in the design spec" --kind chore --priority 3
```

---

## Self-review before marking this plan done

- [ ] **Subgraph deploys locally:** `docker compose up && npm run deploy-local` succeeds; querying `{ _meta { block { number } } }` returns a block number.
- [ ] **All entity types have handlers + matchstick coverage:** Agent, Intent, ExecutionEnvelope (restoration + verdict branches), Artifact, SourceBundle, KnowledgeTree, ValidationRequest, ValidationResponse.
- [ ] **Fail-soft policy consistent:** every handler logs + skips on missing required metadata or unresolved parent/intent reference — never throws mid-handler.
- [ ] **KnowledgeTree aggregate correct:** counts restorations + verdicts + attested-or-better fractions; updates on every envelope write under that intent.
- [ ] **Client queries typecheck:** new GraphQL result types match the subgraph schema exactly.
- [ ] **Legacy call sites migrated:** no remaining uses of the old `{ key, value }` metadata shape.
- [ ] **README covers local + Studio deploy:** someone who's never used The Graph can follow it.
- [ ] **Non-goals honoured:** no trajectory content indexing, no mainnet config, no cross-chain aggregation, no buyer-facing catalog UI.

---

## Follow-ups (out of scope for this plan)

- **Buyer-side trajectory content indexer** — a separate service walking IPFS trajectory blobs to populate span-level search. Scope §3.3 explicitly defers this.
- **Mainnet deployment** — once Phase 2 lands, deploy a Base mainnet subgraph variant. Reuse `schema.graphql` and `mapping.ts` unchanged; parameterise `networks.json`.
- **Cross-chain aggregator** — a GraphQL stitching layer or federated schema combining per-chain subgraphs. V2.
- **Buyer catalog / gating epic (D8)** — will consume this subgraph as its read layer. This plan does not anticipate D8's specific query shapes; the query set here is a general-purpose knowledge-graph API.
- **Subgraph performance tuning** — under mainnet-scale load, re-indexing cost + query latency will need attention (entity index hints, derived-field tradeoffs). Profile after Phase 1b data lands.
- **Trajectory CID indexing improvement** — right now `ExecutionEnvelope.trajectoryCid` lives as a raw Metadata entry on the Agent, not as a first-class field on the envelope. If Plan D populates `trajectory` on the envelope schema and Plan E registers `trajectoryCid` as a dedicated metadata key, a future plan should extend `ExecutionEnvelope` with a `trajectoryCid: String` field + index it for direct querying.
- **Validation Registry — response aggregation** — a `ValidationSummary` synthetic entity (count of valid/invalid responses per envelope, per validator reputation) would be handy for buyers filtering on "challenger-verified attested envelopes". Add in V2.
- **Metadata key registry** — as new documentTypes and metadata keys appear (Plan E adds `adw:ExecutionEnvelope`, `adw:SourceBundle`; future epics may add more), a canonical keys registry in the subgraph docs would prevent divergence between Plan E writers and mapping readers. File as doc task.

---

*End of Plan G. Plan F (conformance suite) + Plan G can land in parallel once Plans C + E are in; they're independent consumers of envelope + on-chain registration. Once all V1 plans land, the envelope + knowledge-graph substrate is complete; the V2 TEE workstream (Phala Dstack + attestation) can begin.*
