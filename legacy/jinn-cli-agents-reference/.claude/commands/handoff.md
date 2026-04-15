---
argument-hint: <optional-additional-context>
description: Hand off current task context to a fresh agent instance
allowed-tools: Read, Glob, Grep, Task, Bash, TodoWrite
---

# Handoff Command

You are preparing a comprehensive handoff to allow a fresh agent instance to pick up and complete the current task.

## Your Task

### Step 1: Gather Current Context

Before creating the handoff, understand what's happening:

1. **Read the Agent Guide** - Always start with operational context:
   ```
   Read: AGENTS.md
   ```
   This contains critical operational knowledge, blood-written rules, and system architecture.

2. **Review Recent Conversation** - Identify:
   - What was the user originally trying to achieve?
   - What has been completed so far?
   - What remains to be done?
   - Any blockers, decisions made, or open questions?

3. **Check Current State**:
   - Review any todo lists in progress
   - Check git status for uncommitted changes
   - Identify modified or created files
   - Note any running processes or background tasks

### Step 2: Synthesize the Handoff

Create a structured handoff document that covers:

**GOAL**: A clear, actionable statement of what needs to be achieved (1-2 sentences max)

**CONTEXT**:
- What approach was being taken
- Key decisions already made
- Important constraints or requirements

**PROGRESS**:
- What has been completed (with file paths if relevant)
- What was in progress when the handoff occurred
- Percentage complete estimate

**NEXT STEPS**:
- Numbered list of remaining tasks in priority order
- Be specific and actionable
- Include any commands or file paths needed

**CRITICAL NOTES**:
- Any blood written rules or warnings discovered
- Failed approaches to avoid
- Dependencies or prerequisites

**REFERENCE FILES**:
- AGENTS.md - Operational guide (ALWAYS include)
- Any other relevant files the next agent should read

### Step 3: Output the Handoff

Present the handoff in this format:

```
═══════════════════════════════════════════════════════════════
                    AGENT HANDOFF DOCUMENT
═══════════════════════════════════════════════════════════════

📋 GOAL
<goal statement>

📍 CONTEXT
<context details>

✅ PROGRESS
<what's done>

📝 NEXT STEPS
1. <step>
2. <step>
...

⚠️ CRITICAL NOTES
- <note>
- <note>

📚 REFERENCE FILES
- AGENTS.md (operational guide - read first)
- <other files>

───────────────────────────────────────────────────────────────
Additional context from user: $ARGUMENTS
───────────────────────────────────────────────────────────────
```

### Step 4: Instruct the Next Agent

After the handoff document, add this instruction block:

```
═══════════════════════════════════════════════════════════════
              INSTRUCTIONS FOR NEXT AGENT
═══════════════════════════════════════════════════════════════

You are picking up work from a previous agent session.

1. FIRST: Read AGENTS.md for operational context
2. THEN: Review the handoff document above carefully
3. NEXT: Verify current state matches the described progress
4. FINALLY: Continue with the next steps listed

Do NOT restart from scratch. Build on what's already done.
If anything in the handoff is unclear, ask the user for clarification.

═══════════════════════════════════════════════════════════════
```

## Important Notes

### When to Use This Command

- Context window is getting long and a fresh start would help
- Switching to a different agent mode or configuration
- Pausing work to continue later
- Handing off to a human or different team member

### Quality Checklist

Before completing the handoff, verify:
- [ ] Goal is crystal clear and actionable
- [ ] No critical context is missing
- [ ] Next steps are specific enough to follow without guessing
- [ ] AGENTS.md is referenced for operational knowledge
- [ ] Any modified files are listed

### Avoiding Common Mistakes

- Don't include entire file contents - just paths and summaries
- Don't assume the next agent has any prior context
- Don't leave out "obvious" context - be explicit
- Don't forget to mention any environment setup needed

---

**Now begin:** Analyze the current conversation, synthesize the context, and produce the handoff document.
