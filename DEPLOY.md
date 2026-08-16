# Deploy your own mirror of the reference frontend

The reference frontend is the **operator dashboard SPA** — the web UI an
operator uses to watch and drive a Jinn daemon. It is not a standalone app:
it ships inside the `@jinn-network/client` package and is served by the daemon
itself. Its domain model, surfaces, and actions are specified in
[`operator/OPERATOR-APP-SPEC.md`](operator/OPERATOR-APP-SPEC.md).

This document gets a stranger from nothing to their own running mirror of that
frontend, on their own domain, in under an hour — without asking anyone.

## The one thing to understand: frontend and daemon are one origin

> **Amended 2026-08-04:** this daemon/SPA same-origin ruling is **superseded at cutover
> stage 6** by the
> [headless operator re-derivation design §9](docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md)
> — the SPA departs to a separate operator console that connects via explicit base URL +
> operator token under that section's remote-access preconditions. Until stage 6 lands,
> everything below remains accurate. (Distinct from DR-2026-08-04's `spec.jinn.network`
> one-origin ruling, which is about spec/identifier namespaces and stands.)

The SPA talks to its daemon over **same-origin relative paths only**. It calls
`/v1`, `/api`, `/auth`, and `/artifacts` with no host prefix; it opens the
agent WebSocket at `/api/agent/ws` derived from `window.location.host`; every
request goes out with `credentials: 'same-origin'`. There is **no configurable
API base URL** anywhere in the SPA source.

The consequence is the whole deploy story: **you cannot host the frontend
detached and point it at a remote daemon.** To deploy the frontend you stand up
the daemon — which serves the frontend on port `7331` — and put your domain in
front of that port. Running the dashboard against your own daemon *is* running
your own daemon and reaching its built-in UI. That is what the rest of this doc
does.

## Why mirror it at all

Jinn is a neutral Schelling point, not a chokepoint. No one operates the
canonical UI; the network does not depend on any hosted dashboard. Anyone may
run their own operator UI permissionlessly, and the protocol treats every mirror
the same. See [`PRINCIPLES.md`](PRINCIPLES.md) — [Neutral](PRINCIPLES.md#neutral)
and [Permissionless](PRINCIPLES.md#permissionless).

## Prerequisites

- **Docker** with Compose (`docker compose version` should print a version).
- **A host** — a laptop, a VPS, or a Railway service. Anything that can run a
  container and expose a port.
- **A keystore password** you choose, supplied as `JINN_PASSWORD`. It is
  env-only — never commit it to a file in the repo.
- **A Claude OAuth token**: run `claude setup-token` on a machine with a
  browser, which prints a long-lived `sk-ant-oat01-…` token. The daemon's
  default `claude-code` harness uses it as `CLAUDE_CODE_OAUTH_TOKEN`.

## The one-command path: `docker compose up -d`

This reuses the existing [`operator/docker-compose.yml`](operator/docker-compose.yml)
and the public image `ghcr.io/jinn-network/client`. From the repo root:

```bash
cd operator

# 1. Write your secrets into a .env next to the compose file.
echo "JINN_PASSWORD=choose-a-strong-password" > .env
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env
echo "JINN_API_BIND_HOST=0.0.0.0" >> .env

# 2. Start the daemon in the background.
docker compose up -d
```

The compose file pulls `ghcr.io/jinn-network/client:latest`, mounts a `jinn-data`
volume at `/data`, and publishes `7331:7331`.

The daemon's HTTP API binds `127.0.0.1` by default, which makes it unreachable
across the network out of the box — the published `7331:7331` port (and any
reverse proxy or Railway edge in front of it) would get connection-refused.
`JINN_API_BIND_HOST=0.0.0.0` removes that outer firewall so the published port
actually reaches the daemon. Plainly: binding `0.0.0.0` makes the daemon
reachable on the network, so you MUST keep it behind a reverse proxy / firewall
and treat the `?k=` handshake token (and `JINN_PASSWORD`) as the security
boundary — never expose a `0.0.0.0`-bound daemon directly to the public internet
without TLS + the token gate in front.

**Pin the image for a reproducible deploy.** `:latest` is fine for a quick try.
For a deploy you can reproduce later, edit the `image:` line in
`operator/docker-compose.yml` from:

```yaml
image: ghcr.io/jinn-network/client:latest
```

to a fixed release tag:

```yaml
image: ghcr.io/jinn-network/client:<version>
```

Per-release tags `:<version>`, `:sha-<short>`, and `:latest` are published on
every GitHub Release (see [`deploy/README.md`](deploy/README.md)). Find the tag
list on the `jinn-network/client` GHCR package page or under GitHub Releases.

## Reach the UI: the one-time handshake

With `JINN_API_BIND_HOST=0.0.0.0` set (step 1 above), the daemon binds `7331`
on all interfaces inside the container and prints a one-time **handshake URL**
to its logs on startup. The SPA's data surfaces (events, bootstrap, setup,
launcher, discovery, admin) are gated by the handshake — it sets the
`jinn_ui_token` cookie that authorizes those calls. Without it the dashboard
loads but its gated data calls are rejected. `GET /v1/status` is gated the
same way as of spec §14.5 (issue #2404) — it is no longer a public read
route. `GET /health`, `GET /ready`, and `GET /metrics` are the intentionally
public routes now (liveness, readiness, and Prometheus metrics — spec
§6.1–§6.2): point a supervisor or scraper at those, not `/v1/status`.
`GET /artifacts/search` and `GET /artifacts/:id/content` also stay public.
So do not treat a reachable `:7331` as safe just because the dashboard's
gated data calls require the cookie. The network boundary is still TLS plus
your reverse proxy.

Pull the handshake URL from the logs:

```bash
docker compose logs jinn-daemon | grep "UI handshake URL"
# [api] UI handshake URL: http://127.0.0.1:7331/?k=<key>
```

Open it **once** in a browser, substituting your host for `127.0.0.1` if you are
remote (for example `http://your-host:7331/?k=<key>`). That sets the cookie; from
then on the dashboard works at the bare `http://your-host:7331/`. Treat the `k=`
key like a password — anyone with it can authorize a session. Because the key
is printed to the daemon's logs, anyone who can read your deploy's log stream
(for example the Railway logs panel) can authorize a session — restrict log
access accordingly, and rotate the key by restarting the daemon (it generates a
fresh handshake key on every boot) if a log was exposed.

## Put your own domain in front (this is deploying the frontend)

The daemon serves the frontend on `7331`. Terminating TLS on your domain and
proxying to `7331` is the deploy. The reverse proxy **must pass the WebSocket
upgrade** for `/api/agent/ws`, or the live agent panel will not connect.

### Self-host / VPS: Caddy

A minimal `Caddyfile` that terminates TLS and proxies to a daemon on the same
host. Caddy passes WebSocket upgrades through `reverse_proxy` by default:

```caddy
dashboard.example.com {
    reverse_proxy 127.0.0.1:7331
}
```

That is the whole proxy. Caddy provisions the certificate automatically; the
daemon stays bound to `7331` behind it. The daemon must bind an interface the
proxy can reach — keep `JINN_API_BIND_HOST=0.0.0.0` from the `.env` set above
(its default `127.0.0.1` bind would refuse the proxy's connection). Complete the
`?k=` handshake once through your domain (`https://dashboard.example.com/?k=<key>`).

### Railway

Run the same image as a Railway service: point **Source → Image** at
`ghcr.io/jinn-network/client:<version>` (the package is public — no registry
auth), attach a `/data` volume (`railway volume add --mount-path /data`), set
`JINN_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`, and `JINN_API_BIND_HOST=0.0.0.0` in
the Variables panel (the bind-host override is required — Railway's edge proxy
cannot reach a loopback-bound process), and enable a public domain over port
`7331`. Railway terminates TLS and proxies (WebSocket included) for you. The headless-operator base details — `JINN_STATE_DIR=/data`,
the deploy contract, the optional claim-relayer service — live in
[`deploy/README.md`](deploy/README.md); this section is just the frontend-facing
slice of that same image.

## Build from source at a tagged commit (reproducible path)

To build the image yourself instead of pulling it, use the existing
[`operator/Dockerfile`](operator/Dockerfile). Its build context is the **repo root**
(the client depends on `packages/sdk` through a Yarn portal), and `yarn build`
bundles the SPA into `dist/`. From the repo root, on a checked-out tag:

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

There is **no static-mirror path today** — no IPFS pin, no Vercel deploy that
points a detached frontend at a remote daemon. As the code stands that is
impossible on two counts: the SPA has no configurable API base URL, and while
the daemon does set a global wildcard CORS (so its *public* read routes are
world-readable cross-origin), it exposes no cross-origin auth for the
credentialed, cookie-gated routes — a wildcard origin cannot carry credentials,
so a detached cross-origin SPA could reach none of the gated daemon data it
needs to function. Making it possible is a separate feature (configurable `VITE_API_BASE`
+ daemon credentialed CORS + cross-origin auth), not this document.

The IPFS-pin and ENS stretch goals are intentionally **not** shipped here for
the same reason: a frontend pinned to IPFS or resolved via ENS would, today,
be a frontend that can reach no daemon. Naming the gap keeps it known rather
than forgotten.

The daemon you stand up is a real operator. Its network and funding status —
testnet by default, wallet/Safe funding, what it does on-chain — are described
in [`operator/OPERATOR-APP-SPEC.md`](operator/OPERATOR-APP-SPEC.md) and in the root
[`CLAUDE.md`](CLAUDE.md) under "Running the Client".
