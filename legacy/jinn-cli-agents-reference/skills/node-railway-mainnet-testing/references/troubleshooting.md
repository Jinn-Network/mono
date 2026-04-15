# Troubleshooting

## Deploy assertions fail with missing repo/branch metadata
- Cause: service was deployed via Docker/context redeploy without VCS source metadata.
- Action: relink service source to expected external repo branch and redeploy, then rerun pre-smoke.

## Baseline dispatch does not deliver
- Verify canary worker is healthy in Railway service status.
- Verify `WORKSTREAM_FILTER` matches the dispatched workstream.
- Verify worker logs include `Claimed via Control API` and `Delivered via Safe`.

## Credential matrix fails at admin endpoints
- Verify `ADMIN_ADDRESSES` includes the admin signer address.
- Verify gateway has `CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY` or `PRIVATE_KEY` available.
- Verify ERC-8128 request signing chain id is Base mainnet (`8453`).

## Venture-scoped capability checks fail unexpectedly
- Ensure request sender address maps to an active venture owner address.
- Confirm temporary venture creation succeeded using Supabase service-role credentials.
- Confirm `/credentials/capabilities` is called with `requestId` body.

## Filtering checks are flaky
- Use a dedicated canary workstream so no unrelated workers can claim requests.
- Increase dispatch timeout for congested periods.

## Secret leak gate fails
- Search log lines for keys/tokens and remove direct value logging.
- If `SERVICE-CONFIG-READER` logs include `agentPrivateKey`, ensure service config logs are emitted through `redactServiceInfoForLog` in `/Users/adrianobradley/jinn-gemini-2/jinn-node/src/worker/ServiceConfigReader.ts`.
- Re-run pre-smoke only after leakage source is fixed.
