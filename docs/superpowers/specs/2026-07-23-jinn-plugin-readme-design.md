# Jinn Plugin README Redesign

## Goal

Make the `Jinn-Network/jinn-plugin` README a short, user-first onboarding guide for people who already use Hermes. Its single conversion goal is for a reader to install the plugin and receive a useful answer from their first public-corpus query.

## Audience and assumptions

- The reader already has Hermes installed.
- The reader wants to understand and try the plugin quickly.
- The README may link to Hermes installation documentation, but it does not explain how to install Hermes.

## Primary journey

1. The reader sees a plain-English promise: they can search the public Jinn corpus from inside Hermes.
2. They run `hermes plugins install Jinn-Network/jinn-plugin`.
3. They enable `jinn` when Hermes asks.
4. In a Hermes session, they run one example `/corpus <query>` command.
5. The README defines a returned answer from the public corpus as success.

The first corpus result is both the product's first-use experience and its installation test. `hermes jinn-doctor` is a recovery step, not part of the happy path.

## Proposed information hierarchy

### 1. Title, promise, and prerequisite

```md
# Jinn for Hermes

Search the public Jinn corpus from inside Hermes.

> Requires an existing Hermes installation. Link to the upstream Hermes installation guide for readers who need it.
```

Do not introduce the Jinn layer, runtime acquisition, fork relationship, or other implementation details in this opening section.

### 2. Primary call to action: install and test

```md
## Try it now

Install Jinn:

    hermes plugins install Jinn-Network/jinn-plugin

When Hermes asks to enable `jinn`, answer `y`.

Start a Hermes session and run your first query:

    /corpus How does Jinn verify useful agent work?
```

Follow the example with a clear success criterion:

> **Success:** Hermes returns an answer from the public Jinn corpus.

### 3. Troubleshooting only when needed

```md
### Didn't get a corpus result?

Run:

    hermes jinn-doctor
```

Explain in one sentence that the command identifies a failed check and prints the next command to run. Do not lead with it or require it after a successful installation.

### 4. What it does today

Use one concise statement of the present capability: users can search and read the public Jinn corpus from Hermes. Include a brief read-only/privacy reassurance that querying the corpus does not send task data from the user's machine.

Do not mention task capture or skill distillation in this README revision. Do not promote contribution or earning, which are not live.

### 5. Secondary operations

Place the following after the user journey, each in a compact section:

1. Update the plugin, then rerun the corpus query.
2. Disable or remove the plugin.
3. Permanently delete retained local data, clearly labelled as destructive and preferably inside a GitHub `<details>` disclosure.
4. Maintainer and architecture details, linked to `JINN.md` rather than explained in the onboarding flow.

## Copy and layout rules

- Keep the first screen to roughly 25 lines.
- Use direct, active language: “Install,” “start,” “ask,” and “search.”
- Keep each command in a self-contained step, without caveats embedded in the happy path.
- Favor user outcomes over implementation framing.
- Make the first command and the first corpus query visually easy to copy.
- State capabilities in the present tense; do not imply a contribution or reward economy is available.

## Out of scope

- Changes to plugin behavior, commands, or packaging.
- Hermes installation instructions beyond a link.
- Task capture, local trace processing, and skill distillation documentation.
- Contribution, verification, or earning workflows.
