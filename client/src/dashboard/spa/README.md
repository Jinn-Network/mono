# Operator SPA dev

Vite + React + Tailwind. Source under `src/`, built into `dist/` and copied
into the daemon's `dist/dashboard/` directory by `client/yarn build`.

## Quick start

From `client/`:

```bash
# build the SPA standalone
yarn build:spa

# build the whole client (TS + SPA, copies SPA dist into dist/dashboard)
yarn build
```

## Develop

```bash
# in one terminal — vite dev server with proxy to :7331
yarn dev:spa
# vite serves at :5173 with /v1, /artifacts, /auth, /api proxied to the daemon
```

Run the daemon separately on `:7331`. From a contributor checkout that means
`yarn build && node dist/bin/jinn.js run` in `client/` (the operator package
launches the same binary as `jinn run`).

The dev server hot-reloads on `.tsx` / `.css` changes. The daemon's API is the
backend, so it must be running for the SPA to fetch data.

## Layout

- `src/api/` — typed fetch client + types
- `src/regions/` — one component per panel region (Status, Visibility, Setup, Agent)
- `src/styles/globals.css` — Tailwind import only
- `index.html` — Vite entry; loads `/src/main.tsx`
- `vite.config.ts` — proxy config for dev

## Build artifacts

`yarn build:spa` emits to `dist/` (relative to this package). The parent build
script (`yarn build` in `client/`) copies `dist/.` into `client/dist/dashboard/`
so the daemon serves the SPA from there.

## Auth

The SPA picks up a `?k=<handshake_key>` URL parameter on first load (the
launcher opens the handshake URL printed by the daemon), exchanges it for the
`jinn_ui_token` cookie via `/auth/handshake`, then strips the param. Subsequent
loads reuse the cookie.

`/v1/events`, `/v1/events/recent`, `/v1/bootstrap`, and `/api/admin/*` are
gated by `requireUiToken`. `/v1/status`, `/artifacts/*`, and the static `/`
+ `/assets/*` are not gated (the static SPA bundle must load before the
handshake completes).
