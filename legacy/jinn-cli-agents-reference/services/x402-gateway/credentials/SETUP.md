# Credential Bridge: Local E2E Setup

## 1. Start Nango

```bash
cd services/x402-gateway/credentials
docker compose -f docker-compose.nango.yml up -d
```

Nango dashboard: http://localhost:3003 (admin/admin)

## 2. Configure Twitter OAuth in Nango

### Create Twitter Developer App

1. Go to https://developer.x.com/en/portal/dashboard
2. Create a new project/app
3. Under "User authentication settings", enable OAuth 2.0:
   - Type: Web App
   - Callback URL: `http://localhost:3003/oauth/callback`
   - Website URL: `http://localhost:3003`
4. Note your **Client ID** and **Client Secret**

### Add Twitter Integration to Nango

1. Open Nango dashboard: http://localhost:3003
2. Go to Integrations → Add Integration
3. Select "Twitter" (or add custom with provider `twitter-v2`)
4. Enter your Client ID and Client Secret
5. Scopes: `tweet.read tweet.write users.read offline.access`

### Authorize Your Twitter Account

1. In Nango dashboard → Connections → New Connection
2. Select Twitter integration
3. Connection ID: `test-twitter-connection`
4. Click "Connect" → authorize in Twitter popup
5. Connection should show as "Active"

## 3. Start the Gateway

```bash
# From repo root
cd services/x402-gateway

# Set env vars for local dev
export NANGO_HOST=http://localhost:3003
export NANGO_SECRET_KEY=nango-dev-secret-key
export CREDENTIAL_ACL_PATH=$(pwd)/credentials/test-acl.json
# Optional: strict request-bound claim checks (recommended)
export REQUIRE_JOB_CONTEXT=true
# Optional explicit key for bridge -> control-api signed claim checks
export CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY=0x...

# Start gateway
tsx index.ts
```

## 4. Run E2E Tests

```bash
cd services/x402-gateway/credentials

# Runs auth + fail-closed + payment + structured-audit scenarios
tsx test-e2e.ts
```

## 5. Manual Testing (ERC-8128 Signed Request)

```bash
cd jinn-node
tsx -e "
import { createPrivateKeyHttpSigner, signRequestWithErc8128 } from './src/http/erc8128.ts';
const signer = createPrivateKeyHttpSigner(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  8453
);
const request = await signRequestWithErc8128({
  signer,
  input: 'http://localhost:3001/credentials/github',
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: '0xabc' }),
  },
});
const response = await fetch(request);
console.log(response.status, await response.text());
"
```

## Cleanup

```bash
docker compose -f docker-compose.nango.yml down -v
rm -f test-acl.json
```
