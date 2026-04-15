<!-- 28bd28c2-b39b-4945-9e38-58cc3908c938 0be19319-5cd8-4560-a3d4-7083fd7f41e0 -->
# Plan: Implement Bounded Traversal for Similar Jobs

This plan outlines the steps to enhance the worker's recognition phase to include context from jobs related to semantically similar jobs, and to display this information on the frontend.

## Phase 1: Worker Update (Backend)

The primary goal is to augment the data gathered during the recognition phase.

### 1. Enhance Data Fetching in Recognition Phase

**File:** `worker/mech_worker.ts`
**Function:** `runRecognitionPhase`

In the existing loop that iterates through top semantic matches (`for (const match of matches.slice(0, 3))`), after fetching a similar job's `situationData`, I will add logic to:
1.  Extract the `context` object (`parentRequestId`, `childRequestIds`, `siblingRequestIds`) from the `situationData`.
2.  Create and use a new helper function, `fetchContextualJobs`, that takes these IDs and fetches the full `Request` record and `SITUATION` artifact for each parent, child, and sibling. This provides not just the relationship but the *outcome* of those related jobs.
3.  Attach this rich context to the `situationArtifacts` object. The structure will be updated to include a `boundedContext` field.

```typescript
// worker/mech_worker.ts (conceptual change)
// ... inside runRecognitionPhase, inside the loop
const situationData = await fetchIpfsContent(situationArt.cid);

// NEW: Fetch bounded context for the similar job
const boundedContext = await fetchContextualJobs(situationData.context);

situationArtifacts.push({
  sourceRequestId: match.nodeId,
  score: match.score,
  situation: situationData,
  boundedContext: boundedContext // <-- New data
});
```

### 2. Update Recognition Prompt Generation

**File:** `worker/recognition_helpers.ts`
**Function:** `buildRecognitionPromptWithArtifacts`

I will update this function to intelligently serialize the new `boundedContext` data into the prompt for the synthesis agent. It will be formatted to clearly present the relationships and outcomes of jobs in the local neighborhood of each similar job, providing critical context for generating better learnings.

### 3. Persist Enriched Data

**File:** `worker/situation_artifact.ts`
**Function:** `createSituationArtifactForRequest`

I will ensure the full `recognition` result, now containing the `boundedContext` for each similar job, is correctly persisted within the `meta.recognition` field of the main job's SITUATION artifact. This makes the data available for the frontend to consume.

## Phase 2: Frontend Update

The goal is to display this new, detailed context on the job detail page.

### 1. Expose Data via API

**File:** `frontend/explorer/src/app/api/memory-inspection/route.ts`

I will modify the API route to look for and return the new `boundedContext` data attached to each entry in the `similarJobs` array.

### 2. Enhance the Recognition Card

**File:** `frontend/explorer/src/components/job-phases/recognition-phase-card.tsx`

I will significantly refactor this component to:
1.  **Display Current Job's Context:** Add a new, non-collapsible section at the top of the card that shows the parent, children, and siblings for the job currently being viewed. This will be fetched directly using the subgraph.
2.  **Create Expandable Similar Jobs:** Each item in the "Similar Jobs Found" list will become a collapsible element. The summary will show the job name and similarity score.
3.  **Display Similar Job Context:** When expanded, each similar job item will display its own bounded context (parent, children, siblings), including their status and a link. This allows for deep, on-demand exploration of the recognition results.

This will be achieved by creating a reusable `JobContextDisplay` component to render the parent/child/sibling information consistently.

```tsx
// frontend/explorer/src/components/job-phases/recognition-phase-card.tsx (conceptual change)

// 1. Display context for the current job
<h4...>This Job's Context</h4>
<JobContextDisplay context={currentJobContext} />

// 2. Make similar jobs expandable
<h4...>Similar Jobs Found</h4>
{similarJobs.map(job => (
  <details>
    <summary>{job.jobName} - {job.score}% match</summary>
    // 3. Display context for the similar job
    <JobContextDisplay context={job.boundedContext} />
  </details>
))}
```


### To-dos

- [ ] Update worker to perform bounded traversal on similar jobs.
- [ ] Update recognition prompt to include bounded context.
- [ ] Persist the enriched context data in the SITUATION artifact.
- [ ] Expose bounded context data via the memory inspection API.
- [ ] Update the RecognitionPhaseCard to display context for the current job.
- [ ] Make similar jobs in RecognitionPhaseCard expandable.
- [ ] Display bounded context for expanded similar jobs.