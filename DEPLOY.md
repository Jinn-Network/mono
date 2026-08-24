# Deploy a headless daemon and an operator console

The operator human surface is the **operator console** at
[`apps/operator-console/`](apps/operator-console/) — a Next.js app specified in
[`apps/operator-console/OPERATOR-APP-SPEC.md`](apps/operator-console/OPERATOR-APP-SPEC.md).
The daemon is headless: `GET /` on the API origin returns
`{ "error": "no_human_surface" }`.

This document gets a stranger from nothing to a running daemon plus a console
that talks to it, on their own machine or host.

## The one thing to understand: two origins

The former daemon/SPA same-origin ruling is **superseded** by
[headless operator re-derivation §9](docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md).
A console on `:3000` talking to a daemon on `:7331` is cross-origin by
construction. Cookie same-origin is not the contract.

The console calls the daemon with:

- an explicit base URL (`JINN_OPERATOR_URL` / `NEXT_PUBLIC_JINN_OPERATOR_URL`)
- header `x-jinn-ui-token` (never `withCredentials`)
- CORS origin allowlist on the daemon (`apiCorsOrigins`), **no**
  `Access-Control-Allow-Credentials`

Non-loopback operator-class responses require a trusted-proxy
`X-Forwarded-Proto: https` hop or `apiInsecureRemote: true`. Loopback is
always allowed. `jinn auth rotate` / `jinn auth token` mint the UI token
beside daemon state.

(Distinct from DR-2026-08-04's `spec.jinn.network` one-origin ruling, which
is about spec/identifier namespaces and stands.)

## Why run your own

Jinn is a neutral Schelling point, not a chokepoint. No one operates the
canonical UI; the network does not depend on any hosted dashboard. Anyone may
run their own operator UI permissionlessly. See [`PRINCIPLES.md`](PRINCIPLES.md)
— [Neutral](PRINCIPLES.md#neutral) and [Permissionless](PRINCIPLES.md#permissionless).

A hosted/Vercel console is **not** a Stage 6 requirement. Local v1 is a
console on `127.0.0.1:3000` talking to `127.0.0.1:7331`.

## Prerequisites

- **Docker** with Compose (`docker compose version` should print a version),
  **or** a local Node 22 checkout of this repo.
- **A keystore password** you choose, supplied as `JINN_PASSWORD`. It is
  env-only — never commit it to a file in the repo.
- **A Claude OAuth token**: run `claude setup-token` on a machine with a
  browser, which prints a long-lived `sk-ant-oat01-…` token. The daemon's
  default `claude-code` harness uses it as `CLAUDE_CODE_OAUTH_TOKEN`.

## Daemon: `docker compose up -d`

This reuses the existing [`operator/docker-compose.yml`](operator/docker-compose.yml)
and the public image `ghcr.io/jinn-network/operator`. From the repo root:

```bash
cd operator

# 1. Write your secrets into a .env next to the compose file.
echo "JINN_PASSWORD=choose-a-strong-password" > .env
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env

# 2. Start the daemon in the background.
docker compose up -d
```

The compose file pulls `ghcr.io/jinn-network/operator:latest`, mounts a `jinn-data`
volume at `/data`, and publishes `7331:7331`. Local v1 keeps the API on
loopback; do **not** set `JINN_API_BIND_HOST=0.0.0.0` unless you have put
TLS and a trusted proxy in front per §9.

**Pin the image for a reproducible deploy.** `:latest` is fine for a quick try.
For a deploy you can reproduce later, edit the `image:` line in
`operator/docker-compose.yml` from:

```yaml
image: ghcr.io/jinn-network/operator:latest
```

to a fixed release tag:

```yaml
image: ghcr.io/jinn-network/operator:<version>
```

Per-release tags `:<version>`, `:sha-<short>`, and `:latest` are published on
every GitHub Release (see [`deploy/README.md`](deploy/README.md)).

`GET /health`, `GET /ready`, and `GET /metrics` are the unauthenticated
liveness/readiness/metrics surface. `GET /v1/status` is operator-class and
token-gated.

Mint a UI token on the host that can reach daemon state:

```bash
jinn auth token
# or: jinn auth rotate
```

## Console: local Next.js

From the repo:

```bash
cd apps/operator-console
yarn install
NEXT_PUBLIC_JINN_OPERATOR_URL=http://127.0.0.1:7331 \
NEXT_PUBLIC_JINN_UI_TOKEN=<token from jinn auth token> \
yarn dev
```

Open `http://127.0.0.1:3000`. The console handshake reads `GET /v1/status`
and refuses to proceed on a major `contractVersion` mismatch.

## Remote access (only if the console is not loopback-to-loopback)

Binding the daemon on `0.0.0.0` makes operator-class routes reachable on the
network. Required before the first remote console fetch:

- CORS origin allowlist matching the console origin
- header token, `expiresAt`, `timingSafeEqual`
- no credentialed CORS
- trusted-proxy HTTPS **or** explicit `apiInsecureRemote: true` (loud; local
  diagnostics only)

A reverse proxy in front of `:7331` must forward `X-Forwarded-Proto` and
`X-Forwarded-For`. The daemon origin still has no human surface — proxy the
**console**, not `GET /` on the API.

### Railway (daemon only)

Run the same image as a Railway service: point **Source → Image** at
`ghcr.io/jinn-network/operator:<version>` (the package is public — no registry
auth), attach a `/data` volume (`railway volume add --mount-path /data`), set
`JINN_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`, and `JINN_API_BIND_HOST=0.0.0.0` in
the Variables panel (the bind-host override is required — Railway's edge proxy
cannot reach a loopback-bound process), and enable a public domain over port
`7331`. Put the console elsewhere. Headless-operator base details —
`JINN_STATE_DIR=/data` and the deploy contract — live in
[`deploy/README.md`](deploy/README.md). Earning is OLAS-native: the
daemon's `reward-claim` loop settles stOLAS distributor rewards. There is
no claim-relayer service.

## Build the daemon image from source

To build the image yourself instead of pulling it, use the existing
[`operator/Dockerfile`](operator/Dockerfile). Its build context is the **repo root**
(the client depends on `packages/sdk` through a Yarn portal). From the repo
root, on a checked-out tag:

```bash
git checkout <tag>
docker build -f operator/Dockerfile \
  -t jinn-client:<tag> \
  --build-arg JINN_BUILD_COMMIT=$(git rev-parse HEAD) \
  .
```

Run your build by replacing the `image:` line in `operator/docker-compose.yml`
with `jinn-client:<tag>`, then `docker compose up -d` as above.

`JINN_BUILD_COMMIT` is the reproducibility receipt: it is baked into the image
and surfaced at runtime in the `commit` field of `jinn version --json`
(`docker run jinn-client:<tag> version --json`), so a running mirror can prove
exactly which commit it was built from.

> If you build on Apple Silicon for a remote amd64 host (e.g. Railway), add
> `--platform linux/amd64` via `docker buildx` — a hand-built arm64 image fails
> to start on amd64 platforms. See [`deploy/README.md`](deploy/README.md).

## What this does not do

Stage 6 does not ship a hosted/Vercel console. The IPFS-pin and ENS stretch
goals are intentionally **not** shipped here.

The daemon you stand up is a real operator. Its network and funding status —
testnet by default, wallet/Safe funding, what it does on-chain — are described
in [`apps/operator-console/OPERATOR-APP-SPEC.md`](apps/operator-console/OPERATOR-APP-SPEC.md)
and in the root [`CLAUDE.md`](CLAUDE.md) under "Running the Client".
