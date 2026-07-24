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

## Try your first pickup

Start a fresh chat:

```bash
hermes chat
```

Then describe the task normally. Include the concrete problem and repository
when they matter; there is no Jinn slash command to run.

Jinn checks retained local episodes and the public Jinn corpus when a new task
starts or its stable task/repository context changes. When it finds evidence it
can actually deliver, you will see:

```text
◇ corpus  provided 2 evidence packets  ·  searched: score-zero, jinn, evaluator, docker, eval
```

For example, a clean test with matching retained episodes began with a normal
question:

```text
You: In the Jinn evaluator, a Docker eval run that aborts partway is recorded
as an ordinary score-zero failure. What is the root cause and specific fix?

Hermes: The evaluator's Docker-abort handling is incorrectly gated on
`noTestPassed`. Remove that requirement and classify known container-abort
signals as `EvalCouldNotGradeError`, even after partial test progress.
```

Hermes received the evidence automatically and used its concrete diagnosis.
Your result will depend on what relevant local or public evidence exists.

If no retrievable evidence matches the task, Jinn stays out of the way. At the
end of the session, Hermes reports:

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
