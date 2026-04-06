---
name: Fix Recognition Learning Ambiguity
overview: ""
todos:
  - id: e18be9f7-0acd-4782-9eac-5dbb51a0a4b7
    content: Update worker/recognition_helpers.ts prompt instructions
    status: pending
  - id: 66573e9f-3aee-4fcc-a8c1-48d06c0aa0dc
    content: Update worker/prompt/providers/assertions/RecognitionProvider.ts assertion formatting
    status: pending
  - id: 5e822883-10d0-4a52-ab26-6b604b520594
    content: Update worker/prompt/system-blueprint.json system assertion
    status: pending
---

# Fix Recognition Learning Ambiguity

The agent is hallucinating delegation because recognition learnings are framed as imperative instructions ("Structure as orchestrator") which the agent interprets as narrative instructions. We will reframe them as historical observations of tool usage.

## 1. Update Recognition Prompt (`worker/recognition_helpers.ts`)

- **Goal**: Force the recognition agent to output descriptive observations of *what happened*, not prescriptive advice.
- **Changes**:
- Update `buildRecognitionPromptWithArtifacts` instructions to emphasize "Observed Tool Usage".
- Update the JSON schema description for `actions` to: `"Observed action (e.g. 'Called dispatch_new_job twice')"`
- Add explicit instruction: "Do not give generic advice. Describe specific tool calls that led to success."

## 2. Update Recognition Provider (`worker/prompt/providers/assertions/RecognitionProvider.ts`)

- **Goal**: Format assertions to be clearly historical.
- **Changes**:
- Prefix `do` examples with `[Historical Pattern]`.
- Update `commentary` to explicitly state: "WARNING: You must EXECUTE these tools. Do not just describe them in your summary.

## 3. Verification

- **Method**: Inspect the updated files to ensure the prompt logic flows correctly. (We cannot re-run the job deterministically to verify the fix immediately, but the prompt change addresses the root cause).