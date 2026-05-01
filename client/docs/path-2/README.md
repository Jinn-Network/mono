# Path 2 — bring your own restorer impl

Path 2 lets you ship a full `RestorerImpl` (or `EvaluatorImpl`) as an npm package, loaded by the daemon via the external-impl loader. You own the entire `run(ctx)` surface and compete as a peer of in-repo impls.

This index links the recruit-facing docs.

| Doc | What it covers |
|---|---|
| **[Quickstart](./quickstart.md)** | 60-second walkthrough — scaffold, edit, test, sign, publish, install. |
| **[SDK reference](./sdk-reference.md)** | Field-by-field reference for the public types in `@jinn-network/restorer-sdk`. |
| **[Publishing](./publishing.md)** | Manifest signing, tarball pinning, IPFS publish, sample CI config. |
| **[Patterns](./patterns/README.md)** | Three pattern walkthroughs (forecaster, evaluator, alternative-harness), anchored on packages under `examples/external-restorer-impls/`. |

## How Path 2 fits

The Jinn engine resolves an intent to a `RestorerImpl` via `supports(kind, type)` first-match. In-repo impls (`prediction-v0-baseline`, `prediction-v0-evaluator`, `claude-code-learner`) and external impls compete on the same surface. Whichever impl claims the intent first runs it.

External impls load via the dynamic-import loader defined in `spec/2026-05-external-restorer-impls.md`. The daemon reads the operator's `restorers.externalImpls` config, fetches each declared manifest, verifies the signature against the operator's trust store, validates the package's tarball CID + sha256, dynamic-imports the entry, and constructs the impl via the factory's default export.

## Trust posture

Path 2 trust is **explicit, per-impl, signed**. The trust contract is canonical in `spec/2026-05-executor-trust-boundary.md` §3 / §5; the recruit-facing summary:

- Impls ship a signed `jinn.manifest.json` (ed25519 over the canonicalised manifest, signature stripped).
- Operators trust signing keys via `jinn impls trust ed25519:<base64-pubkey> --label <name>`.
- Operators install impls via `jinn impls add ipfs://<manifest-cid>` (or a config-declared variant); the daemon verifies the signature against the operator's trust store, refuses to load on mismatch.
- Capability handles (`ctx.signer`, `ctx.rpc`, `ctx.secrets`) are scoped at construction time per the manifest's `capabilities` allow-list. The impl cannot widen its capabilities at runtime.
- Revocation: the operator runs `jinn impls revoke <name>` to immediately stop loading; a maintainer revocation list provides upstream signalling but is informational.

## Stability commitment

`@jinn-network/restorer-sdk` is the contract surface. The package follows strict semver:

- **Major bumps** for breaking changes to a re-exported type, a function signature, or an enumerated value.
- **Minor bumps** are additive only — a new field on `ExternalRestorerEnv`, a new optional method on `RestorerImpl`, a new capability handle on `RestorationContext` ships as a minor; pre-existing impls keep loading.
- **12-week deprecation window.** From the day a major lands on npm, the prior major remains supported for 12 weeks. During the window, the daemon accepts manifests declaring either major; after the window, only the new major loads.

See [`./sdk-reference.md`](./sdk-reference.md) for the full surface and the canonical source under `packages/restorer-sdk/src/`.

## Distribution

Path 2 distributes as **npm packages + IPFS-pinned manifests**. The two surfaces are:

- **Package:** the npm tarball containing your built code. Pinned by sha256 + IPFS CID in the manifest.
- **Manifest:** `jinn.manifest.json` pinned to IPFS, signed by an ed25519 key. The operator installs the manifest CID; the daemon resolves the package by CID + hash.

Operators install via:

```bash
jinn impls trust ed25519:<base64-pubkey> --label <your-name>
jinn impls add ipfs://<manifest-cid>
```

See [`./publishing.md`](./publishing.md) for the full sign + pin + publish flow.

## Vocabulary

When in doubt about a Jinn-specific term (`vessel`, `vow`, `wish`, `seer`, `wane`), check `GLOSSARY.md` rather than redefining it locally.
