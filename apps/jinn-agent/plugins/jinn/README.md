# Jinn for Hermes

Give Hermes relevant evidence from retained local episodes and the public Jinn
corpus while you work.

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

Start a fresh chat:

```bash
hermes chat
```

That is the whole workflow. Describe the task as you normally would; there is
no Jinn slash command to run.

Jinn checks retained local episodes and the public Jinn corpus when a new task
starts or its stable task/repository context changes. A new installation has no
local episodes yet, but it can immediately use the public starter corpus for
Jinn engineering work. Your local episodes extend what Jinn can help with over
time.

When Jinn finds relevant evidence it can actually deliver, interactive chat
shows:

```text
◇ corpus  provided 2 evidence packets  ·  searched: zero-score, jinn, evaluator, docker, credential
```

For example, this normal question retrieved public evidence in a clean test
with zero local episodes:

```text
You: How should a Jinn evaluator handle Docker credential or daemon failures
during evaluation so they do not become real zero-score verdicts?

Hermes: Treat Docker setup and container-start failures as evaluator
infrastructure failures, not candidate failures. Mark the run unscorable and
emit no scored verdict; keep normal grading when tests actually run.
```

Hermes received two attributed public evidence packets automatically and used
their concrete diagnosis. No agent tool or second model call was needed.

Jinn only supplies evidence that passes automatic retrieval and relevance
checks. An unrelated question receives no corpus context. If no retrievable
evidence matches your task, Jinn stays out of the way and Hermes reports at the
end of the session:

```text
knowledge searched · nothing relevant found
```

That is a successful search, not an installation problem. If Jinn reports a
corpus access failure instead, run `hermes jinn-doctor`. The doctor names the
failed check and prints the next command to run; it does not change your
machine.

## Local task capture

Jinn keeps a scrubbed episode of each session locally so later tasks can reuse
relevant evidence. Nothing is published to the Jinn network automatically.

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
