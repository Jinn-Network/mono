import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Skill-text pins for the Autopilot session skills (single-surface lifecycle
// §7: "The skill-text test suite pins each skill's contract: required verbs
// present, forbidden operations absent"). The prose these pins match is the
// contract, not decoration -- a rewording that drops a pinned phrase must
// update the pin in the same change, and must not drop the rule.
//
// Issue #3239: a fix-child session landed a code fix and its commit message
// asserted it had also corrected the parent PR body. It had not, and could
// not: `session child-complete` writes no PR body. The skill was silent on
// the boundary, so the session filled the silence with a false claim.

const root = resolve(import.meta.dirname, "../..");
const fixChildPath = join(root, ".claude/skills/fix-child/SKILL.md");
const fixChild = readFileSync(fixChildPath, "utf8");
// Pinned phrases are prose, so they wrap. Match against a flow-collapsed copy.
const fixChildFlow = fixChild.replace(/\s+/gu, " ");
// Shell invocations wrap too, on backslash continuations. Join those so an
// invocation is one line and a pin can see all of its flags at once.
const fixChildJoined = fixChild.replace(/\\\n\s*/gu, " ");

// Every flag each roster verb accepts. A flag outside this table is either
// invented or newly added upstream; either way the pin must be updated
// deliberately in the same change.
const FIX_CHILD_VERB_FLAGS = new Map([
  ["checkpoint", new Set()],
  ["child-complete", new Set()],
  ["human", new Set(["--reason-file"])],
]);

/** Every `autopilot session <verb>` invocation, with the flags it passes. */
function fixChildInvocations() {
  const invocations = fixChildJoined.matchAll(
    /autopilot session ([a-z-]+)([^\n]*)/gu,
  );
  return [...invocations].map((m) => ({
    verb: m[1],
    flags: [...m[2].matchAll(/--[a-z][a-z-]*/gu)].map((f) => f[0]),
  }));
}

// The complete set of shared mutations a fix-child session may perform, per
// the autopilot-runtime verb roster.
const FIX_CHILD_VERBS = new Set(["checkpoint", "child-complete", "human"]);

/**
 * Every mention of a roster verb anywhere in the skill -- the fenced
 * invocations and the bare `session <verb>` prose of the Method section alike
 * -- with the flags written after it. Only roster verbs are scanned, so a
 * prose reference to another session's verb (`session
 * implementation-complete`) is not read. The flag capture stops at a backtick
 * (the end of an inline code span) or a newline. Residual: a flag separated
 * from its verb by a prose line wrap inside one code span is not seen; nothing
 * in the skill writes that.
 */
function rosterVerbMentions(text) {
  const mentions = text.matchAll(
    /\bsession\s+(checkpoint|child-complete|human)(?![\w-])([^\n`]*)/gu,
  );
  return [...mentions].map((m) => ({
    verb: m[1],
    flags: [...m[2].matchAll(/--[a-z][a-z-]*/gu)].map((f) => f[0]),
  }));
}

test("fix-child invokes only its three roster verbs", () => {
  const invoked = new Set(fixChildInvocations().map((i) => i.verb));
  for (const verb of invoked) {
    assert.ok(
      FIX_CHILD_VERBS.has(verb),
      `fix-child must not invoke 'autopilot session ${verb}'`,
    );
  }
  for (const verb of FIX_CHILD_VERBS) {
    assert.ok(invoked.has(verb), `fix-child must document 'autopilot session ${verb}'`);
  }
});

test("fix-child states that it cannot mutate the parent PR body", () => {
  assert.match(
    fixChildFlow,
    /no verb that mutates the parent pull request body/,
    "fix-child must state plainly that it has no PR-body verb",
  );
});

test("fix-child forbids asserting an unmutatable change", () => {
  assert.match(
    fixChildFlow,
    /Never assert a change to a surface this session has no verb to mutate\./,
    "fix-child must forbid commit messages that claim an unreachable change",
  );
});

test("fix-child routes a materially falsified summary to the human door", () => {
  const start = fixChild.indexOf("## Surfaces you cannot mutate");
  assert.notEqual(start, -1, "fix-child must carry the surfaces section");
  const rest = fixChild.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  assert.match(
    section,
    /session human/,
    "the surfaces section must name `session human` as the escalation route",
  );
});

test("fix-child invents no verb flag", () => {
  for (const { verb, flags } of fixChildInvocations()) {
    const allowed = FIX_CHILD_VERB_FLAGS.get(verb) ?? new Set();
    for (const flag of flags) {
      assert.ok(
        allowed.has(flag),
        `\`session ${verb}\` takes no ${flag}; do not document one`,
      );
    }
  }
});

// Issue #3650: the pins above read only `autopilot session <verb>`
// invocations, but the Method section instructs its verb calls in bare
// `session <verb>` prose, so a flag documented there was invisible to them.
test("fix-child documents no flag its roster verbs lack, in prose or in the fence", () => {
  // Controls: the scanner sees a prose-form flag, and ignores a non-roster verb.
  assert.deepEqual(
    rosterVerbMentions("Finish with `session child-complete --summary-file <path>` (x)"),
    [{ verb: "child-complete", flags: ["--summary-file"] }],
  );
  assert.deepEqual(rosterVerbMentions("written by `session implementation-complete --foo`"), []);

  for (const { verb, flags } of rosterVerbMentions(fixChildJoined)) {
    for (const flag of flags) {
      assert.ok(
        FIX_CHILD_VERB_FLAGS.get(verb).has(flag),
        `fix-child documents \`session ${verb} ${flag}\`, which the verb does not accept`,
      );
    }
  }
});

// Issue #4178 (D3): review-pr had no skill-text pins. Single-surface §7
// requires them in the same change as any review-pr skill edit: required
// verbs present, forbidden operations absent, and the rename-trigger
// classification item that is this issue's payload.
const reviewPrPath = join(root, ".claude/skills/review-pr/SKILL.md");
const reviewPr = readFileSync(reviewPrPath, "utf8");
const reviewPrFlow = reviewPr.replace(/\s+/gu, " ");
const reviewPrJoined = reviewPr.replace(/\\\n\s*/gu, " ");

const REVIEW_PR_VERB_FLAGS = new Map([
  ["review-verdict", new Set(["--state", "--body-file", "--follow-ups-file"])],
  ["review-findings", new Set(["--file"])],
  ["human", new Set(["--reason-file"])],
]);

const REVIEW_PR_VERBS = new Set(["review-verdict", "review-findings", "human"]);

function reviewPrInvocations() {
  const invocations = reviewPrJoined.matchAll(
    /autopilot session ([a-z-]+)([^\n]*)/gu,
  );
  return [...invocations].map((m) => ({
    verb: m[1],
    flags: [...m[2].matchAll(/--[a-z][a-z-]*/gu)].map((f) => f[0]),
  }));
}

test("review-pr invokes only its three roster verbs", () => {
  const invoked = new Set(reviewPrInvocations().map((i) => i.verb));
  for (const verb of invoked) {
    assert.ok(
      REVIEW_PR_VERBS.has(verb),
      `review-pr must not invoke 'autopilot session ${verb}'`,
    );
  }
  for (const verb of REVIEW_PR_VERBS) {
    assert.ok(
      invoked.has(verb),
      `review-pr must document 'autopilot session ${verb}'`,
    );
  }
});

test("review-pr invents no verb flag", () => {
  for (const { verb, flags } of reviewPrInvocations()) {
    const allowed = REVIEW_PR_VERB_FLAGS.get(verb) ?? new Set();
    for (const flag of flags) {
      assert.ok(
        allowed.has(flag),
        `\`session ${verb}\` takes no ${flag}; do not document one`,
      );
    }
  }
});

test("review-pr contains no push instruction", () => {
  assert.match(
    reviewPrFlow,
    /Never push to the PR branch\./,
    "review-pr must forbid pushing the PR branch",
  );
  assert.doesNotMatch(
    reviewPr,
    /\bgit push\b/,
    "review-pr must not instruct git push",
  );
  assert.doesNotMatch(
    reviewPrJoined,
    /autopilot session (checkpoint|review-fix-publish|child-complete|implementation-complete)\b/,
    "review-pr must not invoke a mutation verb that publishes branch commits",
  );
});

test("review-pr classifies the D3 rename trigger under Review pass", () => {
  const start = reviewPr.indexOf("## Review pass");
  assert.notEqual(start, -1, "review-pr must carry the Review pass section");
  const rest = reviewPr.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  const sectionFlow = section.replace(/\s+/gu, " ");
  assert.match(
    sectionFlow,
    /renames an identifier, origin, namespace, or record kind/,
    "Review pass must name the D3 rename event",
  );
  assert.match(
    sectionFlow,
    /re-ground every negative assertion naming the old spelling/,
    "Review pass must require re-grounding negative assertions on rename",
  );
  assert.match(
    sectionFlow,
    /A missed re-ground is merge-blocking\./,
    "a missed re-ground must classify as merge-blocking",
  );
});

// file-issue is human-invoked rather than an Autopilot session skill, but agents run its
// commands as written, so the same drift applies: an unquoted `<pr>` in a runnable command
// is read by the shell as a redirection (#4855), and a bare relative scratch file such as
// `body.md` is left in the working directory for a later `git add -A` to commit (#3498).
const fileIssueFiles = ["SKILL.md", "references/gh-taxonomy.md"].map((name) => ({
  name,
  text: readFileSync(join(root, ".claude/skills/file-issue", name), "utf8"),
}));

/**
 * The text a shell would execute, line by line: every line inside a fenced code
 * block (a quoted heredoc body is data and is skipped), and every inline code span
 * that starts with `gh `. Quoted strings and comments are blanked out, because a
 * placeholder inside quotes reaches the command as a literal and is inert.
 */
function fileIssueRunnableLines(text) {
  const runnable = [];
  let inFence = false;
  let heredocEnd = null;
  for (const [index, line] of text.split("\n").entries()) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      heredocEnd = null;
      continue;
    }
    if (!inFence) {
      for (const span of line.matchAll(/`(gh [^`]+)`/gu)) {
        runnable.push({ line: index + 1, command: span[1] });
      }
      continue;
    }
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    runnable.push({ line: index + 1, command: line });
    const heredoc = /<<-?\s*['"]?([A-Za-z_]+)['"]?/u.exec(line);
    if (heredoc) heredocEnd = heredoc[1];
  }
  return runnable.map(({ line, command }) => ({
    line,
    command,
    bare: command
      .replace(/'[^']*'/gu, "''")
      .replace(/"[^"]*"/gu, '""')
      .replace(/(?:^|\s)#.*$/u, ""),
  }));
}

test("file-issue has no unquoted placeholder in a runnable command", () => {
  // The scanner has to see a hazardous line and pass a quoted or commented one, or an
  // empty result below would prove nothing.
  const probe = fileIssueRunnableLines(
    ["```bash", "gh pr view <pr> --json body", 'gh pr view "<pr>"', "# gh pr view <pr>", "```"].join("\n"),
  );
  assert.deepEqual(
    probe.filter(({ bare }) => /<[A-Za-z][A-Za-z0-9_-]*>/u.test(bare)).map(({ line }) => line),
    [2],
  );
  const unquoted = [];
  for (const { name, text } of fileIssueFiles) {
    for (const { line, command, bare } of fileIssueRunnableLines(text)) {
      if (/<[A-Za-z][A-Za-z0-9_-]*>/u.test(bare)) unquoted.push(`${name}:${line}: ${command.trim()}`);
    }
  }
  assert.deepEqual(unquoted, []);
});

// BSD `mktemp`, the one macOS ships, replaces only the X characters at the END of the
// template. `mktemp /tmp/pr-body-XXXXXX.md` prints that path back unchanged on macOS, so
// the first run succeeds with a fixed name and the second fails with "File exists" (#5019).
// GNU `mktemp` accepts the same template and randomizes it, which is why the recipe passed
// on Linux. The portable shape keeps the X characters last, as the repository's other
// recipes do (`stage-${N}-${NAME}.md.XXXXXX`).
function fileIssueMktempTemplates(text) {
  const templates = [];
  for (const { line, command } of fileIssueRunnableLines(text)) {
    for (const match of command.matchAll(/\bmktemp(?:\s+-[A-Za-z]+)*\s+(?!-)([^\s)"'`]+)/gu)) {
      templates.push({ line, template: match[1] });
    }
  }
  return templates;
}

test("the mktemp template scanner sees a non-portable template and passes a portable one", () => {
  const probe = fileIssueMktempTemplates(
    ["```bash", 'A=$(mktemp /tmp/a-XXXXXX.md)', 'B=$(mktemp /tmp/b.md.XXXXXX)', 'C=$(mktemp -d)', "```"].join("\n"),
  );
  assert.deepEqual(probe.map(({ template }) => template), ["/tmp/a-XXXXXX.md", "/tmp/b.md.XXXXXX"]);
});

test("file-issue mktemp templates end in their X characters", () => {
  const found = fileIssueFiles.map(({ name, text }) => ({ name, templates: fileIssueMktempTemplates(text) }));
  for (const { name, templates } of found) {
    assert.ok(templates.length > 0, `${name} no longer carries a mktemp recipe; the scan would pass vacuously`);
  }
  const unportable = [];
  for (const { name, templates } of found) {
    for (const { line, template } of templates) {
      if (!/XXXXXX$/u.test(template)) unportable.push(`${name}:${line}: ${template}`);
    }
  }
  assert.deepEqual(unportable, []);
});

test("running each file-issue mktemp recipe twice gives two different files and no failure", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jinn-file-issue-mktemp-"));
  try {
    for (const { name, text } of fileIssueFiles) {
      for (const { template } of fileIssueMktempTemplates(text)) {
        const local = template.replace(/^\/tmp\//u, `${scratch}/`);
        assert.ok(local.startsWith(scratch), `${name}: expected a /tmp template, got ${template}`);
        const run = () => execFileSync("mktemp", [local], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        const first = run();
        const second = run();
        assert.notEqual(first, second, `${name}: ${template} gave the same file twice`);
        assert.notEqual(first, local, `${name}: ${template} was not randomized`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("file-issue appends to a PR body through a temp file, not a bare relative path", () => {
  const { text } = fileIssueFiles[0];
  const commands = fileIssueRunnableLines(text);
  const recipe = commands.filter(({ command }) => /\bgh pr edit\s+\S+\s+--body-file\s+\S/u.test(command));
  assert.equal(recipe.length, 1, "SKILL.md must carry exactly one PR-body append recipe");
  const [{ line }] = recipe;
  // The recipe is the fenced block that holds the `gh pr edit` line; read it whole.
  const block = commands.filter((entry) => Math.abs(entry.line - line) <= 3);
  assert.ok(
    block.some(({ command }) => /=\$\(mktemp \/tmp\/[^)]*XXXXXX[^)]*\)/u.test(command)),
    "the recipe must take its scratch path from mktemp under /tmp",
  );
  for (const { command } of block) {
    assert.doesNotMatch(
      command,
      /(?:>>?|--body-file)\s*["']?[A-Za-z0-9._-]+\.md\b/u,
      `a literal relative file name in the recipe: ${command.trim()}`,
    );
  }
  assert.match(
    text.replace(/\s+/gu, " "),
    /gh pr edit --body-file` \*\*replaces\*\* the whole body/u,
    "the recipe must keep saying that --body-file replaces the whole body",
  );
});
