---
name: Create Workstream Inspection Script
overview: ""
todos: []
---

# Create Workstream Inspection Script

I will create a new script `scripts/inspect-workstream.ts` to visualize the complete graph of a workstream. This will provide a high-fidelity but manageable view of job execution trees, enabling you to see relationships, triggers, and status across the entire venture.

## Implementation Plan

1.  **Create `scripts/inspect-workstream.ts`**

    -   **Input**: Accepts a `workstreamId` (required).
    -   **Data Fetching**:
        -   Fetch all requests with `workstreamId`.
        -   Fetch associated `JobDefinitions`, `Deliveries`, and `Artifacts` in bulk.
    -   **Graph Construction**:
        -   Build an in-memory tree structure linking requests by `sourceRequestId`.
        -   Identify "Job Definitions" (abstract goals) vs "Requests" (execution runs).
    -   **IPFS Resolution**:
        -   Selectively fetch delivery content (like `inspect-job.ts`).
        -   Truncate large outputs (e.g. "output", "content") to prevent context overload.
        -   Extract key fields: `status`, `error`, `structuredSummary`.
    -   **Output**:
        -   Print a JSON object to stdout (for piping/programmatic use).
        -   Structure:
            -   `summary`: High-level stats (total jobs, status counts, duration).
            -   `tree`: Hierarchical representation of the workstream.
            -   `timeline`: Flat list of events ordered by time.

2.  **Verification**

    -   Run the script against a known workstream ID (from your terminal history or `inspect-job` output).

This aligns with the patterns in `inspect-job.ts` but focuses on the *execution instance* graph (workstream) rather than the *definition* history.