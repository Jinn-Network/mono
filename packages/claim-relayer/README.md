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
- `JINN_CLAIM_RELAYER_DB_PATH`
- `JINN_CLAIM_RELAYER_PORT`
- `JINN_CLAIM_RELAYER_POLL_INTERVAL_MS`
- `JINN_CLAIM_RELAYER_BATCH_BLOCKS`

Default artifacts are resolved from `../../client/deployments/deployment-jinn-mvi-l1-sepolia.json`
and `../../client/deployments/deployment-jinn-mvi-l2-baseSepolia.json`.

Local run:

```bash
yarn install --immutable
yarn build
JINN_CLAIM_RELAYER_PRIVATE_KEY=0x... \
JINN_CLAIM_RELAYER_L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
JINN_CLAIM_RELAYER_L2_RPC_URL=https://sepolia.base.org \
JINN_CLAIM_RELAYER_START_BLOCK=41761151 \
node dist/index.js
```

Container:

```bash
docker build -t jinn-claim-relayer:latest -f deploy/Dockerfile .
docker run --env-file deploy/.env -v jinn-claim-relayer-data:/data -p 8737:8737 jinn-claim-relayer:latest
```
