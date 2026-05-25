# Third-Party Licences

Jinn-authored source code in this repository is licensed under
**Apache License 2.0** (see `LICENSE`). Some files in this repository
are vendored from upstream projects and retain their original
licences, indicated by per-file `SPDX-License-Identifier` headers.
Where a per-file SPDX header exists, **the SPDX header is
authoritative for that file**.

This file is the human-readable inventory of those third-party
licences. It is maintained on a best-effort basis; the SPDX headers
are the legal source of truth.

## Solidity contracts (`contracts/src/`)

| Path | Upstream | Licence | Notes |
|---|---|---|---|
| `contracts/src/` (Jinn-authored) | — | MIT (pre-existing) / Apache-2.0 (new) | 116 MIT-tagged files at time of writing; new Jinn-authored files default to Apache-2.0 going forward (see `CONTRIBUTING.md`). |
| `contracts/src/vendor/stolas/solmate/` | [stolas](https://github.com/valory-xyz/autonolas-stolas) fork of [Solmate](https://github.com/transmissions11/solmate) | **AGPL-3.0-only** | 4 files: `ERC20.sol`, `ERC4626.sol`, `SafeTransferLib.sol`, `FixedPointMathLib.sol`. Upstream Solmate is MIT; the Valory `stolas` fork relicensed to AGPL-3.0-only. **Resolution needed** — see follow-up below. |
| `contracts/src/vendor/mech/lib/Account.sol` | [zodiac-modifier-roles](https://github.com/gnosis/zodiac) / mech | **GPL-3.0** | Single file. |
| `contracts/src/vendor/mech/lib/Mech.sol`, `IMechGnosis.sol`, `IFactoryFriendly.sol`, `Receiver.sol` | [mech](https://github.com/gnosis/mech) | **LGPL-3.0** (variants) | 4 files. |
| `contracts/src/vendor/registries/`, `contracts/src/vendor/governance/`, `contracts/src/vendor/tokenomics/`, `contracts/src/vendor/bridge/` | [autonolas-registries](https://github.com/valory-xyz/autonolas-registries), [autonolas-governance](https://github.com/valory-xyz/autonolas-governance), [autonolas-tokenomics](https://github.com/valory-xyz/autonolas-tokenomics) | MIT | Vendored upstream contracts; Jinn-authored Solidity in `contracts/src/` may import these. |

### Known copyleft-resolution work (not in this PR)

The four AGPL-3.0 files vendored from the `stolas` fork are the
only viral-copyleft surface in the repository. They are used by
contracts that Jinn distributes (compiled, deployed). Apache 2.0 is
not compatible with AGPL-3.0 in the same combined work.

This PR does **not** resolve that incompatibility. The PR's purpose
is to establish a licence for Jinn-authored code; resolving
copyleft contamination of the contracts package is a separate piece
of work that requires either:

1. Replacing the AGPL-3.0 `stolas/solmate` files with upstream
   MIT-licensed Solmate (preferred — same APIs, same provenance,
   permissive licence), or
2. Replacing them with another permissively-licensed equivalent
   (`@openzeppelin/contracts`), or
3. Accepting and documenting that the contracts package as
   distributed is effectively AGPL-3.0 (not preferred — conflicts
   with the Permissionless principle).

Tracked separately as a follow-up. Until then, downstream consumers
of contracts that link the `stolas/solmate` files should treat the
resulting binary as governed by AGPL-3.0 terms in addition to
Apache-2.0.

The GPL-3.0 and LGPL-3.0 vendored files in `vendor/mech/lib/` are
less contagious in practice (LGPL-3.0 in particular permits linking
under more permissive terms) but should be reviewed as part of the
same audit.

## TypeScript daemon (`client/`)

The npm dependency tree for `client/` is large. A machine-readable
inventory can be produced with:

```bash
cd client
yarn licenses list --json > ../docs/legal/client-licenses.json
```

A formal third-party-notices document for the published
`@jinn-network/client` package is a follow-up to this PR. Until then,
the `client/package.json` `license` field (MIT, pre-dates this
licence adoption) and the npm registry metadata are the operative
declarations for the published package.

## Indexer (`packages/indexer/`) and SDK (`packages/sdk/`)

These packages adopt the repository default (Apache-2.0) unless their
own `package.json` `license` field declares otherwise. A formal
inventory follows the same process as the client.

## Documentation, design system, brand assets

| Path | Licence | Notes |
|---|---|---|
| `docs/design/jinn-design-system/project/assets/` (sigils, wordmark) | All rights reserved (Jinn Network) | Not licensed under Apache-2.0. See `TRADEMARKS.md`. |
| Other documentation in `docs/`, `spec/`, `log/`, root canonical docs (`*.md`) | Apache-2.0 | Source code licence applies. |

## How to update this file

Add or correct an entry whenever you:

- Vendor a new third-party source file or directory.
- Change the upstream of an existing vendored copy.
- Notice that a per-file SPDX header disagrees with this inventory
  (the SPDX header wins; correct this file).

Material changes to the licensing posture (e.g. adopting or dropping
a permissive/copyleft boundary) go through a GitHub Discussion and
CODEOWNERS approval like other canonical-adjacent changes.

------------------------------------------------------------------------

Provenance: introduced alongside the adoption of Apache 2.0 as the
repository licence. See `LICENSE`, `NOTICE`, `TRADEMARKS.md`.
