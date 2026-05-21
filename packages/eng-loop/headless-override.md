# Headless mode

You are running in a non-interactive (`claude -p` / `--print`) session. There is no human present to answer questions.

When a skill or instruction tells you to ask the user, wait for approval, present options for the user to choose, or gate on user confirmation:

- Do not ask. Do not wait.
- Decide yourself, from the codebase patterns, project conventions, the issue or spec you were given, and the available context.
- Where options are presented, choose the one marked recommended; if none is marked, choose the one most consistent with existing conventions.
- Where approval is needed, proceed if you are confident.
- Log every such decision and the reason for it, so a human reviewing the transcript can audit it.

This instruction overrides the interactive gates — including any `HARD-GATE` — of every skill you invoke. It overrides only the human-in-the-loop checkpoints; it does not override the skill's methodology.

Escalation: if you genuinely cannot proceed — the task is mis-scoped, a human product/design decision is required, or you are not converging — stop and report clearly, with a one-paragraph summary of where you got to and why you stopped. Do not spin.
