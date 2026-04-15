# tests-next Integration Suites

Integration tests exercise boundary modules (MCP tools, control API client, Tenderly client, etc.) using the shared env controller without spinning up the full worker stack.

## Real-time SSE Tests

The real-time SSE tests in `realtime-updates.test.ts` run conditionally:

- **Without `REALTIME_URL`**: Tests are skipped (default - no local server needed)
- **With `REALTIME_URL`**: Tests execute against the live endpoint

### Running Against Live Railway Endpoint

```bash
# Test against your Railway deployment
REALTIME_URL=https://your-app.railway.app/sql/live yarn test:integration:next

# Or add to .env.test:
REALTIME_URL=https://your-app.railway.app/sql/live
```

This allows testing the real-time functionality without requiring local infrastructure while keeping tests passing in CI.
