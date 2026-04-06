---
name: DevOps workflow and Railway config
overview: "Disable GitHub test workflows by setting on: workflow_dispatch (manual-only trigger), and add watchPatterns to railway.toml to only trigger Ponder deployments when files in the ponder/ directory change."
todos:
  - id: disable-security-workflow
    content: Disable security.yml workflow (change triggers to workflow_dispatch)
    status: completed
  - id: disable-tests-workflow
    content: Disable tests-next.yml workflow (change triggers to workflow_dispatch)
    status: completed
  - id: add-watch-patterns
    content: Add watchPatterns = ["ponder/**"] to railway.toml build section
    status: completed
---

# DevOps: Disable Workflows and Configure Ponder Watch Patterns

## 1. Disable GitHub Workflows

Both workflows in `.github/workflows/` will be changed to manual-only triggers using `workflow_dispatch`. This preserves the workflow definitions while preventing automatic runs.

**Files to modify:**

- `.github/workflows/security.yml`
- `.github/workflows/tests-next.yml`

**Change:** Replace the existing `on:` triggers with:

```yaml
on:
  workflow_dispatch:
    # Disabled: automated runs are broken
    # Original triggers preserved below for restoration:
    # push: branches: [main, develop]
    # pull_request: branches: [main, develop]
```

## 2. Add Watch Patterns for Ponder Deployments

Add `watchPatterns` to `railway.toml` so builds only trigger when files in the `ponder/` directory change.

**File:** `railway.toml`

**Current content:**

```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "cd ponder && ponder start --port $PORT --schema $RAILWAY_DEPLOYMENT_ID --views-schema jinn_gemini_public"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

**Updated `[build]` section:**

```toml
[build]
builder = "NIXPACKS"
buildCommand = "yarn run build && cd ponder && yarn install"
watchPatterns = ["/ponder/**"]
```

Notes:

- `buildCommand` mirrors what's already in the Railway UI (good to have in version control)
- `watchPatterns` uses `/ponder/**` (leading slash matches from repo root, per gitignore-style patterns)
- Only changes under `ponder/` will trigger Railway deployments