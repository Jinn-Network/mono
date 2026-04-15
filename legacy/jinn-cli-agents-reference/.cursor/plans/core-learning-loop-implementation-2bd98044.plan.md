<!-- 2bd98044-339c-49a2-a03a-d72e44d373b6 d3aff7b0-5cc3-40fa-9f5a-a5e107eeb7f5 -->
# Plan: Memory System Testing and Benchmarking

This document details the testing plan for the Agent Memory Management system. It is divided into two sections: functional testing to verify correctness and a benchmarking protocol to measure performance impact.

## 1. Functional Testing

These tests ensure each component of the learning loop works as expected. They should be executed sequentially.

### Test 1: Memory Creation (Reflection)

- **Objective**: Verify that a successfully completed job triggers the reflection step and creates a `MEMORY` artifact.
- **Procedure**:

    1.  Execute a specific, novel job. A good candidate is a simple research task like: `"What is the contract address for the OLAS token on Ethereum mainnet? Answer with only the address."`
    2.  Monitor the worker logs to confirm the job status is `COMPLETED`.
    3.  Confirm that the "Starting reflection step" log message appears.
    4.  Use the `search_artifacts` tool (or query Ponder directly) to find the artifact created by the reflection agent.

- **Success Criteria**:
    - An artifact with `type: 'MEMORY'` is created.
    - The artifact's content relates to the completed job's output (e.g., contains the OLAS contract address).
    - The artifact has relevant `tags` (e.g., `['olas', 'contract-address']`).

### Test 2: Memory Discovery & Injection

- **Objective**: Verify that a new, similar job discovers and uses the memory created in Test 1.
- **Procedure**:

    1.  Execute a new job with a similar `jobName` or prompt, but rephrased: `"Find the mainnet contract for the OLAS token."`
    2.  Monitor the worker logs for the "Searching for relevant memories" and "Injected memories into context" messages.
    3.  Examine the full prompt passed to the agent in the logs.

- **Success Criteria**:
    - The log confirms that 1 or more memories were found and injected.
    - The agent's prompt includes the content of the memory from Test 1.
    - The agent should solve the task much faster, likely without needing to perform external searches, by directly using the provided context.

### Test 3: Memory Rating

- **Objective**: Verify that the `rate_memory` tool correctly updates an artifact's utility score.
- **Procedure**:

    1.  Identify the `artifactId` of the memory created in Test 1.
    2.  Create a simple script or agent that calls `rate_memory` with the `artifactId` and a rating of `1`.
    3.  Check the `utility_scores` table in the Supabase database.

- **Success Criteria**:
    - A new row is created in `utility_scores` for the `artifactId`.
    - The `score` is `1` and `access_count` is `1`.
    - Calling `rate_memory` again with a rating of `-1` updates the `score` to `0` and `access_count` to `2`.

### Test 4: Negative Case - No Reflection on Failure

- **Objective**: Verify that a failed job does *not* trigger the reflection step.
- **Procedure**:

    1.  Execute a job designed to fail (e.g., by providing a prompt that forces an error or calls a non-existent tool).
    2.  Monitor the worker logs to confirm the job status is `FAILED`.

- **Success Criteria**:
    - The "Starting reflection step" log message does *not* appear.
    - No `MEMORY` artifact is created for this job.

---

## 2. Benchmarking Protocol

This protocol uses the `scripts/benchmark-memory-system.ts` script to objectively measure the performance impact of the memory system.

### Phase 1: Environment Setup

- **Action**: Ensure a clean state for a fair test. If previous tests have populated memories, you may want to clear the `utility_scores` table in Supabase and potentially restart Ponder to ensure you're starting from a known baseline.
- **Command**: `supabase db reset` (if a completely fresh start is needed).

### Phase 2: Establish Baseline

- **Objective**: Measure the performance of the agent architecture *without* the memory system.
- **Action**: Run the benchmark script in baseline mode. This will execute each of the 5 predefined test jobs 10 times. The `DISABLE_MEMORY_INJECTION` flag will be set to `true` internally.
- **Command**: `yarn ts-node scripts/benchmark-memory-system.ts --baseline`
- **Output**: A JSON report file (e.g., `benchmark-results/benchmark-baseline-TIMESTAMP.json`) containing detailed metrics.

### Phase 3: "With Memory" Performance

- **Objective**: Measure performance with the memory system fully enabled, allowing it to build and use its knowledge base.
- **Action**: Run the benchmark script in the "with-memory" mode. The script will execute the same jobs, but this time the memory injection and reflection steps will be active. Early iterations will build the knowledge base, and later iterations will benefit from it.
- **Command**: `yarn ts-node scripts/benchmark-memory-system.ts --with-memory`
- **Output**: A second JSON report file (e.g., `benchmark-results/benchmark-with-memory-TIMESTAMP.json`).

### Phase 4: Analysis & Verdict

- **Objective**: Compare the two reports to quantify the impact of the memory system.
- **Action**: Use the script's built-in comparison tool.
- **Command**:
  ```bash
  yarn ts-node scripts/benchmark-memory-system.ts --compare \
    benchmark-results/benchmark-baseline-*.json \
    benchmark-results/benchmark-with-memory-*.json
  ```

- **Success Criteria**: The comparison must show a statistically significant improvement in at least two of the following Key Performance Indicators (KPIs), as per the project proposal:
    - **Success Rate**: Increase in percentage of successful job completions.
    - **Token Consumption**: Decrease in average tokens used per job.
    - **Completion Time**: Decrease in average job duration.
    - **Tool Errors**: Reduction in the number of failed tool calls.

The output will provide a clear verdict on whether the memory system has achieved its performance goals for Phase 1.

### To-dos

- [ ] Create a testing plan document.
- [ ] Define functionality tests for the memory component.
- [ ] Define the benchmarking protocol.