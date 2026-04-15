# Tests Next CI Setup

This document describes the GitHub Actions workflow for the `tests-next` test suite.

## Workflow Overview

The [tests-next.yml](./tests-next.yml) workflow runs three types of tests:

### 1. Unit Tests ✅
- **Always runs** on all PRs and pushes
- Fast execution (~seconds to minutes)
- No external dependencies required
- Command: `yarn test:unit:next`

### 2. Integration Tests ✅
- **Always runs** on all PRs and pushes
- Moderate execution time (~minutes)
- Uses mocked infrastructure
- Command: `yarn test:integration:next`

### 3. System Tests 🔐
- **Conditionally runs** only when secrets are available:
  - ✅ On pushes to `main` or `develop` branches
  - ✅ On PRs from the same repository (not forks)
  - ❌ On PRs from forked repositories (secrets not available)
- Long execution time (~10-20 minutes)
- Requires external services (Tenderly VNet, Supabase)
- Command: `yarn test:system:next`

## Required GitHub Secrets

To enable system tests, configure these secrets in your repository settings (`Settings > Secrets and variables > Actions > New repository secret`):

### Tenderly Configuration
System tests create temporary virtual networks (VNets) for blockchain testing:

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `TENDERLY_ACCESS_KEY` | Tenderly API access key | `abc123...` |
| `TENDERLY_ACCOUNT_SLUG` | Your Tenderly account name | `my-account` |
| `TENDERLY_PROJECT_SLUG` | Your Tenderly project name | `jinn-tests` |

**How to get these:**
1. Log in to [Tenderly](https://dashboard.tenderly.co/)
2. Go to Settings → Access Tokens → Generate Access Token
3. Copy your account slug from the URL: `https://dashboard.tenderly.co/{account-slug}/...`
4. Create a project for tests or use an existing one

### Test Repository
System tests need a dedicated Git repository for testing git lineage and metadata features:

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `TEST_GITHUB_REPO` | Git repository URL for test isolation | `git@github.com:your-org/jinn-test-repo.git` |

**Setup:**
1. Create a new GitHub repository (e.g., `jinn-test-repo`)
2. This repository will be used for:
   - Creating test branches (e.g., `job/*`)
   - Testing PR creation
   - Testing git lineage propagation
3. The workflow uses the built-in `GITHUB_TOKEN` for authentication

### Supabase Database
System tests require a Postgres database for storing embeddings and test data:

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `SUPABASE_POSTGRES_URL` | Supabase Postgres connection string | `postgresql://user:pass@host.supabase.co:5432/postgres` |

**How to get this:**
1. Create a [Supabase](https://supabase.com/) project (free tier works)
2. Go to Project Settings → Database
3. Copy the "Connection string" (URI format)
4. **Important:** Use a test database, not production!

## Workflow Features

### Automatic Cleanup
- Tenderly VNets are automatically cleaned up after tests complete
- Cleanup runs even if tests fail (using `if: always()`)

### Artifact Upload
- Test logs and results are uploaded on failure
- Ponder database is uploaded for debugging system test failures
- Artifacts retained for 7 days (3 days for Ponder DB)

### Concurrency Control
- In-progress runs are cancelled when new commits are pushed
- Prevents wasted CI resources

### Test Summary
- A summary job reports the status of all test types
- Shows ✅/❌/⏭️ status for each test tier
- Added to GitHub Actions summary view

## Running Tests Locally

You can run the same tests locally:

```bash
# Unit tests (fast)
yarn test:unit:next

# Integration tests
yarn test:integration:next

# System tests (requires .env.test configured)
yarn test:system:next

# All tests
yarn test:next
```

For system tests, copy `.env.test.template` to `.env.test` and fill in the required values.

## Troubleshooting

### System tests are skipped on my PR
- This is expected for PRs from forked repositories (security measure)
- System tests will run once the PR is merged or if you push to a branch in the main repository

### System tests timeout
- System tests have a 20-minute timeout
- If tests consistently timeout, check:
  - Tenderly VNet creation is successful
  - Supabase database is accessible
  - Network connectivity to external services

### Tenderly cleanup fails
- This is usually harmless and won't fail the workflow
- VNets may have already been deleted or expired
- Manual cleanup: `yarn cleanup:tenderly`

## CI Optimization

The workflow uses several optimization techniques:

- **Parallel execution**: Unit, integration, and system tests run simultaneously
- **Dependency caching**: Yarn cache is reused between runs
- **Conditional execution**: System tests only run when secrets are available
- **Concurrency limits**: Duplicate runs are cancelled automatically

## Future Enhancements

Consider adding:
- [ ] Test coverage reporting (e.g., Codecov)
- [ ] Performance benchmarking
- [ ] Snapshot testing for regression detection
- [ ] Matrix testing across multiple Node.js versions
- [ ] Scheduled runs for long-running stress tests
