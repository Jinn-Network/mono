---
name: Update Jinn Explorer Dashboard
overview: This plan updates the Jinn Explorer root page to be a dashboard of cards aggregating underlying data and makes the sidebar title a link to the root page.
todos:
  - id: update-sidebar
    content: Update AppSidebar to link title to /
    status: completed
  - id: create-dashboard-view
    content: Create DashboardView component
    status: completed
  - id: update-page
    content: Update Page to render DashboardView
    status: completed
---

# Update Jinn Explorer Dashboard

## 1. Sidebar

- Update `frontend/explorer/src/components/app-sidebar.tsx` to wrap the "Jinn Explorer" header in a `Link` to `/`. Also add a 'home' icon, which should be visible even when the sidebar is minimised.
- At the bottom of the sidebar, add a About Jinn with info icon – link to https://www.jinn.network

## 2. Dashboard Component

Create `frontend/explorer/src/components/dashboard-view.tsx`:

- **Type**: Client Component
- **Layout**: Grid of cards (responsive)
- **Data Fetching**:
    - Use `useSubgraphCollection` for `requests`, `deliveries`, `artifacts`, `jobDefinitions` (limit 5).
    - Use `useEffect` + `getWorkstreams` for `workstreams` (limit 5).
- **Components**:
    - Reusable card logic or inline cards for each section.
    - Each card displays a list of recent items with relevant details (ID, Name, Timestamp).
    - "View All" link in each card.

## 3. Page Update

Update `frontend/explorer/src/app/page.tsx`:

- Remove existing static welcome content.
- Import and render `<DashboardView />`.
- Keep the `<SiteHeader />`, but replace all text with 'Home'

## Files to Create/Modify

- `frontend/explorer/src/components/app-sidebar.tsx` (Modify)
- `frontend/explorer/src/components/dashboard-view.tsx` (Create)
- `frontend/explorer/src/app/page.tsx` (Modify)