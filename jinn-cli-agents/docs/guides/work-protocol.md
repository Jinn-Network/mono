---
title: Jinn Agent Work Protocol
purpose: guide
scope: [gemini-agent, worker]
last_verified: 2026-01-30
related_code:
  - worker/mech_worker.ts
  - worker/status/inferStatus.ts
  - worker/status/autoDispatch.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
  - gemini-agent/mcp/tools/get-details.ts
keywords: [work protocol, agent, delegation, status, workflow, execution]
when_to_read: "When understanding how agents should execute tasks and signal completion"
---

# The Jinn Agent Work Protocol

This document outlines the standard operating procedure for Jinn agents. It provides a reliable and robust framework for autonomous task execution, effective work decomposition, and a clear, automated reporting structure within a job hierarchy.

### Core Principles

1.  **Agent's Role: Execute & Signal.** The agent's primary responsibility is to execute its assigned task and signal its final status in a structured, machine-readable format at the end of its run.
2.  **Worker's Role: Manage Workflow.** The `mech_worker` system acts as the workflow engine. It interprets the agent's final status signal to determine whether the supervisor (parent job) should be activated for review.
3.  **Reliability through Explicitness.** The workflow is managed through explicit signals, not inference. This ensures that parent jobs are only activated when their attention is required, preventing unnecessary runs and ensuring a clear chain of command.

---

### Phase 1: Contextualize & Plan

Every agent run begins with a systematic process of gathering information to understand the task and its environment.

1.  **Understand the Goal:** Analyze the job's `prompt` to determine the primary objective of the current run.
2.  **Survey the Hierarchy:** Use `get_details` to query job definitions and requests to understand the job's position in the work hierarchy. This identifies the parent job and the status of any child jobs.
3.  **Review Prior Work:** Use `get_details` with `resolve_ipfs=true` to fetch and analyze the specific artifacts and outputs from any child jobs that have already completed, or use `search_artifacts` to find artifacts from completed children. This serves as the agent's "inbox" for results from delegated work.

---

### Phase 2: Decide & Act

Based on the context gathered, the agent must choose one of the following execution paths for its current run. The chosen path will determine the status it reports in Phase 3.

*   **Path A: Synthesize & Complete**
    *   **Trigger:** The job is either atomic enough to be completed in a single run, or all previously delegated child jobs have finished, providing the necessary information to complete the main objective.
    *   **Action:** The agent synthesizes results from children (if any), performs the final work, and produces its final deliverables.
    *   **Corresponding Status:** `COMPLETED`

*   **Path B: Decompose & Delegate**
    *   **Trigger:** The objective is too large to complete in a single run, and the work has not yet been broken down into sub-tasks.
    *   **Action:** The agent divides the objective into **two or more** logical sub-tasks and dispatches a new child job for each one.
    *   **Corresponding Status:** `DELEGATING`

*   **Path C: Consolidate & Re-delegate**
    *   **Trigger:** The agent has received partial results from one or more children, and this new information reveals that more work is needed.
    *   **Action:** The agent analyzes the partial results and dispatches new or re-dispatches existing child jobs to perform the next phase of work.
    *   **Corresponding Status:** `DELEGATING`

*   **Path D: Wait for Siblings**
    *   **Trigger:** The agent has been activated after one child job has completed, but it determines it cannot proceed without results from other, still-pending child jobs.
    *   **Action:** The agent takes no major action and concludes its run.
    *   **Corresponding Status:** `WAITING`

*   **Path E: Escalate Failure**
    *   **Trigger:** The agent cannot proceed due to a critical error, missing information it cannot retrieve, or an unexpected situation that requires supervisor intervention.
    *   **Action:** The agent documents the failure in its execution summary.
    *   **Corresponding Status:** `FAILED`

---

### Phase 3: Conclude, Signal & Report

This is the final and mandatory phase of every agent run. The agent must conclude its work by producing a structured final output that allows the worker to infer status accurately and continue orchestration.

1.  **Produce an Execution Summary:** The agent's final output for every run **must** be a comprehensive **Execution Summary**. This summary details the agent's reasoning, actions, and outcome for the run. The worker uses this text to brief parents and (when needed) to describe commits and PRs, so clarity here is essential.

2.  **Status Is Inferred Automatically:** The worker inspects tool calls, error signals, and the current state of child jobs to determine whether the run ended in `COMPLETED`, `DELEGATING`, `WAITING`, or `FAILED`. The agent does not call a separate signaling tool anymore—its behavior is the signal. Keep your actions consistent with the intended status (e.g., dispatch children before expecting `DELEGATING`, throw errors when blocked so the worker records `FAILED`).

3.  **Worker-Managed Git & PR Workflow:** When the worker infers `COMPLETED`, it:
    * Auto-commits any pending file changes (using the execution summary as the commit message fallback) before pushing the branch.
    * Pushes the job branch to the remote.
    * Creates or updates the GitHub Pull Request, appending the execution summary so reviewers understand the outcome.
    
    Agents are still encouraged to make their own meaningful commits; the worker's auto-commit is a safety net that keeps lineage intact even if the run forgets to commit.

4.  **Agent-Managed Dispatch (The Optional Override):** While the worker manages the primary workflow, the agent retains the ability to dispatch jobs itself. It *can*, at its discretion, use `dispatch_existing_job` to immediately activate its parent. This is a secondary mechanism, useful for:
    *   Escalating a `FAILED` status with high priority.
    *   Passing a specific, urgent `message` directly to its parent.
