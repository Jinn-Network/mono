---
name: olas-registry
description: Register and manage OLAS protocol entries (components, agents, services). Handles metadata upload, on-chain minting, and marketplace verification.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# OLAS Registry Management

Register components, agents, and services on the OLAS protocol. Components and agents go on Ethereum mainnet; services go on Base L2.

## Critical: Hash Computation

**The on-chain `unitHash` / `configHash` is the raw SHA-256 digest from the IPFS CID, NOT a keccak256 hash.**

The OLAS registry stores a `bytes32` that is the SHA-256 digest portion of an IPFS CIDv1. The `tokenURI()` function reconstructs the CID by prepending `f01701220` (CIDv1 + dag-pb + sha2-256 + 32 bytes prefix).

### Correct flow:
```
1. Upload metadata JSON to IPFS → get CIDv0 (Qm...)
2. Decode CIDv0: base58btc(0x1220 + sha256_digest)
3. Strip 2-byte prefix (0x12, 0x20) → raw 32-byte sha256 digest
4. Pass as bytes32 to RegistriesManager.create()
```

### In code:
```typescript
import bs58 from 'bs58';

function cidToBytes32(ipfsCid: string): string {
  const decoded = bs58.decode(ipfsCid);
  // CIDv0: 0x12 (sha2-256) + 0x20 (32 bytes) + digest
  if (decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error('Unexpected CID multihash prefix');
  }
  return '0x' + Buffer.from(decoded.slice(2)).toString('hex');
}
```

### WRONG (will produce unresolvable metadata):
```typescript
// DO NOT DO THIS - creates a keccak256 hash that points to nothing on IPFS
keccak256(toUtf8Bytes("ipfs://" + cid))
```

### How the marketplace resolves metadata:
```
On-chain bytes32 → prepend "f01701220" → gateway URL
https://gateway.autonolas.tech/ipfs/f01701220{hex-of-unitHash}
→ fetches metadata JSON from IPFS
```

## Required Metadata Schema

The OLAS marketplace frontend expects this JSON structure:

```json
{
  "name": "org/package-name:version",
  "description": "Short description of the unit.",
  "code_uri": "ipfs://Qm... or https://...",
  "image": "ipfs://Qm...",
  "attributes": [
    { "trait_type": "version", "value": "1.0.0" }
  ]
}
```

**Required fields the UI reads:**
- `name` — displayed as package name (format: `org/slug:version`)
- `description` — displayed in detail view
- `image` — NFT image (supports `ipfs://` prefix)
- `code_uri` — "View Code" link
- `attributes[0].value` — version display

Additional custom fields are allowed and ignored by the marketplace.

## Contract Addresses

### Ethereum Mainnet (Components + Agents)
| Contract | Address |
|----------|---------|
| RegistriesManager | `0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE` |
| ComponentRegistry | `0x15bd56669F57192a97dF41A2aa8f4403e9491776` |
| AgentRegistry | `0x2F1f7D38e4772884b88f3eCd8B6b9faCdC319112` |

### Base L2 (Services)
| Contract | Address |
|----------|---------|
| ServiceManagerToken | `0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6` |
| ServiceRegistryL2 | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` |

## Current Registry Entries

### Component
- **ID 315** — Jinn Template Specification
  - CID: `QmTcf2785JH3ZPSRRnseAoX2xzWAEcPt1uiE5Q9x6egWD2`
  - Hash: `0x4e6414173e3819a9648893198bf832ad5af4e6b9a5701c9a23fecde88a1b5215`
  - Owner: Venture Safe `0x900Db2954a6c14C011dBeBE474e3397e58AE5421`

### Agents (all depend on component 315)
| ID | Template Slug | IPFS CID |
|----|--------------|----------|
| 98 | crypto-token-research | `QmRdcmx9GfUJ8tN2JGzRcpcTtJkdMSbAS2BTABzaWX8JHE` |
| 99 | governance-digest | `QmPtYFemaqhGekMMPmcsM4R7pRzfYJetFmHwP3bcqfRaeX` |
| 100 | competitive-landscape | `QmYSm6LobuYRqz5NyzXsh2CYmVnpRyGPRkDToDuatPLwMZ` |
| 101 | code-repository-audit | `QmQr3WT5k2AuzSbs5wBtHrsChBWy3pKTupy3et453AbPm7` |
| 102 | content-campaign | `QmWmxAbHVDutCFzXSDTedgZViQB46wziPoCyrvRz2onzF4` |
| TBD | jinn-node (worker) | TBD — run `tsx scripts/register-jinn-node-agent.ts` |

### Services (Base) — Individual per Agent
| ID | Agent ID | Name | IPFS CID |
|----|----------|------|----------|
| 366 | 98 | Crypto Token Researcher | `QmPDHTQaFek2SqEpGmANUTukJQHhFtmW51JsWDFKUA67Ro` |
| 367 | 99 | Governance Analyst | `Qmd6A4QDxo9UFgwBAGARVxv3UVicxQpDThXEdzUhGtu3os` |
| 368 | 100 | Competitive Landscape Researcher | `QmPjhZdGLBnzWEWXMkeDqCj4xbW9RA6T7AMS2Jqs6ZjBib` |
| 369 | 101 | Code Repository Auditor | `QmPRFiiULZMGTWtR7WJno3zAhARL7kEuutKoLSNhqhG49R` |
| 370 | 102 | Content Campaign Manager | `QmWd3mEYyru3ppxt3s5ZZBbxSjtn3PPRK9uLzrAoy37jLY` |

### Deprecated entries (wrong hash computation or broken metadata)
- Component 314, Agents 88-92, 93-97, Services 364, 365

## Minting Scripts

### Component
```bash
OPERATE_PROFILE_DIR=".../olas-operate-middleware/.operate" \
ETH_RPC_URL="https://ethereum-rpc.publicnode.com" \
npx tsx scripts/register-olas-component.ts [--dry-run]
```

### Agents
```bash
OPERATE_PROFILE_DIR=".../olas-operate-middleware/.operate" \
ETH_RPC_URL="https://ethereum-rpc.publicnode.com" \
npx tsx scripts/mint-olas-agent.ts --all --componentId 315 [--dry-run]
```

### jinn-node Worker Agent
```bash
OPERATE_PROFILE_DIR=".../olas-operate-middleware/.operate" \
ETH_RPC_URL="https://ethereum-rpc.publicnode.com" \
npx tsx scripts/register-jinn-node-agent.ts [--dry-run]
```

### Services (individual per agent)
```bash
OPERATE_PROFILE_DIR=".../olas-operate-middleware/.operate" \
BASE_RPC_URL="https://base-rpc.publicnode.com" \
npx tsx scripts/mint-olas-service.ts --single [--dry-run]
```

## Key Gotchas

### 1. parseCreateUnitEvent always fails
The `OlasContractHelpers.parseCreateUnitEvent()` can't parse the CreateUnit event from receipts (likely ABI mismatch with log encoding). **Workaround:** Extract the unit ID from the Transfer event (ERC721 mint):
```typescript
for (const log of receipt.logs) {
  if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
    const tokenId = parseInt(log.topics[3], 16);
  }
}
```

### 2. ServiceManager.create() requires non-zero bonds
The contract reverts with `ZeroValue()` (error `0x7c946ed7`) if any `agentParams[i].bond == 0`. Set bond to at least 1 wei.

### 3. ServiceManager.create() threshold requirements
`WrongThreshold(threshold, minThreshold, maxThreshold)` — threshold must be `>= ceil(2/3 * totalSlots)`. For 5 agents with 1 slot each: threshold >= 4.

### 4. ServiceManager.create() token parameter
Use ETH sentinel address `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` for native ETH bonds. OLAS token or zero address will fail.

### 5. updateHash() requires Safe ownership
`RegistriesManager.updateHash()` checks `msg.sender == ownerOf(unitId)`. If units are owned by a Safe (Venture Safe), the Master EOA can't call it directly. Must go through Safe tx.

### 6. IPFS upload endpoint
```
POST https://registry.autonolas.tech/api/v0/add?wrap-with-directory=false
FormData: file=<blob>
Returns: { Hash: "Qm...", Name: "...", Size: "..." }
```

### 7. RPC rate limiting
- `llamarpc.com` — aggressive rate limiting, drops TX receipts
- `publicnode.com` — best for reads, reliable for TXs
- `blastapi.io` — most reliable for TX submission on mainnet
- Always set `maxPriorityFeePerGas >= 1.5 gwei` on mainnet to avoid stuck TXs

### 8. Jinn logo IPFS CID
`QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR` — uploaded from `frontend/spec/static/img/logo.png`

## Verification

### Check agent metadata resolves:
```bash
node -e "
const { JsonRpcProvider, Contract } = require('ethers');
const p = new JsonRpcProvider('https://ethereum-rpc.publicnode.com');
const c = new Contract('0x2F1f7D38e4772884b88f3eCd8B6b9faCdC319112',
  ['function tokenURI(uint256) view returns (string)'], p);
c.tokenURI(98).then(u => { console.log(u); fetch(u).then(r=>r.json()).then(console.log); });
"
```

### Check service metadata resolves:
```bash
# Check any of the 5 individual services (366-370)
node -e "
const { JsonRpcProvider, Contract } = require('ethers');
const p = new JsonRpcProvider('https://base-rpc.publicnode.com');
const c = new Contract('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  ['function tokenURI(uint256) view returns (string)'], p);
c.tokenURI(366).then(u => { console.log(u); fetch(u).then(r=>r.json()).then(console.log); });
"
```

### Marketplace URLs:
- Agents: `https://registry.olas.network/ethereum/agents/{id}`
- Components: `https://registry.olas.network/ethereum/components/{id}`
- Services: `https://registry.olas.network/base/services/{id}`
