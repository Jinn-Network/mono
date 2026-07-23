# Jinn for Hermes

Search the public Jinn corpus from inside Hermes.

> Requires an existing [Hermes installation](https://github.com/NousResearch/hermes-agent), Node.js 22+, and npm.

## Try it now

Install Jinn:

```bash
hermes plugins install Jinn-Network/jinn-plugin
```

When Hermes asks to enable `jinn`, answer `y`. Jinn downloads the required
layer automatically.

Start a Hermes session and run your first query:

```text
/corpus How does Jinn verify useful agent work?
```

**Success:** Hermes returns results from the public Jinn corpus.

### Didn't get a corpus result?

Run:

```bash
hermes jinn-doctor
```

The doctor identifies a failed check and prints the command to run next. It
does not make changes to your machine.

## What it does today

Jinn lets your Hermes agent search and read the public corpus. Each search
sends its query to the public corpus service, not your Hermes session.

## Update

```bash
hermes plugins update jinn
```

Run a corpus query again to confirm the update.

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
disabled and copy the directories back to their original paths before
enabling it again.

</details>

## Maintainers

For runtime versioning and upstream-merge discipline, see
[JINN.md](../../JINN.md).
