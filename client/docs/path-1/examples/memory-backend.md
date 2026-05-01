# Worked example: memory-backend

**Example package:** [`examples/learner-plug-ins/@jinn-examples/vector-store-memory`](../../../../examples/learner-plug-ins/@jinn-examples/vector-store-memory)

## Recruit shape

You're a memory-substrate builder. You operate a vector store (Pinecone, Weaviate, local FAISS, your own embedding service) and want it wired into Jinn's consolidator phase. You're not shipping a forecaster — you're shipping the memory the forecaster's debriefs accumulate into.

The `memory-backend` slot is your shape: ship an MCP server implementing the embed/query/prune verbs; the consolidator agent invokes them when curating prior debriefs and when retrieving analogous cases.

## What the slot does

At session start, the harness spawns the memory backend's MCP server (declared `command` + `args`). The bundled consolidator agent uses the backend's tools when curating prior debrief artefacts (calling `embed` to index them) and when the next session's Orient retrieves analogous cases (calling `query`).

The vector-store-memory example is an in-memory vector store with `embed`, `query`, and `prune` verbs — a stub useful for tests and local dev. Production deployments swap in a real backend.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/vector-store-memory",
  "version": "0.1.0",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0"
  },
  "slots": [
    {
      "type": "memory-backend",
      "command": "node",
      "args": ["./dist/server.js"]
    }
  ]
}
```

No `scope.matchKinds` — memory backends typically apply across kinds. If you want to run a specific backend only for `prediction.v0` while keeping the bundled backend for everything else, add `scope.matchKinds: ["prediction.v0"]`.

## Slot entry walkthrough

The MCP server in `src/server.ts` exports the three memory-backend verbs:

- `embed({ text, metadata })` — index a document; return its ID.
- `query({ text, topK })` — retrieve `topK` analogous documents.
- `prune({ olderThanTs, criteria })` — drop stale entries.

The consolidator agent's prompt knows these verb names; the harness registers them under the memory-backend tool surface and dispatches calls to your server.

## Test → install → run

```bash
cd examples/learner-plug-ins/@jinn-examples/vector-store-memory
yarn install
yarn build
yarn test          # validates manifest + smoke-tests embed/query/prune

cd ~/your-daemon-config
yarn add file:.../examples/learner-plug-ins/@jinn-examples/vector-store-memory
jinn plug-ins add @jinn-examples/vector-store-memory

# Restart daemon. The consolidator now uses your backend.
```

## Replace the stub

1. **Implement embed/query/prune against your real backend** — Pinecone, Weaviate, FAISS, whatever. The MCP server is a thin adapter.
2. **Read connection config from environment variables** — `PINECONE_API_KEY`, `WEAVIATE_URL`, etc. The MCP server runs in its own process; its env is independent of the daemon's.
3. **Decide on persistence boundary.** The bundled backend persists under `implStateDir/memory/`; if your backend is hosted, document the mapping (one collection per Safe address? per kind? per network?).
4. **Document the operator's footprint.** Hosted backends mean network egress + a third-party seeing the memory contents. Operators decide whether to install based on your README; the harness doesn't enforce per-backend allow-listing (open question — see `spec/2026-04-30-plug-in-surface.md` §8.3).

Operators wanting stricter controls (no network egress) install a local backend (FAISS) instead of a hosted one.
