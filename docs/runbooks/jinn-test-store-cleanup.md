# Runbook: clean local jinn test-store pollution

Before the store-path sandbox landed (Jinn-Network/mono#1841), jinn-agent
test suites that exercise session/layer persistence wrote into the real jinn
store dirs under `~/.jinn-client/*` instead of a per-test tempdir. On a
developer machine this leaves stale fixture data behind — "pollution" that
can skew later local runs. New runs are sandboxed by the autouse
`_hermetic_environment` fixture (step 6) in
`apps/jinn-agent/tests/conftest.py` — with a companion
`_jinn_store_write_guard` that fails loud if a resolver escapes the
tempdir — but existing local pollution must be cleaned once, by hand.

## Store dirs

| env var | default path |
|---|---|
| `JINN_LAYER_CAPTURES_DIR` | `~/.jinn-client/harness-layer/captures` |
| `JINN_LAYER_EPISODES_DIR` | `~/.jinn-client/harness-layer/episodes` |
| `JINN_MINEABLE_STATE_DIR` | `~/.jinn-client/mineable` |

## Clean it (reversible)

The cleanup is dry-run by default and backs up before removing.

```bash
cd apps/jinn-agent

# 1. See what would be removed (changes nothing):
python scripts/clean_jinn_test_pollution.py

# 2. Back up to a timestamped tarball and remove the dirs:
python scripts/clean_jinn_test_pollution.py --yes
```

`--yes` writes `~/.jinn-client/.pollution-backup-<UTC-timestamp>.tgz`
containing the three dirs, then removes them.

## Undo

Untar the backup the script printed:

```bash
tar -xzf ~/.jinn-client/.pollution-backup-<timestamp>.tgz -C ~
```

This is a local-only, developer-machine operation. CI runs in fresh
containers and never accumulates this pollution.
