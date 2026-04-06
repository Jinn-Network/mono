---
name: Add Right-Side Sidebar to Job Definition Page
overview: ""
todos: []
---

# Add Right-Side Sidebar to Job Definition Page

## Context

Current state: [`job-definition-detail-layout.tsx`](frontend/explorer/src/components/job-definition-detail-layout.tsx) shows blueprint and runs in the main area, with basic info in a right sidebar card.

Target: Replace the static info card with a proper shadcn Sidebar component (like [`app-sidebar.tsx`](frontend/explorer/src/components/app-sidebar.tsx)) containing navigable sections. But this should be fullheight on the left.

## Implementation Plan

### 1. Create Job Definition Sidebar Component

Create `frontend/explorer/src/components/job-definition-sidebar.tsx`:

- Use shadcn `Sidebar`, `SidebarContent`, `SidebarMenu`, `SidebarMenuItem` components
- Navigation items: Overview (default), Details, Blueprint & Tools, Job Runs, Artifacts
- Use `usePathname()` or local state to track active section
- Accept `jobDefinitionId` prop for data fetching
- Integrate `useRealtimeData` hook for live updates on 'jobDefinitions', 'requests', 'artifacts'

### 2. Create Section Components

**Overview Section** (`job-definition-overview.tsx`):

- Latest progress report from RECOGNITION_RESULT artifact (via `queryArtifacts` with `topic: "RECOGNITION_RESULT"`)
- Top-level assertions list (parse blueprint JSON, show assertion IDs + text only, no examples/commentary)
- Enabled tools badges
- Latest 3 job runs (query `requests` with `jobDefinitionId`, limit 3, order desc)
- Last 3 created artifacts (query `artifacts` with `sourceJobDefinitionId`, limit 3)
- lastStatus badge with StatusIcon
- lastActivity timestamp
- Job definition ID (truncated with copy)

**Details Section** (reuse existing info card content):

- Full ID
- Status
- Workstream link
- Source job definition link
- Source request link
- lastInteraction timestamp

**Blueprint & Tools Section** (extract from current layout):

- Full blueprint rendering (with assertions, examples, commentary)
- Enabled tools list

**Job Runs Section**:

- Full RequestsTable component showing all runs

**Artifacts Section**:

- List all artifacts for this job definition
- Show name, topic, CID, timestamp
- Link to artifact detail pages

### 3. Update Job Definition Detail Layout

In [`job-definition-detail-layout.tsx`](frontend/explorer/src/components/job-definition-detail-layout.tsx):

- Import and add `JobDefinitionSidebar` component
- Change grid layout: remove right sidebar card, add sidebar to right
- Move blueprint and runs display logic to section components
- Pass `record.id` to sidebar component
- Remove duplicate data fetching (delegate to sidebar sections)

### 4. Add Real-Time Updates

Each section component:

- Use `useRealtimeData` hook for relevant collections ('artifacts', 'requests', 'jobDefinitions')
- Refetch data on SSE events
- Follow pattern from [`use-subgraph-collection.ts`](frontend/explorer/src/hooks/use-subgraph-collection.ts) lines 81-90

### 5. Styling & UX

- Sidebar fixed on right, scrollable sections
- Active section highlighted
- Use shadcn Card components for section content
- Skeleton loaders for async data
- Responsive: collapse sidebar on mobile (use existing shadcn sidebar collapsible patterns)

## Files to Create

- `frontend/explorer/src/components/job-definition-sidebar.tsx`
- `frontend/explorer/src/components/job-definition-sections/overview.tsx`
- `frontend/explorer/src/components/job-definition-sections/details.tsx`
- `frontend/explorer/src/components/job-definition-sections/blueprint-tools.tsx`
- `frontend/explorer/src/components/job-definition-sections/job-runs.tsx`
- `frontend/explorer/src/components/job-definition-sections/artifacts.tsx`

## Files to Modify

- `frontend/explorer/src/components/job-definition-detail-layout.tsx`

## Key Integration Points

- Query functions: `queryArtifacts`, `queryRequests` from [`subgraph.ts`](frontend/explorer/src/lib/subgraph.ts)
- Real-time hook: `useRealtimeData` from [`use-realtime-data.ts`](frontend/explorer/src/hooks/use-realtime-data.ts)
- Existing components: `RequestsTable`, `StatusIcon`, `TruncatedId`, `Badge`
- Blueprint parsing logic from current layout (lines 82-156)