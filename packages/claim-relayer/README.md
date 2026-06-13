# JINN Claim Relayer

Standing Path A relayer for the JINN mock messenger flow.

Required environment:

- `JINN_CLAIM_RELAYER_PRIVATE_KEY`
- `JINN_CLAIM_RELAYER_L1_RPC_URL`
- `JINN_CLAIM_RELAYER_L2_RPC_URL`
- `JINN_CLAIM_RELAYER_START_BLOCK`

Optional environment:

- `JINN_CLAIM_RELAYER_L1_ARTIFACT`
- `JINN_CLAIM_RELAYER_L2_ARTIFACT`
- `JINN_CLAIM_RELAYER_DISTRIBUTOR_ADDRESS`
- `JINN_CLAIM_RELAYER_MOCK_MESSENGER_ADDRESS`
- `JINN_CLAIM_RELAYER_TASK_CLAIM_EMITTER_ADDRESS`
- `JINN_CLAIM_RELAYER_DB_PATH`
- `JINN_CLAIM_RELAYER_PORT`
- `JINN_CLAIM_RELAYER_POLL_INTERVAL_MS`
- `JINN_CLAIM_RELAYER_BATCH_BLOCKS` (defaults to `2000`, matching the Base Sepolia public RPC log-range cap)

Default artifacts are resolved from `../../client/deployments/deployment-jinn-mvi-l1-sepolia.json`
and `../../client/deployments/deployment-jinn-mvi-l2-baseSepolia.json` when running from the source tree.
The container image copies those artifacts to `/app/client/deployments`, matching the compiled runtime default.

The relayer only accepts `TaskClaimEmitter`. If the bundled L2 deployment artifact has not yet been
updated from a legacy `JinnClaimEmitter` deployment, set `JINN_CLAIM_RELAYER_TASK_CLAIM_EMITTER_ADDRESS`
explicitly.

Local run:

```bash
yarn install --immutable
yarn build
JINN_CLAIM_RELAYER_PRIVATE_KEY=0x... \
JINN_CLAIM_RELAYER_L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://sepolia.gateway.tenderly.co \
JINN_CLAIM_RELAYER_L2_RPC_URL=https://base-sepolia.publicnode.com,https://sepolia.base.org \
JINN_CLAIM_RELAYER_START_BLOCK=41761151 \
node dist/index.js
```

## Recommended RPC fallback chains

Both `JINN_CLAIM_RELAYER_L1_RPC_URL` and `JINN_CLAIM_RELAYER_L2_RPC_URL` accept a
comma-separated list of providers. The loader builds a viem `fallback({ rank: false })`
transport that preserves slot order — the primary is tried first and the next slot is
used on a network error or HTTP 429/5xx — capped at 4 providers. Ship a multi-provider
chain in every deploy so a single endpoint blip does not wedge the relayer (the
single-provider L1 regression that #1068 fixed live on Railway; durability pinned in #1071).

- **L1 (Ethereum Sepolia)** — 3 providers, slot order publicnode → drpc → tenderly-public:
  `https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://sepolia.gateway.tenderly.co`
- **L2 (Base Sepolia)** — 2 providers, slot order publicnode → base.org (mirrors the daemon
  default in `client/src/config.ts`): `https://base-sepolia.publicnode.com,https://sepolia.base.org`

This mirrors the daemon's RPC slot-order convention (#592/#835). Operators with a paid key
(Alchemy / Tenderly) should **prepend** their URL, keeping the public chain as automatic
backup. Use no spaces inside the comma-separated value — under Docker `--env-file` a trailing
space or inline comment is folded into the URL.

Container:

```bash
docker build -t jinn-claim-relayer:latest -f packages/claim-relayer/deploy/Dockerfile .
docker run --env-file packages/claim-relayer/deploy/.env -v jinn-claim-relayer-data:/data -p 8737:8737 jinn-claim-relayer:latest
```
