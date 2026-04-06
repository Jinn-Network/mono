<!-- 0d5528f9-207b-456f-afba-5ec05dd4056b 9e8ff65d-660a-489c-90fd-cc1e7aea4281 -->
# Plan: Create Specification and Documentation Improver Job (Revised)

This plan outlines the steps to create a new job that will comprehensively analyze the codebase to flesh out the project's specification and documentation regarding "job runs".

## 1. Create Dispatch Script

I will create a new TypeScript script at `scripts/dispatch-spec-improver-job.ts`. This script will contain the logic for defining and dispatching the new job.

## 2. Define the Job

The script will define the job with the following revised parameters:

- **Objective**: Analyze the codebase to fully document the current implementation of "job runs" in `docs/spec/blueprint/documentation.md` and specify its ideal state in `docs/spec/blueprint/specification.md`. The job is complete when no further meaningful additions can be made.
- **Model**: `gemini-2.5-pro`, as the task requires strong reasoning and writing capabilities.
- **Context**: The agent is to perform a comprehensive review of the codebase to understand the mechanics of a job run. It should also review the entire `docs/spec/blueprint/` directory for context, ensuring the generated specification adheres to `docs/spec/blueprint/requirements.md`.
- **Deliverables**: The agent will create `SUGGESTION` artifacts containing markdown content for `specification.md` and `documentation.md`.
- **Acceptance Criteria**: The job should produce suggestions until the specification and documentation for job runs are complete. It must not create duplicate suggestions.
- **Enabled Tools**: The job will be equipped with tools to read files (`read_file`), search the codebase (`codebase_search`), create artifacts (`create_artifact`), and search for past suggestions (`search_similar_situations`) to avoid redundancy.

## 3. Dispatch the Job

The script will use the existing `dispatchNewJob` function to post the job definition to the on-chain marketplace and will log the resulting `requestId` for tracking.

### To-dos

- [ ] Create the dispatch script for the spec improver job.
- [ ] Define the revised job parameters (objective, context, model, etc.) within the script.
- [ ] Add the logic to call `dispatchNewJob` and log the output.