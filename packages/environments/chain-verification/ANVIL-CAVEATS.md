# Anvil caveats (design §10)

Record runtime pin: **anvil 1.3.7** (the semver every fixture and attestation in this package
declares). Measurements below were taken on **2026-08-01** against the Foundry binary available
on the measuring host. **Production verification hosts must re-measure on a binary whose
`anvil --version` output contains `1.3.7`** before treating these numbers as authoritative for
sealed attestations.

## Measured binary

```
anvil Version: 1.6.0-nightly
Commit SHA: 5e88010a83d1b87b8f4d13058e42a2949d3e9dc0
Build Timestamp: 2026-04-28T06:53:34.706398000Z (1777359214)
Build Profile: dist
```

**Follow-up (F-T17-1):** Foundry `v1.3.7` is no longer published on the public release channel
as of this measurement pass (`foundryup -v 1.3.7` fails to extract on darwin arm64). The table
below documents what the **available** host binary showed. Install the pinned release from an
archived Foundry build or vendor a known `1.3.7` binary, then re-run `yarn test:anvil` and
replace this section before production hosts rely on `supportedControls`.

The opt-in suite's version probe requires the on-disk binary to report the pinned semver; hosts
running a different build (like the one measured here) will see the version test fail until the
PATH points at `1.3.7`.

## Measurements

| Measurement | Date | Result | Notes |
|-------------|------|--------|-------|
| `prevrandao` launch control | 2026-08-01 | **stable default only** | `--prevrandao` is not accepted on the measured binary (`1.6.0-nightly`). Two fresh `paris` instances report identical `mixHash` after one mined block, but that stability is not launch-level control — omit `prevrandao` from `supportedControls`. |
| `dumpFidelityLocal` | 2026-08-01 | **true** | Local world (two accounts with balance, code, and storage) round-trips through `--state` dump on `SIGTERM` and `--load-state` relaunch without losing indexed entries. |
| `dumpFidelityForked` | 2026-08-01 | **skipped** | Requires `CHAIN_VERIFICATION_ARCHIVE_RPC_URL` on the measuring host; CI does not supply an archive endpoint. |

## Resulting `supportedControls`

Pass this list to `createAnvilMaterializer({ supportedControls: [...] })` on hosts running the
**pinned** `1.3.7` runtime after re-measurement. The list below reflects conservative controls
validated on the measuring host's `1.6.0-nightly` binary; treat it as provisional until the
pinned binary pass lands. A control omitted here must not appear in a sealed record's
`determinismControls` — step 3 surfaces `determinism-control-unsupported` instead of attesting
to a control the materialization did not have.

| Control | Launch-level on measured host? |
|---------|----------------------------------|
| `miningMode` | yes — via `runtime.launch.options` (`--no-mining`, interval mining flags) |
| `initialTimestamp` | yes — `--timestamp` |
| `blockGasLimit` | yes — `--gas-limit` |
| `coinbase` | yes — via `runtime.launch.options` when the record supplies it |
| `prevrandao` | **no** — `--prevrandao` not honored at launch on the measured binary; omit from `supportedControls` |

Controls not listed above (`initialBlockNumber`, `orderingPolicy`, `mempoolPolicy`, and the
rest of the closed vocabulary) were not shown to apply at the Anvil launch line in this
measurement pass. Hosts may extend the list only after a fresh `yarn test:anvil` run on the
pinned `1.3.7` binary documents the additional launch flag.

## Forked dump fidelity

When `dumpFidelityForked` is not clean on a host, treat fork-sourced state dumps as untrusted
until design §7's widen-and-reverify loop re-validates the slice. That loop is mandatory for
CE4 extraction precisely because historical Anvil builds have dropped touched entries from
forked `--state` snapshots.
