<!-- 8a0cb0a2-e538-4832-ba5b-9f4305da5da3 dccfe46a-2c8c-4c8c-8b9c-46774b44f106 -->
# Plan: Implement Automatic Memory Rating

This plan details the implementation of an automatic memory rating system within the worker's post-job reflection step. The goal is to have the agent that created a new memory also rate the memories that were used to complete the job, creating a full end-to-end learning loop.

### 1. Track Injected Memory IDs

In `worker/mech_worker.ts`, I will modify the memory injection logic to store the IDs of the memories that are fetched and prepared for the agent's prompt.

-   **File**: `worker/mech_worker.ts`
-   **Location**: Around line 830, where the `memories` array is populated.
-   **Action**: I will introduce a new variable, `injectedMemoryIds`, to store the `id` of each memory that is successfully fetched and added to the prompt context.

    ```typescript
    // worker/mech_worker.ts (around line 785)
    // ...
    let memories: any[] = [];
    const injectedMemoryIds: string[] = []; // New variable to track IDs
    // ...
    if (searchData) {
      memories = JSON.parse(searchData)?.data || [];
      if (memories.length > 0) {
        // ... existing code to fetch content ...
        
        // Store the IDs of the memories that will be injected
        memories.slice(0, 2).forEach((mem: any) => injectedMemoryIds.push(mem.id));
      }
    }
    ```

### 2. Update Reflection Prompt

I will enhance the `reflectionPrompt` to include a new section that instructs the agent to rate the memories that were used. This section will only appear if memories were injected into the job.

-   **File**: `worker/mech_worker.ts`
-   **Location**: Around line 885, where `reflectionPrompt` is defined.
-   **Action**: I will conditionally add a "Memory Rating Task" to the prompt, listing the `injectedMemoryIds` and instructing the agent to use the `rate_memory` tool.

    ```typescript
    // worker/mech_worker.ts (around line 885)
    const reflectionPrompt = `You have just completed a job. Here is a summary:
    // ... existing job summary ...

    ${injectedMemoryIds.length > 0 ? `
    **Memory Rating Task:**
    The following memories were provided to help with this job:
    ${injectedMemoryIds.map(id => `- ${id}`).join('\n')}

    Please rate each memory's usefulness by calling the \`rate_memory\` tool.
    - Use rating: "1" if the memory was helpful.
    - Use rating: "-1" if the memory was not helpful or misleading.
    ` : ''}

    **Reflection Task (Memory Creation):**
    // ... existing reflection task for creating memories ...
    `;
    ```

### 3. Grant `rate_memory` Tool to Reflection Agent

Finally, I will update the instantiation of the `reflectionAgent` to grant it access to the `rate_memory` tool, in addition to `create_artifact`.

-   **File**: `worker/mech_worker.ts`
-   **Location**: Around line 926, where the `reflectionAgent` is created.
-   **Action**: Add `'rate_memory'` to the array of tools passed to the `Agent` constructor.

    ```typescript
    // worker/mech_worker.ts (around line 926)
    const reflectionAgent = new Agent(
      process.env.MECH_MODEL || 'gemini-2.5-flash',
      ['create_artifact', 'rate_memory'], // Add 'rate_memory' tool
      { /* ... existing context ... */ }
    );
    ```

This completes the implementation. The next job that uses a memory will automatically trigger a rating during its reflection step, fully closing the `Create → Find → Use → Rate` loop.

### To-dos

- [ ] Track Injected Memory IDs in `worker/mech_worker.ts`
- [ ] Update Reflection Prompt with Rating Instructions
- [ ] Grant `rate_memory` Tool to Reflection Agent