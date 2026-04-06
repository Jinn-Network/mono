---
title: Code Spec
purpose: guide
scope: [worker, gemini-agent, frontend, codespec]
last_verified: 2026-01-30
related_code:
  - codespec/blueprints/
  - codespec/scripts/review.sh
keywords: [code spec, coding standards, patterns, orthodoxy, discoverability, security]
when_to_read: "When understanding codebase conventions or checking code against standards"
---

# Code Spec

> **Generated from:** `codespec/blueprints/*.json`
> 
> This document is auto-generated. Edit the JSON blueprints, not this file.

## Overview

This specification defines desired code patterns for an AI-generated codebase. It ensures consistency across multiple AI sessions and makes the codebase maintainable by both humans and future AI agents.

**Philosophy:** In an AI-generated codebase, different prompts naturally produce different solutions to the same problem. Without explicit guidance, patterns drift and the codebase becomes inconsistent. This spec provides that guidance.

## How to Read This Spec

This specification is organized into three tiers:

1. **Objectives** - High-level goals and guiding philosophies
2. **Rules** - Hard constraints that must never be violated
3. **Default Behaviors** - Standard patterns for common operations

---

## Objectives

Objectives are high-level goals that provide directional guidance for all code. They inform the rules and default behaviors.

### Orthodoxy

> There should be one--and preferably only one--obvious way to do it. (PEP 20, The Zen of Python)

**The principle:** For any given problem domain in this codebase, there is one canonical approach, and all code follows it

**Why this matters:**
Different prompts produce different solutions. Different AI models use different idioms. Different sessions cause stylistic drift. Result: the codebase becomes unlearnable.

**How to assess:**
Check if the same problem is solved in multiple different ways across the codebase. Look for: different error handling patterns, different property access patterns, different logging styles, different configuration access methods.

**Examples:**

✅ **Do:**
- Use the same canonical error handling pattern across all files: try/catch with structured logger.error and re-throw
- Normalize inconsistent external data once at the boundary, then use consistent accessors internally
- When encountering multiple approaches, identify the canonical one, document as default behavior, migrate all code

❌ **Don't:**
- File A uses .catch() with console.log, File B uses try/catch with console.error, File C uses logger.error
- Access the same data as call.input, call.arguments, call.args, or call.result in different files
- Invent a new pattern when an existing canonical one exists

**Enforced by:** DB-CONFIG, DB-HTTP, DB-LOGGING, DB-ERROR-HANDLING

### Discoverability

> Explicit is better than implicit. (PEP 20, The Zen of Python)

**The principle:** All code is optimized for machine discoverability, readability, and comprehension by the next AI agent

**Why this matters:**
AI agents are the primary developers. They learn by reading code, navigate by pattern matching and search. Implicit behavior, clever tricks, and hidden context confuse AI. The ratio of code-reading to code-writing is extreme.

**How to assess:**
Check if code requires human intuition, domain knowledge not in the codebase, or clever inference to understand. Look for: magic globals, implicit fallback chains, abbreviated non-greppable names, clever IIFE patterns.

**Examples:**

✅ **Do:**
- Use explicit named getters like getDatabaseUrl() that throw if missing - clear intent, greppable, self-documenting
- Make intentions clear through naming, types, and structure
- Prefer throwing errors over silent fallbacks - fail fast, fail explicitly

❌ **Don't:**
- Use magic globals from initialization files (g.db requires knowing what g is)
- Use multiple env var fallbacks (process.env.DB || process.env.DATABASE_URL || process.env.DB_CONN)
- Use abbreviated names (u, p, h) that aren't greppable

**Enforced by:** DB-CONFIG, DB-LOGGING

### Security

> First, do no harm. (Adapted from the Hippocratic Oath)

**The principle:** Code does not introduce security vulnerabilities and follows secure-by-default patterns

**Why this matters:**
AI agents may not understand all security implications. They learn from examples that might include insecure patterns. Security vulnerabilities compound across AI sessions. A single compromised secret or SQL injection can cascade through the system.

**How to assess:**
Ask: Could this be exploited? Could this leak data? Could this cause damage? Check for: unvalidated inputs, hardcoded secrets, fail-open patterns, excessive logging of sensitive data.

**Examples:**

✅ **Do:**
- Validate all external input with schemas (Zod) before use
- Read secrets from environment variables, never hardcode
- Fail closed: on auth/permission error, deny access (return false)
- Use parameterized queries to prevent SQL injection
- Grant minimum necessary permissions (principle of least privilege)

❌ **Don't:**
- Use string concatenation for SQL queries (SQL injection risk)
- Hardcode API keys or include secrets in comments
- Fail open: grant access when permission check fails
- Log passwords, SSNs, credit cards, or other PII

**Enforced by:** RULE-NO-SECRETS, RULE-AUTO-GUARD, RULE-PREFLIGHT, RULE-NO-SILENT-CATCH

---

## Rules

Rules are hard constraints that must never be violated. Unlike objectives (which are directional) and default behaviors (which can have rare exceptions), rules are absolute.

### No Secrets

**The rule:** No secrets (private keys, API keys, passwords, tokens) exist in git history or staged files

**Why this matters:**
Secrets in git history are permanently exposed. A single leaked agent key can drain all funds from its Safe. Git history is immutable--deletion doesn't remove committed secrets. Even private repos expose keys to all collaborators.

**How to assess:**
Scan staged files and git history for patterns matching secrets. Check: .operate/, wallet exports, *private_key* patterns, hardcoded hex strings (0x + 64 chars), API key patterns (sk-, eyJ), .env files.

**Examples:**

✅ **Do:**
- Read secrets from environment variables at runtime: const apiKey = process.env.API_KEY
- Use .env.example with placeholder values for documentation
- Throw Error if required secret env var is missing
- Log only public addresses, never private keys
- Add .env, *_private_key.txt, .operate/wallets/, .operate/keys/ to .gitignore

❌ **Don't:**
- Hardcode private keys: const AGENT_PRIVATE_KEY = '0x1234...'
- Include secrets in comments: // Test key: 0xabcd...
- Commit .env files with real credentials
- Log secrets: logger.info({ privateKey: agentKey })
- Include API keys in error messages: throw new Error(`Failed with key ${API_KEY}`)

### Auto Guard

**The rule:** Every automated git workflow (workers, bots, CI, test harnesses) invokes the canonical secret guard before staging, committing, or pushing code

**Why this matters:**
Automation is trusted to keep history clean. If the guard is skipped, leaked credentials become permanent. AI agents reuse commit helpers--one insecure path propagates everywhere. Preventing at source is cheaper than rotating wallets.

**How to assess:**
Check all code paths that run git commit or git push. Verify gitGuard.ensureSafeStagedTree() is called immediately before. Guard must block .operate/, .operate-test/, *private_key* files.

**Examples:**

✅ **Do:**
- Call gitGuard.ensureSafeStagedTree() immediately before git.commit()
- Propagate guard errors to abort workflow with context
- Update shared denylist when new secret patterns emerge

❌ **Don't:**
- Run git.commit() and git.push() without calling the guard first
- Maintain private overrides of the denylist
- Catch and suppress guard violations

### Preflight

**The rule:** Before any transaction that transfers tokens, executes a Safe transaction, or modifies on-chain state, current on-chain state is verified via view/pure functions

**Why this matters:**
Blockchain transactions are immutable and irreversible. Failed transactions waste gas fees (non-recoverable). Invalid operations can lock funds in contracts. Network delays make local state stale.

**How to assess:**
Check all blockchain transaction code. Look for: mech deliveries without checking isUndelivered, token transfers without balance checks, staking without state validation, Safe transactions without configuration checks.

**Examples:**

✅ **Do:**
- Mech delivery: call isUndeliveredOnChain() before deliverViaSafe()
- Token transfer: check balanceOf() before transfer()
- Staking: verify isServiceStaked() and service state before stake()
- Safe tx: validate threshold <= owners.length, signer is owner
- If RPC unavailable: log warning and allow operation (best-effort)

❌ **Don't:**
- Call deliverViaSafe() without checking if already delivered
- Transfer tokens without verifying sender balance
- Execute Safe transaction without validating configuration
- Stake service without checking eligibility

### No Silent Catch

**The rule:** Errors in financial operations, blockchain transactions, or on-chain job processing are logged with full context and propagated to caller. No empty catch blocks or silent fallbacks.

**Why this matters:**
Silent failures hide critical issues (lost funds, stuck jobs). Debugging is impossible without error logs. AI may generate convenient but unsafe patterns. Incident response requires clear audit trails.

**How to assess:**
Scan for: empty catch {} blocks, .catch(() => null) patterns, .catch(() => false) without logging, returning default values on error without logging. Applies to: token transfers, Safe transactions, RPC calls, IPFS uploads, database writes for on-chain tracking.

**Examples:**

✅ **Do:**
- Log errors with structured context: logger.error('Delivery failed', { requestId, error: serializeError(e) })
- Re-throw errors after logging in critical paths
- Update job status to FAILED on delivery error to prevent stuck IN_PROGRESS
- Non-critical background tasks (telemetry) may degrade gracefully with warning logs

❌ **Don't:**
- Use empty catch blocks: try { ... } catch {}
- Use silent fallbacks: .catch(() => null) or .catch(() => false)
- Return default values on error without logging the cause
- Swallow errors in Promise chains

---

## Default Behaviors

Default behaviors define the standard way to handle common operations. They are consistent with objectives and rules. In rare cases, deviations may be justified (e.g., third-party library constraints), but must be explicitly documented.

### Config

**Behavior:** All runtime code reads configuration through the centralized config module via explicit getters. No direct process.env access in runtime code.

**Why this matters:**
Orthodoxy: one obvious way to access config. Discoverability: named getters are searchable, validation errors explain what's missing. Security: schema validation catches missing secrets before deployment.

**How to assess:**
Check for process.env.* usage outside config/index.ts. All env vars should be accessed via exported helpers like getRequiredRpcUrl(), getSupabaseUrl().

**Examples:**

✅ **Do:**
- const rpcUrl = getRequiredRpcUrl();
- Extend config/index.ts schema when adding new env vars
- Use RUNTIME_ENVIRONMENT flag (default, test, review) for runtime overrides

❌ **Don't:**
- const rpcUrl = process.env.RPC_URL || process.env.MECHX_CHAIN_RPC;
- Access process.env directly in runtime code
- Introduce new env vars without adding to centralized config

**Allowed exceptions:**
- One-off scripts or tests may read process.env if documented and not introducing canonical patterns
- Transitional compatibility layers inside config module

### Temp Secrets

**Behavior:** Tests, fixtures, and local tooling write generated wallets or secrets only to the canonical temp secret workspace (outside git worktrees) and clean up afterward

**Why this matters:**
Automation that stages 'everything' cannot accidentally pick up secret fixtures. IDEs and commit UIs never surface sensitive files inside tracked trees.

**How to assess:**
Check for .operate-test/ or similar secret directories created beneath tracked repositories. All ephemeral secrets should go to OS temp directory.

**Examples:**

✅ **Do:**
- Use mkdtempSync(join(tmpdir(), 'jinn-operate-test-')) to create temp workspace
- Inject absolute path via OPERATE_HOME environment variable
- Clean up secrets after test completes

❌ **Don't:**
- Use join(process.cwd(), '.operate-test') which creates secrets in git worktree
- Derive secret paths from process.cwd()
- Leave test secrets behind after tests complete

### Http

**Behavior:** All runtime HTTP calls use the shared client module with timeouts, structured errors, and retry/backoff. No direct fetch() calls.

**Why this matters:**
Orthodoxy: one pattern for HTTP keeps formatting, logging, and error handling consistent. Discoverability: named helpers are searchable. Security: timeouts prevent hangs, retries smooth failures, centralized logging prevents secret leaks.

**How to assess:**
Check for direct fetch() calls in runtime code. All HTTP should use postJson, getJson, graphQLRequest from http/client.ts.

**Examples:**

✅ **Do:**
- const data = await graphQLRequest<Response>({ query, variables, context: { requestId } });
- Extend http/client.ts for new behavior (streaming) so protections apply
- Use helper options: requestId, headers, timeoutMs, retries

❌ **Don't:**
- const res = await fetch(url, { method: 'POST', body }); // no timeout
- Implement custom retry logic outside the shared client
- Call fetch directly in runtime code

**Allowed exceptions:**
- Browser-only code with equivalent safeguards
- Unit tests in controlled environments with documented deviation
- One-off scripts with documented reason

### Staged Guard

**Behavior:** Auto-commit or auto-push helpers call the canonical staged-tree validator immediately before committing, enforcing the shared denylist

**Why this matters:**
Auto-commit paths bypass human review--the guard is the only defense. Centralized checks keep denylist synchronized. Failures clearly identify offending paths.

**How to assess:**
Check all auto-commit/push paths. Verify gitGuard.ensureSafeStagedTree() is called after staging and before committing.

**Examples:**

✅ **Do:**
- await git.add({ all: true }); await gitGuard.ensureSafeStagedTree(); await git.commit({ message });
- Propagate guard errors to abort workflow with context
- Update shared denylist when new patterns emerge

❌ **Don't:**
- await git.add({ all: true }); await git.commit({ message }); // no guard
- Catch and suppress guard violations
- Maintain private denylist overrides

### Logging

**Behavior:** All runtime code logs through the shared Pino logger. Components create child loggers with component tags and use structured metadata. No console.* in production code.

**Why this matters:**
Orthodoxy: one logging pipeline keeps formatting and routing consistent. Discoverability: structured fields (requestId, jobId) make logs searchable. Security: centralized logging prevents accidental secret leakage.

**How to assess:**
Check for console.log/warn/error in runtime code. All logging should use logger from logging/index.ts with child loggers per component.

**Examples:**

✅ **Do:**
- const workerLogger = logger.child({ component: 'WORKER' });
- workerLogger.info({ requestId, status }, 'Delivering job');
- Keep sensitive values out of log fields

❌ **Don't:**
- console.error('Safe delivery failed', err);
- Log concatenated strings instead of structured objects
- Include private keys or tokens in log fields

**Allowed exceptions:**
- Tests asserting specific console output
- Browser-facing code with devtools logging not reaching production
- CLI tools using scriptLogger adapter

### Error Handling

**Behavior:** Every catch block surfaces the error. Optional flows log warning with context; critical flows log and rethrow. No empty catch blocks or error-suppressing .catch() patterns.

**Why this matters:**
Orthodoxy: single discoverable error-handling idiom. Discoverability: logs provide breadcrumbs for future agents. Security: prevents silent data loss or hidden failures.

**How to assess:**
Scan for empty catch {} blocks, .catch(() => ...) without logging. Every catch must log or rethrow.

**Examples:**

✅ **Do:**
- catch (error) { workerLogger.error({ requestId, error: serializeError(error) }, 'Failed'); throw error; }
- Non-critical paths: log at warn level and continue
- Use serializeError() for readable error details without leaking secrets

❌ **Don't:**
- catch {} // empty
- .catch(() => null) // suppresses without logging
- return null; // in catch without logging cause

**Allowed exceptions:**
- Test helpers deliberately swallowing errors during cleanup (documented)
- Inline parse guards with explicit fallback: try { JSON.parse(...) } catch { return null; } (tolerated if documented)

---

## References

- [OpenAI Model Spec](https://github.com/openai/model_spec)
- [PEP 20 - The Zen of Python](https://peps.python.org/pep-0020/)
- Blueprint source: `codespec/blueprints/`
