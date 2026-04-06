---
title: Troubleshoot OLAS Middleware
purpose: runbook
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - olas-operate-middleware/.operate
keywords: [olas, middleware, troubleshoot, authentication, service, mech, configuration]
when_to_read: "When encountering errors with olas-operate-middleware during service creation or configuration"
---

# Troubleshoot OLAS Middleware

Common issues when working with the olas-operate-middleware.

## Authentication Issues

### "Invalid password" during quickstart

**Cause**: Stale wallet configuration in `.operate` directory.

**Solution**:
```bash
rm -rf olas-operate-middleware/.operate
```

Then re-run with `OPERATE_PASSWORD` set.

### "User not logged in" errors

**Cause**: Middleware's password state stored in-process, lost between API calls.

**Solution**: Already handled by `OlasOperateWrapper.makeRequest()` which re-authenticates before every API call.

## Service Creation Issues

### Multiple Service Safes created unexpectedly

**Reality**: Each service deployment creates a **new Safe**, even with same Master Wallet.

**Prevention**: Check existing services before deployment:
```bash
ls -la olas-operate-middleware/.operate/services/
```

### Service reuses existing when you want fresh

**Cause**: Middleware reuses services if hash matches and directory exists.

**Solution**: Use unique service names:
```typescript
name: `jinn-service-${Date.now()}`
```

Or clean the services directory:
```bash
mv olas-operate-middleware/.operate/services olas-operate-middleware/.operate/services-backup
```

## Configuration Errors

### "ReadTimeout from registry.autonolas.tech"

**Cause**: Fake or invalid IPFS hash.

**Solution**: Use a real, validated IPFS hash:
```typescript
// ✅ Correct
hash: "bafybeihnzvqexxegm6auq7vcpb6prybd2xcz5glbvhos2lmmuazqt75nuq"

// ❌ Wrong
hash: "bafybeiflqjig7qlvpfrlqbvlcqv2h7ry6sytcx6fxqzwlpjqvdm7nfxpqy"
```

### "Chain not supported"

**Cause**: Uppercase chain name.

**Solution**: Use lowercase only:
```typescript
// ✅ Correct
home_chain: "base"

// ❌ Wrong
home_chain: "Base"
```

### TypeError on fund requirements

**Cause**: String values instead of integers.

**Solution**:
```typescript
// ✅ Correct
agent: 100000000000000000

// ❌ Wrong
agent: "100000000000000000"
```

## Mech Deployment Issues

### Mech not deployed

**Cause**: Trying to deploy mech after service creation.

**Reality**: Mech deployment only happens **during** service creation.

**Solution**:
```typescript
// ✅ Correct: Deploy mech DURING service creation
await serviceManager.deployAndStakeService(undefined, {
  deployMech: true
});

// ❌ Wrong: No such method exists
await serviceManager.deployMech();
```

## Staking Issues

### Staking not happening in attended mode

**Cause**: Config file has `staking_program_id` set, so middleware skips prompt.

**Check**:
```bash
jq '.configurations.base.staking_program_id' config.json
```

**Solution**: Delete `staking_program_id` from config to trigger prompt, or use unattended mode.

### Environment variables ignored

**Cause**: In attended mode (`ATTENDED=true`), middleware ignores `STAKING_PROGRAM` env var.

**Solution**: Either:
1. Use unattended mode (`ATTENDED=false`)
2. Answer the interactive prompt manually

## Network Issues

### Rate limit (429) errors

**Cause**: Too many RPC calls to public endpoint.

**Solution**:
1. Use QuickNode or Alchemy RPC
2. Add delays between calls:
   ```typescript
   await new Promise(r => setTimeout(r, 1000));
   ```
3. Wait 60 seconds and retry

### Mixed network service storage

**Reality**: Middleware stores ALL services in same directory regardless of network.

**How to identify network**:
```bash
for dir in olas-operate-middleware/.operate/services/sc-*/; do
  rpc=$(jq -r '.chain_configs.base.ledger_config.rpc' "$dir/config.json" 2>/dev/null)
  echo "$(basename $dir): $rpc"
done
```

- Tenderly: `https://virtual.base.eu.rpc.tenderly.co/...`
- Mainnet: `https://mainnet.base.org` or QuickNode URL

## Safe Transaction Issues

### GS026 (Invalid Signature)

**Cause**: Manual `execTransaction` signature format incorrect.

**Solution**: Use Safe SDK (`@safe-global/protocol-kit`) instead of manual signing.

### Insufficient funds for gas

**Cause**: Agent EOA lacks ETH.

**Solution**:
1. Check balance: `provider.getBalance(agentAddress)`
2. Fund agent EOA with ~0.001 ETH
3. Retry

## Corrupt Service Cleanup

### When services become corrupt

Signs of corruption:
- Missing config files
- Null Safe address (`0x0000...`)
- Unminted service tokens
- Interrupted deployments

**Auto-cleanup**: Worker removes corrupt services on startup via `OlasServiceManager.cleanupCorruptServices()`.

**Manual cleanup**:
```bash
# Backup first
cp -r olas-operate-middleware/.operate/services/SERVICE_ID \
      service-backups/SERVICE_ID-$(date +%Y%m%d-%H%M%S)

# Then remove
rm -rf olas-operate-middleware/.operate/services/SERVICE_ID
```

**Note**: Agent keys are preserved (stored globally in `/.operate/keys/`).

## Mainnet Safety Checklist

Before ANY mainnet operation:

- [ ] Wallet state backed up
- [ ] Know your Master EOA address
- [ ] Know your Master Safe address
- [ ] Check existing services
- [ ] Verify which Safe will be used/created
- [ ] Fund the correct addresses
- [ ] Never delete wallet directory on mainnet
- [ ] Document all Safe addresses created

## Related Documentation

- Deploy service: `docs/runbooks/deploy-olas-service.md`
- Configure staking: `docs/runbooks/configure-staking.md`
- Recover funds: `docs/runbooks/recover-olas-funds.md`
- Contract addresses: `docs/reference/OLAS_CONTRACTS.md`
