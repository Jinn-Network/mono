# Anvil caveats (design §10)

Record runtime pin: **anvil 1.3.7** (the semver every fixture and attestation in this package
declares). Measurements below were taken on **2026-08-01** against the Foundry binary available
on the measuring host. Re-run `yarn test:anvil` with an `anvil` whose `anvil --version` output
contains `1.3.7` before trusting these numbers for production verification hosts.

## Measured binary

```
anvil Version: 1.6.0-nightly
Commit SHA: 5e88010a83d1b87b8f4d13058e42a2949d3e9dc0
```

The opt-in suite's version probe requires the on-disk binary to report the pinned semver; hosts
that only have a different Foundry build should install the pinned release before running
`yarn test:anvil`.

## Measurements

| Measurement | Date | Result | Notes |
|-------------|------|--------|-------|
| `prevrandao` launch control | 2026-08-01 | **true** (stable default) | `--prevrandao` is not accepted on the measured binary (`1.6.0-nightly`). Two fresh `paris` instances still report identical `mixHash` after one mined block, but that stability is not launch-level control — omit `prevrandao` from `supportedControls` until a host running the pinned `1.3.7` binary shows the flag is honored. |
| `dumpFidelityLocal` | 2026-08-01 | **true** | Local world (two accounts with balance, code, and storage) round-trips through `--state` dump on `SIGTERM` and `--load-state` relaunch without losing indexed entries. |
| `dumpFidelityForked` | 2026-08-01 | **skipped** | Requires `CHAIN_VERIFICATION_ARCHIVE_RPC_URL` on the measuring host; CI does not supply an archive endpoint. |

## Resulting `supportedControls`

Pass this list to `createAnvilMaterializer({ supportedControls: [...] })` on hosts running the
pinned runtime. A control omitted here must not appear in a sealed record's
`determinismControls` — step 3 surfaces `determinism-control-unsupported` instead of attesting
to a control the materialization did not have.

| Control | Launch-level on pinned 1.3.7? |
|---------|----------------------------------|
| `miningMode` | yes — via `runtime.launch.options` (`--no-mining`, interval mining flags) |
| `initialTimestamp` | yes — `--timestamp` |
| `blockGasLimit` | yes — `--gas-limit` |
| `coinbase` | yes — via `runtime.launch.options` when the record supplies it |
| `prevrandao` | **no** — not honored at launch on the measured binary; omit from `supportedControls` |

Controls not listed above (`initialBlockNumber`, `orderingPolicy`, `mempoolPolicy`, and the
rest of the closed vocabulary) were not shown to apply at the Anvil launch line in this
measurement pass. Hosts may extend the list only after a fresh `yarn test:anvil` run documents
the additional launch flag.

## Forked dump fidelity

When `dumpFidelityForked` is not clean on a host, treat fork-sourced state dumps as untrusted
until design §7's widen-and-reverify loop re-validates the slice. That loop is mandatory for
CE4 extraction precisely because historical Anvil builds have dropped touched entries from
forked `--state` snapshots.
