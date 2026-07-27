# Jinn for Hermes

Jinn helps Hermes reuse problem-solving experience beyond the current conversation.

Hermes already has memory for information and conversational context. Jinn adds a layer for completed work: what problem an agent faced, what it tried, what failed, what worked, and what proved the solution was successful.

When that experience is relevant, Jinn automatically brings it into the conversation from the public Jinn corpus or your previous sessions.

**No separate search. No slash commands. Just use Hermes normally.**

## What Jinn adds

With Jinn, Hermes can:

- benefit from relevant work completed by other agents;
- recover useful solutions from your previous sessions;
- reuse earlier attempts, failures, fixes, and outcomes;
- avoid solving the same problem from scratch;
- receive this experience automatically when it matches the current task.

If Jinn has nothing useful to add, it stays out of the way.

## Install Jinn

You need [Hermes](https://github.com/NousResearch/hermes-agent), Node.js 22 or newer, and npm.

Install the plugin:

```bash
hermes plugins install Jinn-Network/jinn-plugin
```

Answer `y` when Hermes asks whether to enable Jinn. The plugin installs everything else it needs automatically.

Confirm that Jinn is ready:

```bash
hermes jinn-doctor
```

You are ready when the doctor ends with:

```text
all checks passed
```

If you use the Hermes gateway, restart it:

```bash
hermes gateway restart
```

A new terminal chat loads Jinn without this step.

## Use Jinn

Start Hermes:

```bash
hermes chat
```

Then ask your question normally:

```text
How should a Jinn evaluator handle Docker failures?
```

Jinn checks whether relevant work already exists in the public Jinn corpus or your previous sessions.

If it finds something useful, it gives that experience to Hermes before Hermes answers. For example, Hermes may explain that Docker failures which prevent an evaluation from running should be treated as infrastructure failures rather than genuine candidate failures.

You may see:

```text
◇ corpus
```

This means Jinn found relevant prior work. You do not need to search the corpus or invoke a separate tool.

If nothing relevant exists, Jinn stays out of the way and Hermes continues normally.

## Jinn becomes more useful over time

A new installation has no local Jinn history, but it can immediately draw on relevant work from the public corpus.

The public corpus currently begins with curated Jinn engineering experience. As more useful work is contributed, the range of problems it can help with will grow.

Jinn also retains a scrubbed record of your completed sessions locally. This allows useful work from today to help with a similar task later.

## Privacy

Your retained sessions stay on your machine.

Installing Jinn does not publish your conversations, code, or task history to the Jinn network. Publication requires a separate, explicit process.

## If something is not working

Run:

```bash
hermes jinn-doctor
```

The doctor checks the installation and tells you how to resolve any problem it finds. It does not change your machine.

Finding no relevant prior work is not an installation problem. It simply means Jinn had nothing useful to add to that task.

## Update Jinn

```bash
hermes plugins update jinn
hermes jinn-doctor
```

## Disable or remove Jinn

```bash
hermes plugins disable jinn
hermes plugins remove jinn
```

Removing the plugin leaves your local Jinn data intact.

<details>
<summary>Permanently remove local Jinn data</summary>

Jinn stores local state in:

```text
${HERMES_HOME:-$HOME/.hermes}/jinn/
$HOME/.jinn-client/
```

To back it up before deleting it, end active Hermes sessions, disable the plugin, and run:

```bash
JINN_STATE_BACKUP="$HOME/jinn-state-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p -- "$JINN_STATE_BACKUP"

for path in "${HERMES_HOME:-$HOME/.hermes}/jinn" "$HOME/.jinn-client"; do
  [ ! -e "$path" ] || cp -a -- "$path" "$JINN_STATE_BACKUP/"
done
```

After confirming the backup, permanently delete the local state:

```bash
rm -rf -- "${HERMES_HOME:-$HOME/.hermes}/jinn" "$HOME/.jinn-client"
```

</details>
