# Code Spec

## Overview

This specification defines desired code patterns for an AI-generated codebase. It ensures consistency across multiple AI sessions and makes the codebase maintainable by both humans and future AI agents.

**Inspired by:** [OpenAI Model Spec](https://github.com/openai/model_spec)

**Philosophy:** In an AI-generated codebase, different prompts naturally produce different solutions to the same problem. Without explicit guidance, patterns drift and the codebase becomes inconsistent. This spec provides that guidance.

## How to Read This Spec

This specification is organized into three tiers:

1. **Objectives** - High-level goals and guiding philosophies
2. **Rules** - Hard constraints that must never be violated
3. **Default Behaviors** - Standard patterns for common operations

### What is a "clause"?

A **clause** is a single item within the spec—one objective, one rule, or one default behavior. For example:
- "Follow the principle of orthodoxy" is an objective clause
- "Never commit secrets" would be a rule clause (when we add it)
- "Use environment variables for configuration" could be a default behavior clause (when we add one)

Each clause has:
- A **title** - What it addresses
- A **description** - What it means and why it matters
- **Footnote references** - Links to example files (e.g., `[^db01]`)

### Example files

The `examples/` directory contains test cases that demonstrate what correct and incorrect code looks like:
- **Naming:** `obj1.md`, `obj2.md` (objectives), `r1.md`, `r2.md` (rules), `db1.md`, `db2.md` (default behaviors)
- **Content:** Each file shows either correct implementation or a specific violation
- **Purpose:** These teach both humans and AI agents what the clause means in practice

---

## Objectives

Objectives are high-level goals that provide directional guidance for all code. They inform the rules and default behaviors.

### Follow the principle of orthodoxy

> "There should be one—and preferably only one—obvious way to do it."
> — PEP 20 (The Zen of Python), Principle #13

**The principle:** For any given problem domain in this codebase, there must be one canonical approach. All code must follow the established approach, even if alternative approaches exist.

**Why this matters for AI-generated code:**
- Different prompts → different solutions
- Different AI models → different idioms
- Different sessions → stylistic drift
- Result: Codebase becomes unlearnable

**Application:** When you encounter code that solves the same problem in multiple ways, this violates orthodoxy. Identify the canonical approach, document it as a default behavior, and migrate all code to follow it.

**See examples:** [Objective 1 Examples](#objective-1-orthodoxy---one-obvious-way)

### Code for the next agent

> "Explicit is better than implicit."
> — PEP 20 (The Zen of Python), Principle #2

**The principle:** AI agents are the primary developers and maintainers of this codebase. Every line of code should be written with the next AI session in mind—optimized for machine discoverability, readability, and comprehension.

**Why this matters for AI-generated code:**
- AI agents learn by reading existing code
- AI agents navigate codebases by pattern matching and search
- Implicit behavior, clever tricks, and hidden context confuse AI
- The ratio of code-reading to code-writing is extreme in AI development

**What this means in practice:**
- **Explicit over implicit:** Make intentions clear through naming, types, and structure
- **Discoverable patterns:** Use consistent, greppable patterns that AI can find
- **Self-documenting:** Code should explain what it does without requiring external context
- **Minimal cleverness:** Favor clarity over conciseness when they conflict
- **Fail fast, fail explicitly:** Prefer throwing errors over silent fallbacks. If something is broken, make it visible—don't hide failures behind degraded behavior

**Application:** When writing code, ask: "Will the next AI agent understand this?" If it requires human intuition, domain knowledge not in the codebase, or clever inference, it violates this objective.

**See examples:** [Objective 2 Examples](#objective-2-code-for-the-next-agent)

### Minimize harm

> "First, do no harm."
> — Adapted from the Hippocratic Oath

**The principle:** Prevent code from causing harm to users, systems, or data. Security, safety, and privacy are not optional features—they are foundational requirements.

**Why this matters for AI-generated code:**
- AI agents may not understand all security implications
- AI agents learn from examples that might include insecure patterns
- Security vulnerabilities compound across AI sessions
- A single compromised secret or SQL injection can cascade through the system

**What this means in practice:**
- **Security by default:** Choose secure patterns over convenient ones
- **Validate all inputs:** External data is untrusted until proven safe
- **Fail securely:** When errors occur, fail closed (deny access) not open
- **Guard secrets:** Never commit credentials, API keys, or sensitive data to the repository
- **Principle of least privilege:** Grant minimum necessary permissions

**Application:** When generating code, ask: "Could this be exploited? Could this leak data? Could this cause damage?" If the answer is possibly yes, redesign before implementing.

**Relationship to Rules:** This objective informs future Rules like "Never commit secrets" and "Always validate external input." The objective is the "why," Rules are the "must never."

**See examples:** [Objective 3 Examples](#objective-3-minimize-harm)

---

## Rules

Rules are hard constraints that must never be violated. Unlike objectives (which are directional) and default behaviors (which allow rare exceptions), rules are absolute.

### Never commit secrets to the repository

**The rule:** Secrets (private keys, API keys, passwords, tokens) must never be committed to git. All sensitive configuration is sourced from environment variables or secret managers.

**Why this matters:**
- Git history is immutable—once committed, secrets are permanently exposed.
- A single leaked agent key can drain all funds from its Safe.
- Generated examples sometimes include placeholder secrets unless the rule is explicit.

**What counts as a secret:**
- Private keys, mnemonics, wallet dumps
- API keys for Gemini, Tenderly, RPC providers
- Service passwords such as OLAS middleware credentials
- Access tokens, session tokens, refresh tokens

**How to comply:**
- Load secrets from environment variables or secure stores at runtime.
- Provide `.env.example` files with obvious placeholders for documentation.
- Never hardcode credentials in code, comments, or docs.

See `docs/spec/code-spec/examples/r1.md` for canonical samples.

### Enforce automated secret guardrails

**The rule:** Every automated git workflow—workers, bots, CI jobs, test harnesses—must invoke the canonical secret guard before staging, committing, or pushing code. The guard enforces a shared denylist for secret-bearing paths (e.g., `.operate/`, `.operate-test/`, `*private_key*`) and fails closed if any appear in the staged tree.

**Why this matters:**
- Automation is trusted to keep history clean; skipping the guard makes leaks permanent.
- AI agents reuse commit helpers; an insecure helper propagates everywhere.
- Preventing secret commits is far cheaper than rotating wallets and remediating public leaks.

**How to comply:**
- Call the guard immediately before `git commit` / `git push` / `git add --all` in automation flows.
- Abort the workflow when the guard flags a violation; never auto-skip or partially commit.
- Keep denylist updates centralized inside the guard helper.

See `docs/spec/code-spec/examples/r4.md` for compliant and violating examples.

---

## Default Behaviors

Default behaviors define the standard way to handle common operations. They keep implementation patterns consistent and discoverable. Deviations must be documented.

### Centralize configuration access

- Runtime code reads configuration exclusively through `config/index.ts` helpers.
- The config module loads environment variables once, validates them, and exposes getters like `getRequiredRpcUrl()`.
- Callers never access `process.env` directly; legacy aliases live only inside the config module.

### Keep ephemeral secret fixtures out of tracked repos

- Tests and tooling must write generated wallets/keys to the canonical temp workspace (outside git worktrees) and clean it up afterward.
- Directories such as `.operate-test/` must never be created under a tracked repository.
- Pass the absolute temp path via env vars (e.g., `OPERATE_HOME`) instead of relying on `process.cwd()`.

See `docs/spec/code-spec/examples/db7.md` for the canonical pattern.

### Canonical HTTP client with timeout & retry

- All runtime HTTP calls use the shared client in `http/client.ts`, which applies timeouts, retries, and structured errors.
- Callers import helpers like `postJson`, `getJson`, or `graphQLRequest` instead of using `fetch` directly.
- Extend the shared client when new behavior (e.g., streaming) is required so protections apply everywhere.

### Validate staged content before auto-commit

- Auto-commit helpers must invoke the staged-tree validator immediately after staging changes.
- If forbidden paths are staged, the helper throws a descriptive error and stops the workflow.
- Guard updates stay centralized; callers do not maintain private allowlists.

See `docs/spec/code-spec/examples/db8.md` for a reference implementation.

### Structured logging only

- Runtime code logs through `logging/index.ts`, creating child loggers with a `component` tag.
- Logs include structured metadata (request ID, job ID, etc.) and avoid leaking sensitive values.
- Direct `console.*` usage is reserved for documented exceptions (e.g., human-facing CLI prompts).

### No silent catch

- Every `catch` block logs the error (with context) and either rethrows or returns an explicit degraded-mode result.
- Empty `catch {}` blocks and `.catch(() => …)` patterns that suppress errors are prohibited.
- Use `serializeError()` to provide readable details without exposing secrets.

---

## Enforcement

This spec is enforced through multiple verification layers, ensuring code quality without blocking developer productivity.

### Current Enforcement Methods

#### 1. Pre-commit Git Hooks (Strict Mode)

**Status:** ✅ Implemented

Automatically reviews staged TypeScript files before each commit:

```bash
# Install once
yarn setup:hooks

# Commits are now automatically reviewed
git commit -m "feat: new feature"  # Review runs (strict)
git commit -m "wip: experimenting" # Skipped (WIP prefix)
git commit --no-verify             # Bypassed (emergency)
```

**How it works:**
- Runs `claude -p "/review-code-spec --diff"` via `codespec/scripts/detect-violations.sh`
- Analyzes only staged changes (fast, focused)
- Blocks commit if violations found (strict enforcement)
- WIP commits (`wip:` prefix) skip review for developer flow
- Emergency bypass available via `--no-verify`

**Timing:** 30-120 seconds depending on code size

#### 2. Manual Review (Interactive & Headless)

**Status:** ✅ Implemented

Developers can manually trigger reviews at any time:

```bash
# Interactive mode (within Claude Code session)
/review-code-spec worker/mech_worker.ts
/review-code-spec --diff
/review-code-spec worker/

# Headless mode (anywhere, via scripts)
yarn lint:spec              # Review staged changes
yarn lint:spec:all          # Review all worker files
./codespec/scripts/detect-violations.sh worker/file.ts
```

**Use cases:**
- Pre-commit validation before staging
- Exploratory review during refactoring
- Batch review of existing code

#### 3. Deliberative Alignment

**Concept:** Claude Code "deliberates" on the spec before generating code.

**How it works:**
1. Developer requests code changes
2. Claude reads `spec.md` and `examples/` files
3. Claude reasons about how to satisfy both the request and the spec
4. Claude generates code that follows canonical patterns by default

**Implementation:** The `/review-code-spec` slash command embeds this concept by requiring Claude to read the spec files before analyzing code.

**Inspiration:** OpenAI's Model Spec uses a similar approach where the model reasons about its specification before responding to user queries.

### Enforcement Philosophy

**Strict but flexible:**
- Default: Block violations before they enter the codebase
- Escape hatches: WIP commits, `--no-verify` for legitimate exceptions
- Transparency: Clear messaging about violations and how to fix them

**Educational, not punitive:**
- Violations include suggested fixes with exact code
- Pattern references explain the "why"
- Exceptions are documented, not hidden

---

## Example Files

Below are the complete example files demonstrating each objective:

---

## Objective 1: Orthodoxy - One Obvious Way

### Context

This objective ensures consistency across an AI-generated codebase where different prompts or sessions might produce different solutions to the same problem.

### Test Cases

#### Case 1: Multiple approaches to error handling

##### Violates Objective

```typescript
// File A: Uses .catch() with console.log
fetch(url).catch(err => console.log(err));

// File B: Uses try/catch with console.error
try {
  await fetch(url);
} catch (e) {
  console.error('Failed:', e);
}

// File C: Uses try/catch with logger but unstructured
try {
  await fetch(url);
} catch (e) {
  workerLogger.error(e);
}

// File D: Uses try/catch with logger and structured context
try {
  await fetch(url);
} catch (error) {
  workerLogger.error('Fetch failed', { url, error });
}
```

**Problem:** Four different approaches to handling fetch errors. This violates the orthodoxy objective because there is no single obvious way.

**Impact:**
- New developers (human or AI) must learn all four approaches
- Code review becomes subjective ("which style is acceptable?")
- Debugging is harder (logs have different formats)
- Observability is inconsistent

##### Follows Objective

```typescript
// All files use the same canonical approach
try {
  await fetch(url);
} catch (error) {
  workerLogger.error('Fetch failed', {
    url,
    error: error instanceof Error ? error.message : String(error)
  });
  throw error;
}
```

**Why this follows the objective:**
- One obvious way consistently applied across the entire codebase
- Predictable: developers know what to expect
- Learnable: AI agents can follow the pattern
- Maintainable: changes to error handling happen in one place (the pattern)

#### Case 2: Multiple property access patterns

##### Violates Objective

```typescript
// Different files accessing tool call data differently
const input1 = call.input;
const input2 = call.arguments;
const input3 = call.args;
const input4 = call.result;
const input5 = call.input || call.arguments || call.args || call.result;
```

**Problem:** Five different ways to access the same conceptual data. No canonical structure.

##### Follows Objective

```typescript
// Normalize at the boundary
function normalizeToolCall(call: any): { input: any } {
  return {
    input: call.input || call.arguments || call.args || call.result
  };
}

// All code uses the normalized structure
const normalized = normalizeToolCall(call);
const input = normalized.input; // Only one way to access
```

**Why this follows the objective:**
- Inconsistent external data is normalized once at the boundary
- Internal code has one obvious way to access the data
- Future changes to normalization logic happen in one place

### Application

When you encounter code that violates this objective:

1. **Identify the problem domain** - What are these approaches trying to solve?
2. **Choose the canonical approach** - Which one is best for observability, maintainability, consistency?
3. **Document as a default behavior** - Add it to spec.md
4. **Create examples** - Show correct and incorrect usage
5. **Migrate existing code** - Update all instances to follow the canonical approach
6. **Enforce going forward** - Code review catches violations

---

## Objective 2: Code for the Next Agent

This example demonstrates the "Code for the next agent" objective.

### Correct: Explicit and Discoverable

```typescript
// Configuration access - explicit name and validation
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return url;
}

// Clear intent, AI can grep for "getDatabaseUrl" to find all database config access
const dbUrl = getDatabaseUrl();
```

**Why this works:**
- **Explicit:** Function name clearly states what it does
- **Discoverable:** `grep "getDatabaseUrl"` finds all database URL usage
- **Self-documenting:** Error message explains the requirement
- **Predictable:** Future AI sessions will use the same function

### Violation: Implicit and Hidden

```typescript
// Magic global from initialization file (requires reading another file to understand)
const db = g.db;

// Implicit environment variable access (which var? what happens if missing?)
const url = process.env.DB || process.env.DATABASE_URL || process.env.DB_CONN;

// Clever but unclear
const cfg = (() => {
  const e = process.env;
  return { u: e.U, p: e.P, h: e.H };
})();
```

**Why this violates:**
- **Implicit:** `g.db` requires knowing what `g` is and how it was initialized
- **Hidden:** Multiple env var fallbacks make it unclear which to set
- **Non-discoverable:** Abbreviated names (`u`, `p`, `h`) are not greppable
- **Clever:** IIFE is concise but requires understanding the pattern

### Key Insight

AI agents read code through:
1. **Search/grep** - Finding patterns by text matching
2. **Type inference** - Understanding through explicit types
3. **Naming** - Comprehending intent from descriptive names
4. **Locality** - Reading nearby code, not distant files

Write code that succeeds on all four axes.

---

## Objective 3: Minimize Harm

This example demonstrates the "Minimize harm" objective through security, safety, and privacy best practices.

### Correct: Secure by Default

#### Input Validation

```typescript
import { z } from 'zod';

const UserInputSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
});

export async function createUser(rawInput: unknown) {
  // Validate and sanitize all external input
  const parsed = UserInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new Error(`Invalid user input: ${parsed.error.message}`);
  }

  const { email, age, username } = parsed.data;

  // Use parameterized queries to prevent SQL injection
  await db.query(
    'INSERT INTO users (email, age, username) VALUES ($1, $2, $3)',
    [email, age, username]
  );
}
```

#### Secret Management

```typescript
// Secrets from environment variables, never hardcoded
const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY environment variable is required');
}

// API key never logged or exposed
logger.info('API request initiated', { endpoint: '/users' });
// NOT: logger.info('API request', { apiKey });
```

#### Fail Securely

```typescript
export async function checkAccess(userId: string, resourceId: string): Promise<boolean> {
  try {
    const permission = await db.query(
      'SELECT * FROM permissions WHERE user_id = $1 AND resource_id = $2',
      [userId, resourceId]
    );

    // Explicit check - only return true if permission exists
    return permission.rows.length > 0;
  } catch (error) {
    // Fail closed: On error, deny access (secure default)
    logger.error('Permission check failed', { userId, resourceId, error });
    return false; // Deny by default
  }
}
```

### Violation: Insecure Patterns

#### No Input Validation

```typescript
export async function createUser(input: any) {
  // Direct use of untrusted input - SQL injection risk
  await db.query(
    `INSERT INTO users (email, age, username) VALUES ('${input.email}', ${input.age}, '${input.username}')`
  );
  // Malicious input: { email: "'; DROP TABLE users; --", ... }
}
```

#### Hardcoded Secrets

```typescript
// API key committed to repository
const API_KEY = 'sk-abc123xyz789';

// Secrets in comments (still searchable in git history)
// Production API key: sk-prod-real-key-here
```

#### Fail Open

```typescript
export async function checkAccess(userId: string, resourceId: string): Promise<boolean> {
  try {
    const permission = await db.query(/* ... */);
    return permission.rows.length > 0;
  } catch (error) {
    // On error, grant access (insecure default)
    logger.warn('Permission check failed, granting access anyway', error);
    return true; // Grant by default
  }
}
```

#### Excessive Logging

```typescript
// Logs sensitive data
logger.info('User login', {
  username: user.username,
  password: user.password, // Never log passwords
  ssn: user.ssn,           // Never log PII
  creditCard: user.cc,     // Never log payment info
});
```

### Key Security Principles

#### 1. Validate All External Input
- API request bodies
- Query parameters
- File uploads
- Environment variables (when from untrusted sources)
- Database query results (when from user-controlled data)

#### 2. Never Commit Secrets
- API keys, tokens, passwords
- Private keys, certificates
- Database credentials
- Any sensitive configuration

#### 3. Fail Closed, Not Open
- On auth failure → deny access
- On validation error → reject input
- On permission check error → deny permission

#### 4. Principle of Least Privilege
- Database connections use read-only users when possible
- API tokens scoped to minimum necessary permissions
- File system access restricted to required directories

#### 5. Defense in Depth
- Multiple layers of validation
- Parameterized queries even with validated input
- Rate limiting + input validation + authentication

### Application to AI Code Generation

When AI generates code:
1. **Default to secure patterns:** Use parameterized queries, not string concatenation
2. **Require explicit validation:** Never trust external input
3. **Reject insecure examples:** Don't learn from code with hardcoded secrets
4. **Question convenience:** If it's easier but less secure, choose secure

The "Minimize harm" objective prevents AI from propagating security anti-patterns across sessions.

---

## Relationship to OpenAI Model Spec

This code spec is directly inspired by OpenAI's Model Spec and the concept of "deliberative alignment."

| OpenAI Model Spec | Our Code Spec |
|-------------------|---------------|
| Defines desired model behavior | Defines desired code patterns |
| Objectives: "Assist users" | Objectives: "Follow orthodoxy" |
| Rules: "Comply with laws" | Rules: (Future) |
| Default Behaviors: "Express uncertainty" | Default Behaviors: (Future) |
| Examples: 114 test case files | Examples: Test cases per clause |
| Enforcement: Grader model + RLHF | Enforcement: Claude review + git hooks |
| Evolution: Public feedback | Evolution: Developer discovery |

**Key insight from Sean's talk:**
> "Code is a lossy projection of a spec. The spec is the source of truth."

For an AI-generated codebase:
- The prompts were the true source code
- The generated code is the binary artifact
- The spec preserves intent across AI sessions

---

## References

- [OpenAI Model Spec](https://github.com/openai/model_spec)
- [OpenAI: Shaping Desired Model Behavior](https://openai.com/index/introducing-the-model-spec/)
- [PEP 20 - The Zen of Python](https://peps.python.org/pep-0020/)
- [OpenAI: Deliberative Alignment](https://openai.com/index/deliberative-alignment/)
