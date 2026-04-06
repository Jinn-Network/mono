<!-- 53993810-72bc-4e64-8037-3fa919ae1b1c 96c57ada-9c5f-4b33-b1e8-1c7c8de1c45b -->
# Verification Plan: Memory System Observability (Revised)

This plan details the steps to verify the CLI, MCP, and frontend components for the memory system observability features, using existing data and browser automation.

## Part 1: Find a Test `requestId`

I will query the production Ponder subgraph to find a completed job that already has a `SITUATION` artifact, eliminating the need to run a new job.

1.  **Query for Artifacts**: I will execute a `curl` command to query the Ponder GraphQL endpoint for a request ID associated with a `SITUATION` artifact.

    -   **Command**:
        ```bash
        curl -s https://ponder-production-6d16.up.railway.app/graphql -H "Content-Type: application/json" -d '{"query": "{ artifacts(where: {topic: \\"SITUATION\\"}, limit: 1) { items { requestId } } }"}'
        ```

    -   **Expected Outcome**: A JSON response containing a `requestId` that I can use for the subsequent verification steps.

## Part 2: CLI Verification

I will verify that the `inspect-situation.ts` script can successfully fetch and display memory information for the `requestId` found in Part 1.

1.  **Run Inspection Script**:

    -   **Command**: `yarn tsx scripts/memory/inspect-situation.ts <request-id-from-part-1>`
    -   **Expected Outcome**: The script outputs a formatted summary to the console, including SITUATION details, the database record, and similar situations.

## Part 3: MCP Tool Verification

I will test the `inspect_situation` MCP tool directly to ensure it returns the correct structured JSON data.

1.  **Invoke MCP Tool**: I will create a temporary script (`scripts/memory/verify-mcp-tool.ts`) to programmatically call the `inspect_situation` tool. This is more reliable than using the Gemini CLI directly for verification. The script will:

    -   Import the MCP server setup.
    -   Directly invoke the `inspect_situation` handler with the `requestId`.
    -   Print the JSON result to the console.
    -   The script will be deleted after use.

2.  **Run Verification Script**:

    -   **Command**: `yarn tsx scripts/memory/verify-mcp-tool.ts <request-id-from-part-1>`
    -   **Expected Outcome**: The script outputs the full, structured JSON response from the tool, which can be validated for correctness.

## Part 4: Frontend Verification via Browser Automation

I will use Playwright to verify the `MemoryVisualization` component. A temporary test script will be created and deleted after the test run.

1.  **Create Temporary Test Script**: I will write a temporary Playwright test file to `tests/e2e/temp-memory-verify.spec.ts`. This test will navigate to the production explorer page for the test `requestId` and assert that the "Memory System Inspection" section is visible.
2.  **Execute Playwright Test**:

    -   **Command**: `yarn playwright test tests/e2e/temp-memory-verify.spec.ts`

3.  **Clean Up**:

    -   **Command**: `rm tests/e2e/temp-memory-verify.spec.ts`

4.  **Expected Outcome**: The Playwright test will pass, confirming the component is correctly integrated, and the temporary test file will be removed.

### To-dos

- [ ] Query Ponder to find a suitable `requestId`.
- [ ] Run the `inspect-situation.ts` CLI script and verify its output.
- [ ] Create and run a script to test the `inspect_situation` MCP tool.
- [ ] Create, run, and delete a temporary Playwright test for the frontend.