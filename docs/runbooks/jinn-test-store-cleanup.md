# Runbook: clean local jinn test-store pollution

Before the store-path sandbox landed (Jinn-Network/mono#1841), jinn-agent
test suites that exercise session/layer persistence wrote into the real jinn
store dirs under `~/.jinn-client/*` instead of a per-test tempdir. On a
developer machine this leaves stale fixture data behind — short test session
IDs such as `s1`, `sA`, and `session-1` that can skew later local runs. New
runs are sandboxed by the autouse
`_hermetic_environment` fixture (step 6) in
`apps/jinn-agent/tests/conftest.py` — with a companion
`_jinn_store_write_guard` that checks every resolver call and fails loud if
even a temporary environment change escapes the tempdir — but existing local
pollution must be cleaned once, by hand.

## Store dirs

| env var | default path |
|---|---|
| `JINN_LAYER_CAPTURES_DIR` | `~/.jinn-client/harness-layer/captures` |
| `JINN_LAYER_EPISODES_DIR` | `~/.jinn-client/harness-layer/episodes` |
| `JINN_MINEABLE_STATE_DIR` | `~/.jinn-client/mineable` |

## Clean it (targeted and reversible)

Stop any running Jinn process first so it cannot update the contribution
store during this one-time operation. The cleanup is dry-run by default. It
recognizes only the hard-coded test session IDs `s1`, `s2`, `sA`, `sA1`,
`sA2`, `sB`, and `session-1`; timestamped Hermes sessions and all other
records remain untouched. Before editing, it backs up every selected file and
the pre-edit contribution store.

The script refuses paths outside the lexical `~/.jinn-client` tree and refuses
symlinks or symlinked path components. The dry-run plan retains each selected
file's identity, metadata, and content digest. `--yes` rechecks that evidence
immediately before deletion and stops if a fixture path has since been changed
or replaced with legitimate work.

```bash
cd apps/jinn-agent

# 1. See what would be removed (changes nothing):
python scripts/clean_jinn_test_pollution.py

# 2. Inspect the printed fixture-only list, then back up and remove it:
python scripts/clean_jinn_test_pollution.py --yes
```

`--yes` writes `~/.jinn-client/.pollution-backup-<UTC-timestamp>.tgz`,
unlinks only the listed capture/episode files, and removes only listed
fixture records from `mineable-traces.json`. It never removes a store
directory.

## Undo

With Jinn still stopped, untar the backup the script printed before creating
new records:

```bash
tar -xzf ~/.jinn-client/.pollution-backup-<timestamp>.tgz -C ~
```

This is a local-only, developer-machine operation. CI runs in fresh
containers and never accumulates this pollution.
