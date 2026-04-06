---
name: Update Workstream Tree Sorting and Dependency Visualization
overview: ""
todos:
  - id: bfd697b1-0b5a-40b2-8a3c-667d7c3efce4
    content: Update GraphNode interface and createGraphNode in graph-queries.ts to include timestamp and dependencies
    status: pending
  - id: b8ce49f2-2ca5-4eea-a111-eabec6809073
    content: Implement dependency aggregation in buildWorkstreamJobGraph
    status: pending
  - id: bf33a692-d601-4842-beee-709f59b359f4
    content: Implement date-based sorting in buildTree function
    status: pending
  - id: 942160f3-60d9-44ed-8109-f367f5964af9
    content: Update TreeNodeItem to visualize dependencies
    status: pending
---

# Update Workstream Tree Sorting and Dependency Visualization

The user wants the jobs in the Workstream Tree view to be ordered by their creation date while preserving the hierarchy. Additionally, dependencies need to be made a first-class citizen on the Job Definition table in Ponder, populated from the first request, and then visualized in the frontend.

## 1. Update Ponder Schema (`ponder/ponder.schema.ts`)

- Add `dependencies` field to the `jobDefinition` table (text array).
- Add index for `dependencies` if needed (though array indexing might be overkill for now).

## 2. Update Ponder Indexer (`ponder/src/index.ts`)

- In the `MarketplaceRequest` handler:
- When creating/updating a `JobDefinition`:
- Extract `dependencies` from the IPFS content (same as done for Request).
- Upsert the `dependencies` field on the `JobDefinition`.
- **Important**: Since a Job Definition is immutable in terms of its definition (it's the "class"), we should populate this only on creation or ensure it matches the definition. If multiple requests for the same Job Definition have different dependencies (which shouldn't happen for the *same* definition ID usually), we need to decide policy. Assuming standard behavior where the definition ID implies the same requirements. User comment – the job definition should be immutable, therefore we needn't worry about updating dependencies. 
- Populate `dependencies` from `content.dependencies`.

## 3. Update Frontend Subgraph Types (`frontend/explorer/src/lib/subgraph.ts`)

- Update `JobDefinition` interface to include `dependencies?: string[]`.
- Update `JOB_DEFINITIONS_QUERY` and `JOB_DEFINITION_QUERY` to fetch `dependencies`.

## 4. Update Graph Queries (`frontend/explorer/src/lib/graph-queries.ts`)

- Update `GraphNode` interface metadata:
- Add `timestamp: number` (to support sorting).
- Add `dependencies: string[]` (to support visualization).
- Update `createGraphNode`:
- Populate `timestamp` using `createdAt` (JobDefinition) or `blockTimestamp` (Request).
- Populate `dependencies` directly from `JobDefinition` (now a first-class field) or `Request`.
- Update `buildWorkstreamJobGraph`:
- Populate `timestamp` for Job Definition nodes.
- **Simplify Dependency Handling**:
- Instead of aggregating from requests, use the `dependencies` field directly from the Job Definition.

## 5. Sort Tree Nodes (`frontend/explorer/src/components/workstream-tree-list.tsx`)

- Update `buildTree`:
- Sort `children` arrays by `node.metadata.timestamp` (ascending).

## 6. Visualize Dependencies (`frontend/explorer/src/components/workstream-tree-list.tsx`)

- Update `TreeNodeItem`:
- Display a list or indicator of dependencies for the node.
- Use `allNodes` to resolve dependency IDs to readable names if possible.
- Distinguish between dependencies that are met vs. pending (if status is available).

## 7. Verification

- Verify that the Workstream Tree view sorts siblings by date.
- Verify that Job Definitions show their dependencies populated directly from the Ponder index.