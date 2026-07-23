# Jinn for Hermes

Give Hermes relevant evidence from the public Jinn corpus while you work.

> Requires [Hermes](https://github.com/NousResearch/hermes-agent), Node.js 22+,
> and npm.

## Install Jinn

```bash
hermes plugins install Jinn-Network/jinn-plugin
```

Answer `y` when Hermes asks to enable `jinn`. Jinn installs its required layer
automatically.

Check the installation:

```bash
hermes jinn-doctor
```

You are ready when the doctor ends with `all checks passed`.

If you use the Hermes gateway, restart it with `hermes gateway restart`. A new
terminal chat loads Jinn without this step.

## Talk to Hermes normally

Start a fresh chat and describe the task you want help with:

```bash
hermes chat
```

No slash command is required. Jinn checks the first message for relevant prior
evidence before Hermes answers. When it finds an eligible match, you will see a
line like:

```text
◇ corpus  provided 1 evidence packet  ·  searched: dashboard, version, test
```

Hermes receives that evidence as context and can use it in its answer. It can
also search and fetch corpus evidence later in the task when useful.

If there is no relevant evidence, Jinn stays out of the way. At the end of the
session, Hermes reports:

```text
knowledge searched · nothing relevant found
```

That is a successful search, not an installation problem.

## Check the corpus manually

Inside a Hermes chat, `/corpus <query>` shows raw search results. This is useful
for inspection and troubleshooting, but it is not required during normal use.

If corpus access fails, run `hermes jinn-doctor`. The doctor names the failed
check and prints the next command to run; it does not change your machine.

## Local task capture

Jinn keeps a scrubbed episode of each session locally. Nothing is shared
automatically.

## Update

```bash
hermes plugins update jinn
hermes jinn-doctor
```

## Disable or remove

```bash
hermes plugins disable jinn
hermes plugins remove jinn
```

Removing the plugin leaves its local Jinn data intact.

<details>
<summary>Permanently remove local Jinn data</summary>

Jinn state is stored in both `${HERMES_HOME:-$HOME/.hermes}/jinn/` and
`$HOME/.jinn-client/`. To back it up before deleting it, end active Hermes
sessions, disable the plugin, then run:

```bash
JINN_STATE_BACKUP="$HOME/jinn-state-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p -- "$JINN_STATE_BACKUP"
for path in "${HERMES_HOME:-$HOME/.hermes}/jinn" "$HOME/.jinn-client"; do
  [ ! -e "$path" ] || cp -a -- "$path" "$JINN_STATE_BACKUP/"
done
find "$JINN_STATE_BACKUP" -maxdepth 2 -print
```

After confirming the backup, remove both state directories:

```bash
rm -rf -- "${HERMES_HOME:-$HOME/.hermes}/jinn" "$HOME/.jinn-client"
```

This permanently deletes local Jinn data. To restore the backup, keep Jinn
disabled and copy the directories back to their original paths before enabling
it again.

</details>

## Maintainers

For runtime versioning and upstream-merge discipline, see
[JINN.md](../../JINN.md).
