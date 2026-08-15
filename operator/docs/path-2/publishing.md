# Path 2 publishing — sign, pin, install

Path 2 distribution combines two surfaces:

- **The npm tarball** — your built code, pinned by sha256 + IPFS CID in the manifest.
- **The signed manifest** — `jinn.manifest.json`, pinned to IPFS, ed25519-signed by your maintainer key.

The daemon resolves the package by CID + hash from the manifest; operators trust the maintainer's public key once and install Harnesses via `jinn harnesses add <package-path>`. The canonical trust contract is `spec/2026-05-executor-trust-boundary.md` §5.

The scaffolded `.github/workflows/publish.yml` automates the full flow; this doc walks the steps so you can reproduce them locally and so you understand what CI is doing.

## 1. Generate an ed25519 signer key

One-time per maintainer. Keep the private key in a secrets manager (1Password, GitHub Actions secrets, Vault); never check it into a repo.

```ts
import { utils, getPublicKey } from '@noble/ed25519';
import { writeFileSync } from 'node:fs';

const privateKey = utils.randomPrivateKey();           // Uint8Array(32)
const publicKey = await getPublicKey(privateKey);      // Uint8Array(32)

writeFileSync('jinn-signer.key', Buffer.from(privateKey).toString('base64'));
console.log('public key (base64):', Buffer.from(publicKey).toString('base64'));
```

Distribute the **public key** with your README and any recruit-facing docs. Operators add it to `trustedImplSigners[]` in their config:

```json
{
  "trustedImplSigners": [
    { "alg": "ed25519", "publicKey": "<base64-pubkey>", "label": "<your-name>" }
  ]
}
```

once per maintainer; thereafter every manifest you sign with the matching private key is trusted.

## 2. Compute the tarball's CID + sha256

```bash
yarn build                              # tsc → dist/
npm pack --json | jq -r '.[0].filename' # packages-X.Y.Z.tgz
```

Compute the sha256:

```bash
shasum -a 256 packages-X.Y.Z.tgz
# → abc123... packages-X.Y.Z.tgz
```

Compute the CID by adding to IPFS (next step) — `ipfs add` returns the CID directly. You'll plug both back into `jinn.manifest.json`:

```jsonc
{
  "package": {
    "cid": "bafybei...",
    "hash": "sha256:abc123..."
  }
}
```

## 3. Fill in `jinn.manifest.json`

Start from the scaffold:

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@yourname/your-package",
  "version": "0.1.0",
  "description": "...",
  "supportedSolverTypes": ["prediction.v0>=1.0.0"],
  "entry": "./dist/index.js",
  "package": { "cid": "...", "hash": "sha256:..." },
  "capabilities": {
    "rpc": [{ "chainId": 8453, "methods": ["eth_call", "eth_blockNumber"] }]
  },
  "signature": { "alg": "ed25519", "publicKey": "...", "sig": "" },
  "license": "MIT"
}
```

Fill in `package.cid`, `package.hash`, your `supportedSolverTypes`, your `capabilities` allow-list, and `signature.publicKey` (the base64 from step 1). Leave `signature.sig` empty for the sign step.

The capability allow-list is a **ceiling**: the daemon enforces it at runtime. Declare the minimum you need; broader allow-lists earn operator suspicion and slower install decisions.

## 4. Sign the manifest

The signing algorithm matches `operator/src/harnesses/manifest/` (the Phase A.2 verifier):

1. Strip the `signature` field from the manifest.
2. Canonicalise: sorted keys, no whitespace, UTF-8 bytes.
3. ed25519-sign the canonical bytes with your private key.
4. Encode the signature as base64 and place it in `signature.sig`.

```ts
import { sign } from '@noble/ed25519';
import { canonicalize } from './canonical.js';   // from packages/sdk

const manifest = JSON.parse(readFileSync('jinn.manifest.json', 'utf8'));
const { signature, ...payload } = manifest;
const bytes = new TextEncoder().encode(canonicalize(payload));
const sig = await sign(bytes, privateKey);

manifest.signature.sig = Buffer.from(sig).toString('base64');
writeFileSync('jinn.manifest.json', JSON.stringify(manifest, null, 2));
```

The verifier runs the same canonicalisation; any whitespace or key-ordering drift breaks verification.

## 5. Pin to IPFS

```bash
ipfs add packages-X.Y.Z.tgz                      # → bafybei... (use as package.cid)
# Re-sign now that you know the CID, then:
ipfs add jinn.manifest.json                      # → bafyman... (the manifest CID operators install)
```

Production deployments use a pinning service (Pinata, Filebase, web3.storage) so the CID stays available without running a local IPFS daemon. Free-tier services suffice for most recruits.

## 6. Publish to npm

```bash
npm publish --access public
```

The package's npm presence is the discoverability surface; the IPFS pin is the load-time integrity check. The daemon resolves the package by CID + hash from the manifest, **not** by `npm install` — so the npm tarball must match the manifest's CID exactly.

## 7. Sample CI

The scaffolded `.github/workflows/publish.yml` runs on tag push:

```yaml
name: Publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: yarn install --immutable
      - run: yarn typecheck
      - run: yarn test
      - run: yarn build
      - id: pack
        run: echo "tarball=$(npm pack --json | jq -r '.[0].filename')" >> $GITHUB_OUTPUT
      - id: hash
        run: |
          HASH=$(shasum -a 256 "${{ steps.pack.outputs.tarball }}" | cut -d' ' -f1)
          echo "sha256=$HASH" >> $GITHUB_OUTPUT
      - id: pin
        uses: filebase/ipfs-action@v1
        with:
          path: ${{ steps.pack.outputs.tarball }}
          service: pinata
          pinataKey: ${{ secrets.PINATA_KEY }}
          pinataSecret: ${{ secrets.PINATA_SECRET }}
      - run: node scripts/sign-manifest.mjs
        env:
          PACKAGE_CID: ${{ steps.pin.outputs.cid }}
          PACKAGE_HASH: ${{ steps.hash.outputs.sha256 }}
          SIGNER_KEY: ${{ secrets.SIGNER_KEY }}
      - id: pin-manifest
        uses: filebase/ipfs-action@v1
        with:
          path: jinn.manifest.json
          service: pinata
          pinataKey: ${{ secrets.PINATA_KEY }}
          pinataSecret: ${{ secrets.PINATA_SECRET }}
      - run: npm publish --access public
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
      - uses: softprops/action-gh-release@v2
        with:
          body: |
            Manifest CID: `${{ steps.pin-manifest.outputs.cid }}`
            Operators install the package via:
            ```
            jinn harnesses add ./node_modules/@yourname/your-package
            ```
```

The release notes carry the manifest CID and package version so operators can fetch the matching package and run `jinn harnesses add <package-path>`.

## 8. Operator-side install

Once the maintainer's public key is trusted (one-time), every release installs as:

```bash
jinn harnesses add ./node_modules/@yourname/your-package
```

The daemon:

1. Fetches the manifest from IPFS.
2. Strips `signature`, canonicalises, verifies the signature against the trust store.
3. Refuses to load on signature mismatch (untrusted key, tampered manifest).
4. Fetches the package tarball by `package.cid`, verifies `package.hash`, refuses on mismatch.
5. Validates `capabilities` against the daemon's policy ceiling.
6. Appends to `~/.jinn-client/config.json` under `harnesses.externalImpls`.

`jinn harnesses list` shows installed Harnesses; `jinn harnesses show <name>` shows the verified manifest when supported by the local CLI; `jinn harnesses remove <name>` uninstalls.

For the canonical install + verify flow, see `spec/2026-05-executor-trust-boundary.md` §5.
