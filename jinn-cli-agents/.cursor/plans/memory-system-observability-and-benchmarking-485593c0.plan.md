<!-- 485593c0-8dee-4c9e-9446-d24d5a789256 1fcc5175-a2b0-4767-a111-724db1429316 -->
# Memory System Observability Plan

This plan details the steps to create observability tools and frontend integrations to validate the effectiveness of the semantic graph search memory system as per JINN-237.

## Part 1: Observability Tooling

I will create a script and an associated MCP tool to inspect the memory system for a given job. This will allow developers and agents to understand what the system remembers.

- **Create Inspection Script**: I will implement `scripts/memory/inspect-situation.ts`. This script will take a `requestId` and output a detailed view of the corresponding `SITUATION` artifact, including its metadata and the most similar situations retrieved from the vector database.

- **Create MCP Tool**: I will register a new MCP tool `inspect_situation` in `gemini-agent/src/mcp/tools/`. This tool will wrap the inspection script, making it available for agentic use.

## Part 2: Frontend Integration

I will connect the frontend explorer to the production Ponder GraphQL endpoint and investigate how to visualize memory system data.

- **Update Ponder Endpoint**: I will modify `frontend/explorer/src/lib/subgraph.ts` to point to the production Ponder endpoint `https://jinn-gemini-production.up.railway.app/`.

- **Visualize Memory Data (Investigation)**: I will investigate the feasibility of adding a new component to the request detail page (`frontend/explorer/src/app/request/[id]/page.tsx`) to display similar situations that were retrieved during the job's execution. This is an exploratory task.

### To-dos

- [ ] Create observability script `scripts/memory/inspect-situation.ts`
- [ ] Create MCP tool `inspect_situation`
- [ ] Create benchmarking script `scripts/memory/benchmark-memory.ts`
- [ ] Update frontend Ponder endpoint in `frontend/explorer/src/lib/subgraph.ts`
- [ ] Investigate and optionally implement memory visualization on the frontend