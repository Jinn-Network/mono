# @jinn-examples/vector-store-memory

**Recruit shape:** memory-substrate builder with a vector-store + embedding-service
integration.

**Slot:** memory-backend (mechanically an MCP server with `embed`, `query`,
`prune` tools).

## What this plug-in does

Provides a Memory-phase backend the consolidator can call:

- `embed(id, text, metadata?)` — store a vector under a stable id
- `query(query, k)` — top-k nearest-neighbour retrieval
- `prune(maxAgeMs)` — TTL-based eviction

Default impl is an in-process `InMemoryStore` with a deterministic hash-bag
embedding (16 dim, L2-normalised). Real builders swap `src/in-memory-store.ts`
for Pinecone, Weaviate, pgvector, FAISS-on-disk, etc. Keep the verb shapes —
the consolidator routes by exact tool name.

## Install

```bash
yarn add @jinn-examples/vector-store-memory
yarn build
jinn plug-ins add @jinn-examples/vector-store-memory --entry $(npm root)/@jinn-examples/vector-store-memory
```

## Build & test

```bash
yarn install
yarn typecheck
yarn build
yarn test
```

## Spec

`spec/2026-04-30-plug-in-surface.md` §4.7.5.
