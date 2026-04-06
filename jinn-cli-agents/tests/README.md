# Jinn Test Suites

## Overview

This directory contains E2E test suites for the Jinn agent system, covering marketplace operations, worker functionality, and service deployment.

## Test Suites

- **`marketplace/`** - Tests for MCP tool dispatch, IPFS integration, Ponder indexing, context propagation, and lineage tracking
- **`worker/`** - Tests for worker execution flow, artifact creation, and work protocol
- **`service-deployment/`** - Tests for service deployment workflows

## Running Tests

### Sequential Execution (Traditional)

```bash
# Run individual suites
yarn test:marketplace
yarn test:worker
yarn test:service

# Run all suites sequentially
yarn test:all
```

### Parallel Execution (Recommended)

```bash
# Run marketplace and worker suites in parallel
yarn test:parallel
```

**Benefits:**
- ⚡ **Faster CI/CD:** Reduces total test time by ~50%
- 🔒 **Full Isolation:** Each suite uses independent resources (ports, databases, VNets)
- 🎯 **No Conflicts:** Automatic port allocation prevents collisions

## Test Isolation Architecture

Each test suite runs in complete isolation:

### Per-Suite Resources

| Resource | Marketplace Example | Worker Example |
|----------|-------------------|----------------|
| **Suite ID** | `test-1761145770461-12094` | `test-1761145770461-12095` |
| **Ponder Port** | `42070` | `42071` |
| **Control API Port** | `4059` | `4058` |
| **SQLite Cache** | `.ponder-test-*-12094` | `.ponder-test-*-12095` |
| **Virtual TestNet** | Unique VNet ID | Unique VNet ID |
| **Ponder Process** | Independent PID | Independent PID |

### Isolation Mechanisms

1. **Suite-Specific Cache Directories**
   - Each suite uses `.ponder-${SUITE_ID}/` for its SQLite database
   - Prevents database lock conflicts
   - Auto-cleaned after test completion

2. **Dynamic Port Allocation**
   - Ponder ports: `42070 + offset` (offset from timestamp + PID)
   - Control API ports: `4001 + offset`
   - Automatic collision avoidance

3. **Independent Virtual TestNets**
   - Each suite creates its own Tenderly Virtual TestNet
   - Isolated blockchain state per suite
   - Auto-deleted after test completion

4. **Process Tracking**
   - Suite-specific process IDs
   - No global `pkill` commands
   - Clean teardown per suite

## Troubleshooting

### Tests Fail When Run in Parallel

If you see port conflicts or database locks:
1. Check that you're using the latest setup code with suite-specific isolation
2. Verify `findAvailablePort()` is working correctly
3. Check for leftover `.ponder-test-*` directories: `rm -rf .ponder-test-*`

### Flaky Tests Under Load

Some tests may occasionally timeout when running in parallel due to resource contention. This is expected behavior and not an isolation issue. Re-run the tests to confirm.

### Port Already in Use

If you see `EADDRINUSE` errors:
- The port allocation logic should automatically find the next available port
- Check for leaked processes: `ps aux | grep ponder`
- Kill leaked processes: `pkill -f 'ponder.*dev'` (only in development)

## Architecture Details

### Test Setup Flow

1. **Initialize Suite** (`setup.ts`)
   - Generate unique `SUITE_ID` (timestamp + PID)
   - Create Virtual TestNet on Tenderly
   - Fund test wallet

2. **Allocate Ports**
   - Find available Ponder port with collision avoidance
   - Find available Control API port
   - Set environment variables

3. **Create Isolated Cache**
   - Create suite-specific `.ponder-${SUITE_ID}` directory
   - Configure Ponder to use custom database directory
   - Clean any existing cache

4. **Start Services**
   - Spawn Ponder process with custom port and cache
   - Start Control API with custom port
   - Connect MCP client

### Teardown Flow

1. Stop Ponder process (suite-specific PID)
2. Disconnect MCP client
3. Stop Control API process (suite-specific PID)
4. Delete Virtual TestNet
5. Clean suite-specific cache directory

## Contributing

When adding new tests:
- Use the existing setup helpers in `tests/helpers/`
- Tests automatically inherit isolation from global setup
- No special configuration needed for parallel execution
- Follow existing test patterns for consistency

## See Also

- [Phase Implementation Summary](../docs/parallel-test-implementation.md) (if created)
- [Ponder Configuration](../ponder/ponder.config.ts)
- [Test Helpers](./helpers/)
