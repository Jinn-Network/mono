# Troubleshooting Matrix

## Prerequisites

| Symptom | Cause | Fix |
|---|---|---|
| `poetry: command not found` | Poetry missing | `curl -sSL https://install.python-poetry.org | python3` then restart shell |
| `tendermint: command not found` | Tendermint missing | Install Tendermint v0.34.x binary |
| `poetry install` resolver errors | Wrong Python version | Use Python 3.10/3.11 (`poetry env use python3.11`) |
| `Cannot import operate module` | Middleware deps missing | `cd jinn-node && poetry install --sync` |

## Setup failures

| Symptom | Cause | Fix |
|---|---|---|
| `OPERATE_PASSWORD not set` | Missing env | Add to `.env` |
| `RPC_URL not set` | Missing env | Add to `.env` |
| `Missing required LLM authentication` | No Gemini auth | Set `GEMINI_API_KEY` or run `npx @google/gemini-cli auth login` |
| `Funding required before safe creation` | Expected setup checkpoint | Fund Master EOA and rerun `yarn setup` |
| `Funding required before deployment` | Expected setup checkpoint | Fund Master Safe (ETH + OLAS) and rerun `yarn setup` |
| `Wallet creation failed` | Middleware/runtime issue | Re-check prerequisites + env + retry |
| `.operate directory not found` warnings on first run | Non-fatal bootstrap noise | Ignore — harmless |

## Runtime failures

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot connect to the Docker daemon` | Docker installed but daemon not running | Start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux), then retry |
| Worker cannot reach Ponder | Wrong or unavailable endpoint | Verify `PONDER_GRAPHQL_URL` |
| Worker cannot reach Control API | Wrong or unavailable endpoint | Verify `CONTROL_API_URL` |
| Credentialed tools fail | Wrong gateway URL or ACL missing | Verify `X402_GATEWAY_URL`, gateway health, ACL grants |
| Git task failures | Missing credentials | Set `GITHUB_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` |

## stOLAS failures

| Symptom | Cause | Fix |
|---|---|---|
| `Master Safe needs ETH for mech deployment` | Master Safe underfunded after stOLAS stake | Fund Master Safe with ≥0.01 ETH, run `npx tsx scripts/deploy-mech.ts` |
| `Service created but mech deployment failed` | Agent EOA gas issue or RPC error | Fund Master Safe, run `npx tsx scripts/deploy-mech.ts --service-config-id=<id>` |
| stOLAS `stake()` reverts | Distributor out of OLAS or staking proxy not configured | Check distributor OLAS balance and `mapStakingProxyConfigs` for staking contract |
| `No staking slots available` | Staking contract is full | Wait for evictions or use a different staking contract |
| `stake() succeeded but no new service ID found` | Rare chain indexing lag | Check tx receipt on-chain, service may have different ID |
| `Service created but agent key storage failed` | Disk permission issue in `.operate/keys/` | Fix permissions and reimport |
| `Pre-flight simulation failed (inner call would revert)` | MechMarketplace.create() would fail | Check service registration and mech factory |
| `Safe execTransaction failed` / reverted | Master Safe nonce or signer issue | Check Master EOA is signer on Safe, verify nonce |
| `--testnet` flag but balance shows mainnet values | `secrets.rpcUrl` captured at import time | Pass `RPC_URL=<vnet-url>` as env var prefix |
| `stOLAS distributor not configured` | ExternalStakingDistributor not set up for staking contract | Use standard setup (`yarn setup`) or contact Jinn team |
| `Master EOA has insufficient ETH` | Not enough gas for Safe transaction | Fund Master EOA on Base with ≥0.002 ETH |
| `Service created but config import failed` | `.operate/services/` write error | Check disk permissions, manually import with `ServiceImporter` |

## Railway failures

| Symptom | Cause | Fix |
|---|---|---|
| Keystore decryption failure | Wrong `OPERATE_PASSWORD` | Match local password used for `.operate` |
| `.operate` not found in runtime | Volume/import issue | Verify volume mount `/home/jinn` and import `/home/jinn/.operate` |
| Worker boot loops | Missing required env | Check required vars and `railway logs --tail 300` |
