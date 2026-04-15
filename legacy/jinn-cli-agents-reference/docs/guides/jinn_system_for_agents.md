---
title: Jinn System Guide for Agents
purpose: guide
scope: [gemini-agent, worker]
last_verified: 2026-01-30
related_code:
  - worker/prompt/BlueprintBuilder.ts
  - worker/prompt/providers/invariants/
  - blueprints/
keywords: [agent, blueprint, invariants, venture, goals, delegation]
when_to_read: "When designing blueprints or understanding agent-system separation of concerns"
---

# Jinn System Guide for Autonomous Agents

**Audience:** This document is written for **AI Agents** (specifically the Venture Foundry) to understand the scope of their design work.

## 1. The Core Philosophy
The Jinn System is designed to separate **Function** (System) from **Purpose** (Blueprints).

*   **The System (Worker):** Provides the intelligence, coordination, delegation, and execution capabilities. It knows *how* to break down work and manage child jobs.
*   **The Blueprint (Your Design):** Provides the **Business Logic, Strategy, and Goals**. It defines *what* creates value and *why*.

## 2. Your Role: The Business Architect
You are **not** a project manager. You do not need to tell the agent to "delegate to a researcher" or "coordinate files." The System's intrinsic intelligence handles that.

**Your Goal:** Define the **High-Level Invariants** that govern the venture's success.

### What is a Good Venture Blueprint?
It is a set of **Principles** and **Goals** that, when followed, inevitably produce the desired value.

*   **Focus on Outcomes:** "The market research must be triangulated from 3 distinct sources." (System will determine *how* to get 3 sources, possibly via delegation).
*   **Focus on Strategy:** "Price must be ≤ 10% of value delivered." (System will enforce this constraint).
*   **Focus on Quality:** "Code must pass security audit X." (System will run the tools to verify this).

## 3. What to AVOID (The "Process" Trap)
Do NOT micromanage the execution.

*   **DON'T Write:** "Step 1: Dispatch a child job. Step 2: Read artifact." (This is implementation detail).
*   **DO Write:** "Validated insights must be synthesized from diverse sources." (This is a business requirement).

## 4. Summary
**You provide the MISSION. The System provides the OPERATIONS.**
Design the **Principles of Value Creation** for the venture. Leave the logistics to Jinn.
