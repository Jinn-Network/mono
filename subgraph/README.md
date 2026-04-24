# Jinn V1 Subgraph

The Jinn V1 subgraph indexes Plan E's ERC-8004 Identity Registry and Validation Registry events on Base Sepolia into a queryable GraphQL graph. It exposes `Intent`, `ExecutionEnvelope`, `Artifact`, `SourceBundle`, and a synthetic `KnowledgeTree` aggregate that joins restorations, verdicts, and attested-fraction counts for each intent CID.

---

## Local dev

### Prerequisites

- Docker and Docker Compose
- Node.js 22 with `@graphprotocol/graph-cli` installed globally (`npm install -g @graphprotocol/graph-cli@0.80.0`) or via `npx graph`

### Start the local stack

```bash
# From subgraph/
docker compose up -d
```

This starts:
- `ipfs` — Kubo IPFS node (API on :5001, gateway on :8080)
- `postgres` — Postgres 13 for graph-node state
- `graph-node` — The Graph node (GraphQL on :8000, admin on :8020, status on :8030, metrics on :8040)

By default it points to `https://sepolia.base.org`. Override with:

```bash
BASE_SEPOLIA_RPC_URL=https://your-rpc.example.com docker compose up -d
```

### Build and deploy

```bash
# 1. Install deps
npm install

# 2. Generate AssemblyScript types from the schema
npm run codegen

# 3. Compile the WASM mapping
npm run build

# 4. Create the subgraph slot on the local node
npm run create-local
# Equivalent: graph create --node http://localhost:8020 jinn/jinn-v1

# 5. Deploy to the local node
npm run deploy-local
# Equivalent: graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 jinn/jinn-v1
```

After deploy, the GraphQL playground is at: http://localhost:8000/subgraphs/name/jinn/jinn-v1/graphql

### Run subgraph unit tests (matchstick-as)

```bash
npm run test
```

---

## Deploy to Subgraph Studio

1. Authenticate: `graph auth --studio <your-deploy-key>`
2. Build: `npm run build`
3. Deploy: `npm run deploy-studio`
   - Equivalent: `graph deploy --studio jinn-v1`

Subgraph Studio endpoint: `https://api.studio.thegraph.com/query/<id>/jinn-v1/version/latest`

---

## Example queries

### 1. All attested envelopes for a specific intent kind

```graphql
{
  executionEnvelopes(
    where: {
      intent_: { kind: "portfolio.v0" }
      evidenceTier: "attested"
    }
    orderBy: generatedAt
    orderDirection: desc
    first: 20
  ) {
    id
    role
    evidenceTier
    participant
    generatedAt
    intent { id kind creator }
  }
}
```

### 2. Knowledge tree for an intent CID

```graphql
{
  knowledgeTree(id: "bafy...intentCid") {
    id
    totalRestorations
    totalVerdicts
    attestedRestorations
    attestedVerdicts
    attestedFraction
    intent {
      id
      kind
      creator
      restorationEnvelopes(orderBy: generatedAt, orderDirection: desc) {
        id
        role
        evidenceTier
        participant
        childVerdicts {
          id
          evidenceTier
          participant
        }
      }
    }
  }
}
```

### 3. All validation records for an operator Safe address

```graphql
{
  validationResponses(
    where: {
      envelope_: { participant: "0xYourSafeAddress" }
    }
    orderBy: respondedAt
    orderDirection: desc
    first: 50
  ) {
    id
    overall
    detail
    validator
    respondedAt
    envelope { id role evidenceTier }
    request { scope challenger requestedAt }
  }
}
```

### 4. Source bundle lineage — all envelopes from a given bundle CID

```graphql
{
  sourceBundles(where: { id: "bafy...bundleCid" }) {
    id
    buildRecipeKind
    measurement
    humanUrl
    publishedBy
    envelopesUsing(orderBy: generatedAt, orderDirection: desc, first: 100) {
      id
      role
      evidenceTier
      participant
      intent { id kind }
    }
  }
}
```

### 5. Recent intents across all kinds

```graphql
{
  intents(
    orderBy: createdAt
    orderDirection: desc
    first: 10
  ) {
    id
    kind
    creator
    createdAt
    knowledgeTree {
      totalRestorations
      totalVerdicts
      attestedFraction
    }
  }
}
```

---

## Troubleshooting

**`graph-node` fails to start / can't connect to Postgres**
Make sure Docker is running and both `ipfs` and `postgres` are healthy before graph-node starts. Run `docker compose logs graph-node` to inspect. If Postgres is slow to initialise, graph-node will retry automatically.

**`error: Failed to get block`**
Your `BASE_SEPOLIA_RPC_URL` may be rate-limited or unreachable. Swap to a paid RPC provider (Alchemy, QuickNode, etc.) and restart with:
```bash
BASE_SEPOLIA_RPC_URL=https://your-fast-rpc.example.com docker compose up -d graph-node
```

**`graph build` AssemblyScript compile errors**
Run `npm run codegen` first — generated types (`generated/`) must exist before `graph build` can compile `src/mapping.ts`.

**Empty query results on localhost**
Check `http://localhost:8030` (indexing status) to confirm the subgraph has synced past the contract `startBlock`. If `startBlock` in `subgraph.yaml` is `0` on a chain with millions of blocks, syncing takes time. Set `startBlock` to the actual deployment block for a faster start.

**Deployment to Studio fails with 403**
Re-authenticate with `graph auth --studio <deploy-key>`. Deploy keys rotate; grab a fresh one from the Studio dashboard.
