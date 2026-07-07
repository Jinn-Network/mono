# Explorer SPA

The network explorer — spec in [`EXPLORER-APP-SPEC.md`](EXPLORER-APP-SPEC.md).

## Build

```bash
yarn install --immutable
yarn build        # tsc -b && vite build → ../public/ (the indexer's static dir)
```

`public/` here is the vite *input* dir (static assets, `vercel.json`); the build *output* is `packages/indexer/public/` (gitignored), which the indexer serves directly.

## Deploy — explorer.jinn.network (Vercel)

The public explorer at https://explorer.jinn.network is a static Vercel deployment of the build output. The bundled `vercel.json` (from `public/`, copied into every build) proxies the two same-origin API namespaces (`/explorer/*`, `/distribution-signal`) to the Railway indexer and falls back to `index.html` for SPA routes. IPFS fetches go direct to the gateway.

```bash
yarn build
cd ../public
vercel link --yes --scope jinn-a6b5fa9d --project jinn-explorer
vercel deploy --prod --yes
```

Manual CLI deploys only — no git integration. The `jinn-explorer` project must keep framework preset / root directory / build command **unset** (it is a plain static upload; settings were reset 2026-07-07).
