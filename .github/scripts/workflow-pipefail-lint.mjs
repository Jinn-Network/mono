#!/usr/bin/env node
// Unguarded early-exit pipe consumers in `.github/workflows/*.yml` `run:` blocks.
//
// A pipeline whose consumer stops reading before the producer stops writing kills the
// producer with SIGPIPE once the output outruns the 64KiB pipe buffer. Under
// `-o pipefail` that dead producer's 141 becomes the pipeline's status even though the
// consumer found exactly what it was looking for. The bug is invisible on small diffs
// and appears only when the repository grows past the buffer, which is why both known
// instances were found by review rather than by a failing run:
//
//   - PR #2821: `printf '%s\n' "${changed}" | grep -qE -f patterns` in the four
//     operator-surface `changes` jobs. The `if` took the else branch, the lane
//     unselected, and the required gate reported green over jobs that never ran.
//   - PR #2857: the same shape in `indexer-enrichment-ci.yml`, where it surfaced as a
//     spurious red instead.
//
// The #2857 review also established that a step declaring `shell: bash` is invoked
// `bash --noprofile --norc -eo pipefail {0}`, so pipefail is in scope with no
// `set -o pipefail` anywhere in the script. Roughly half the exposed surface is
// therefore invisible to a grep-for-pipefail sweep, which is what this lint exists to
// replace.
//
// Severity follows the shell GitHub actually runs:
//
//   - pipefail in scope (`shell: bash`, a custom shell string naming pipefail, or a
//     `set … pipefail` earlier in the block) -> error; the lint exits 1.
//   - the default `bash -e {0}` -> warning; printed, but not this gate's failure. A
//     bare `bash -e` pipeline reports only the last command's status, so it launders a
//     failed producer rather than inventing a failure (the PR #2819 finding).
//
// Escape hatch, on the offending line or the body line above it:
//
//   # pipefail-lint: allow -- git rev-list --max-parents=0 emits one line
//
// A reason is mandatory: an annotation without one is itself an error, so the hatch
// cannot silence a site without recording why the site is safe.
//
// Reading the YAML as indented text rather than through a parser is the established
// convention here — `.github/scripts/` carries no dependency manifest, so every sibling
// suite slices workflow sources the same way.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(import.meta.dirname, '../workflows');

// Shells whose `run:` body is a POSIX-ish pipeline language. Anything else (`pwsh`,
// `python`, `node`, …) has no `|` semantics this lint models, and is skipped whole.
const PIPELINE_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh']);

// grep options that consume the following argument, so a pattern that happens to look
// like `-q` is never read as a flag.
const GREP_ARG_TAKING = new Set(['-e', '-f', '-m', '--regexp', '--file', '--max-count']);

const ANNOTATION = /#\s*pipefail-lint:\s*allow\b(?<rest>.*)$/u;

/**
 * @typedef {object} Finding
 * @property {string} file      workflow file name
 * @property {number} line      1-based line in that file
 * @property {'error'|'warning'} severity
 * @property {string} consumer  the early-exit consumer, e.g. `grep -q`
 * @property {string} statement the offending statement, trimmed
 * @property {string} detail    why it is reported at this severity
 */

// ---------------------------------------------------------------------------
// Shell-text scanning
// ---------------------------------------------------------------------------

// Per-character "this is shell syntax, not literal text": false inside single or double
// quotes and for the quote/escape characters themselves. A command substitution is
// transparent — `$(` opens a fresh quoting frame that `)` closes, so the pipe in
// `X="$(producer | head -1)"` is seen for what it is rather than hidden by the outer
// double quotes. That exact shape is `release-notes-scaffold.yml`'s, so treating `$( … )`
// as literal would have made this lint blind to the sites it exists to find.
function syntaxMask(text, initial = { quote: null, frames: [] }) {
  const mask = new Array(text.length).fill(false);
  const frames = [...initial.frames];
  let quote = initial.quote;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== "'" && char === '\\') {
      index += 1;
      continue;
    }
    if (quote !== "'" && char === '$' && text[index + 1] === '(') {
      frames.push(quote);
      quote = null;
      index += 1;
      continue;
    }
    if (quote === null && char === ')' && frames.length > 0) {
      quote = frames.pop();
      continue;
    }
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    mask[index] = quote === null;
  }
  return { mask, quote, frames };
}

// Split `text` on shell-syntax occurrences of the operators in `separators`.
function splitUnquoted(text, separators) {
  const { mask } = syntaxMask(text);
  const parts = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const separator = separators.find(
      (candidate) =>
        text.startsWith(candidate, index) &&
        [...candidate].every((_, offset) => mask[index + offset] === true),
    );
    if (separator === undefined) continue;
    parts.push(text.slice(start, index));
    index += separator.length - 1;
    start = index + 1;
  }
  parts.push(text.slice(start));
  return parts;
}

// One physical body line read in the quoting state its predecessors left behind: its
// code (everything before a shell-syntax `#` that starts a word — `${VAR#prefix}` is
// untouched, since its `#` follows `{` rather than whitespace), the heredoc delimiter it
// opens if any, and the state the next line inherits.
function scanLine(text, initial) {
  const { mask } = syntaxMask(text, initial);

  let code = text;
  for (let index = 0; index < text.length; index += 1) {
    if (mask[index] !== true || text[index] !== '#') continue;
    if (index === 0 || /\s/u.test(text[index - 1])) {
      code = text.slice(0, index);
      break;
    }
  }

  // `<<WORD` / `<<-'WORD'` opens a heredoc whose body is data, not shell. `<<<` is a
  // here-string and opens nothing.
  let heredoc = null;
  for (let index = 0; index < code.length - 1; index += 1) {
    if (mask[index] !== true || code[index] !== '<' || code[index + 1] !== '<') continue;
    if (code[index + 2] === '<') {
      index += 2;
      continue;
    }
    const rest = code.slice(index + 2);
    const match = /^-?\s*(?<quote>['"]?)(?<word>[A-Za-z_][A-Za-z0-9_]*)\k<quote>/u.exec(rest);
    if (match !== null) heredoc = match.groups.word;
    break;
  }

  const { quote, frames } = syntaxMask(code, initial);
  return { code, heredoc, state: { quote, frames } };
}

// A statement is still open when a quote or `$( … )` is unclosed, or when the line ends
// on `\`, `|`, `||` or `&&` — every form of pipeline that spans body lines.
function statementIsOpen(code, state) {
  if (state.quote !== null || state.frames.length > 0) return true;
  const trimmed = code.trimEnd();
  return /(?:\\|\||&&)$/u.test(trimmed);
}

function unquote(token) {
  return token.replaceAll(/['"]/gu, '');
}

// Words of one pipe segment, with a leading `env VAR=x`-style prefix, `sudo`, `command`,
// and `time` skipped so the real command name is what gets classified.
function commandWords(segment) {
  const words = segment
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  while (words.length > 0) {
    const first = words[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(first) || ['sudo', 'command', 'env', 'time', 'exec'].includes(first)) {
      words.shift();
      continue;
    }
    break;
  }
  return words;
}

function grepStopsEarly(words) {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (GREP_ARG_TAKING.has(words[index - 1])) continue;
    if (word === '--') break;
    if (word.startsWith('--')) {
      const name = word.split('=')[0];
      if (name === '--quiet' || name === '--silent' || name === '--max-count') return true;
      continue;
    }
    if (!word.startsWith('-') || word.length < 2) continue;
    for (const flag of word.slice(1)) {
      // grep gives `q` and `m` no other meaning, so a cluster carrying either stops
      // reading its input early.
      if (flag === 'q' || flag === 'm') return true;
    }
  }
  return false;
}

// A `q` used as a sed command — `sed -n '1p;q'`, `sed 2q` — rather than a `q` inside a
// pattern or replacement, where it is preceded by `/` or a word character.
function sedStopsEarly(words) {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith('-') && word !== '--') continue;
    if (/(?:^|[;{}\s])[0-9,$~+]*q(?:[;}\s]|$)/u.test(unquote(word))) return true;
  }
  return false;
}

// The early-exit consumer this segment is, or null. Only ever asked about segments that
// have a producer piping into them.
export function earlyExitConsumer(segment) {
  const words = commandWords(segment);
  if (words.length === 0) return null;
  const command = unquote(words[0]).split('/').at(-1);

  if (command === 'head') return 'head';
  if (['grep', 'egrep', 'fgrep', 'zgrep', 'rg'].includes(command)) {
    return grepStopsEarly(words) ? `${command} -q/-m` : null;
  }
  if (command === 'sed') return sedStopsEarly(words) ? 'sed …q' : null;
  return null;
}

// ---------------------------------------------------------------------------
// Workflow structure
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// `defaults: { run: { shell: … } }` at workflow scope (column 0) and job scope
// (column 4, under `jobs:` > `<job>:`). Returned as a list of scopes ordered by the
// line they open on, so a run block resolves against the last one that encloses it.
function collectDefaultShells(lines) {
  const scopes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?<indent>\s*)defaults:\s*$/u.exec(lines[index]);
    if (match === null) continue;
    const indent = match.groups.indent.length;
    let shell = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') continue;
      if (indentOf(line) <= indent) break;
      const shellMatch = /^\s*shell:\s*(?<value>.+?)\s*$/u.exec(line);
      if (shellMatch !== null) {
        shell = unquote(shellMatch.groups.value);
        break;
      }
    }
    if (shell !== null) scopes.push({ indent, line: index, shell });
  }
  return scopes;
}

// The lines each top-level job spans, so a job-level `defaults:` is resolved against the
// steps it actually covers rather than leaking into the next job.
function collectJobRanges(lines) {
  const starts = [];
  let inJobs = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^jobs:\s*$/u.test(line)) {
      inJobs = true;
      continue;
    }
    if (indentOf(line) === 0) {
      inJobs = false;
      continue;
    }
    if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line)) starts.push(index);
  }
  return starts.map((start, position) => ({ start, end: starts[position + 1] ?? lines.length }));
}

// `shell:` from the innermost `defaults:` covering `line`: the enclosing job's, else the
// workflow's.
function inheritedShell(scopes, jobs, line) {
  const job = jobs.find((range) => line >= range.start && line < range.end);
  const jobScope =
    job === undefined
      ? undefined
      : scopes.findLast((scope) => scope.indent > 0 && scope.line >= job.start && scope.line < job.end);
  if (jobScope !== undefined) return jobScope.shell;
  return scopes.findLast((scope) => scope.indent === 0)?.shell ?? null;
}

// A `shell:` key, whether it opens its step (`- shell: bash`) or follows one.
function readShellKey(line) {
  const match = /^\s*(?:-\s+)?shell:\s*(?<value>.+?)\s*$/u.exec(line);
  return match === null ? null : unquote(match.groups.value);
}

// The `shell:` declared on the step that owns the `run:` at `runLine`. Step keys share
// the `run:` key's column, and the step opens on the `- ` one level out — so the search
// runs both ways from `run:`, since `shell:` may be declared either side of it.
//
// `opensStep` is set when `run:` is written on the dash (`- run: …`). Such a step has no
// lines above the `run:` key at all, and walking backward would cross the *previous*
// step's `run:` body — whose lines all sit at `indent > keyIndent` and are skipped —
// and return that step's `shell:`. So the backward arm is skipped entirely there.
function stepShell(lines, runLine, keyIndent, opensStep) {
  for (const direction of opensStep ? [1] : [-1, 1]) {
    for (let index = runLine + direction; index >= 0 && index < lines.length; index += direction) {
      const line = lines[index];
      if (line.trim() === '') continue;
      const indent = indentOf(line);
      if (indent > keyIndent) continue;
      if (indent < keyIndent - 1) {
        // The step opens here; its inline first key may be the `shell:` we want, and
        // nothing beyond it belongs to this step.
        if (direction === -1 && indent === keyIndent - 2 && line.trimStart().startsWith('- ')) {
          const shell = readShellKey(line);
          if (shell !== null) return shell;
        }
        break;
      }
      // Walking forward, the next step's `- ` ends this one.
      if (direction === 1 && line.trimStart().startsWith('- ')) break;
      const shell = readShellKey(line);
      if (shell !== null) return shell;
    }
  }
  return null;
}

/**
 * Every `run:` block in one workflow source: its body lines with their 1-based file
 * lines, the shell its own step declares (`declared`, `null` when it declares none), and
 * the shell GitHub will invoke it with (`null` = the runner default).
 */
export function collectRunBlocks(source) {
  const lines = source.split('\n');
  const defaultScopes = collectDefaultShells(lines);
  const jobRanges = collectJobRanges(lines);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?<indent>\s*)(?<dash>-\s+)?run:(?<rest>.*)$/u.exec(lines[index]);
    if (match === null) continue;
    const keyIndent = match.groups.indent.length + (match.groups.dash?.length ?? 0);
    const rest = match.groups.rest.trim();

    /** @type {{line: number, text: string}[]} */
    const body = [];
    if (rest.startsWith('|') || rest.startsWith('>')) {
      let bodyIndent = null;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === '') {
          body.push({ line: cursor + 1, text: '' });
          continue;
        }
        if (indentOf(line) <= keyIndent) break;
        bodyIndent ??= indentOf(line);
        body.push({ line: cursor + 1, text: line.slice(bodyIndent) });
      }
      while (body.length > 0 && body.at(-1).text === '') body.pop();
    } else if (rest !== '') {
      body.push({ line: index + 1, text: rest });
    }
    if (body.length === 0) continue;

    const declared = stepShell(lines, index, keyIndent, match.groups.dash !== undefined);
    const inherited = inheritedShell(defaultScopes, jobRanges, index);
    blocks.push({ runLine: index + 1, declared, shell: declared ?? inherited, body });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function shellIsPipeline(shell) {
  if (shell === null) return true; // the runner default is `bash -e {0}`
  const first = shell.trim().split(/\s+/u)[0].split('/').at(-1);
  return PIPELINE_SHELLS.has(first);
}

// `shell: bash` is run `bash --noprofile --norc -eo pipefail {0}`; any custom shell
// string is in scope only if it names pipefail itself.
function shellSetsPipefail(shell) {
  if (shell === null) return false;
  const trimmed = shell.trim();
  return trimmed === 'bash' || /\bpipefail\b/u.test(trimmed);
}

function pipefailToggle(statement) {
  const match = /^\s*set\s+(?<args>[^;]*)$/u.exec(statement);
  if (match === null) return null;
  const args = match.groups.args;
  if (!/\bpipefail\b/u.test(args)) return null;
  return /\+[A-Za-z]*o\s+pipefail/u.test(args) ? false : true;
}

function annotationReason(text) {
  const match = ANNOTATION.exec(text);
  if (match === null) return undefined;
  return match.groups.rest.replace(/^\s*(?:--|—|:)?\s*/u, '').trim();
}

/**
 * The body lines of one `run:` block folded into logical lines: comments stripped,
 * heredoc bodies dropped as the data they are, and continuations joined. Each carries
 * the file line the statement opened on and the allow-annotation seen on any of its
 * physical lines.
 *
 * @param {{line: number, text: string}[]} body
 * @returns {{line: number, text: string, annotation: string|undefined}[]}
 */
function logicalLines(body) {
  const lines = [];
  let pending = null;
  let state = { quote: null, frames: [] };
  let heredoc = null;

  for (const entry of body) {
    if (heredoc !== null) {
      if (entry.text.trim() === heredoc) heredoc = null;
      continue;
    }
    const scanned = scanLine(entry.text, state);
    state = scanned.state;
    heredoc = scanned.heredoc;

    pending ??= { line: entry.line, text: '', annotation: undefined };
    pending.text += (pending.text === '' ? '' : ' ') + scanned.code.replace(/\\$/u, '').trim();
    pending.annotation ??= annotationReason(entry.text);

    if (heredoc !== null || statementIsOpen(scanned.code, state)) continue;
    lines.push(pending);
    pending = null;
  }
  if (pending !== null) lines.push(pending);
  return lines;
}

/**
 * Findings for one workflow source.
 *
 * @param {string} file workflow file name, used only in the finding
 * @param {string} source
 * @returns {Finding[]}
 */
export function analyzeWorkflow(file, source) {
  /** @type {Finding[]} */
  const findings = [];

  for (const block of collectRunBlocks(source)) {
    if (!shellIsPipeline(block.shell)) continue;
    let pipefail = shellSetsPipefail(block.shell);

    const logical = logicalLines(block.body);

    // An annotation applies to the next statement, however many comment or blank lines
    // its own reasoning runs to.
    let carried;
    for (const entry of logical) {
      if (entry.annotation !== undefined) carried = entry.annotation;
      if (entry.text.trim() === '') continue;
      const statements = splitUnquoted(entry.text, [';', '&&']);
      const allowReason = carried;
      carried = undefined;

      for (const statement of statements) {
        const toggle = pipefailToggle(statement);
        if (toggle !== null) {
          pipefail = toggle;
          continue;
        }
        const orParts = splitUnquoted(statement, ['||']);
        for (const [orIndex, orPart] of orParts.entries()) {
          const guarded = orIndex < orParts.length - 1;
          const segments = splitUnquoted(orPart, ['|&', '|']);
          for (const segment of segments.slice(1)) {
            const consumer = earlyExitConsumer(segment);
            if (consumer === null) continue;
            if (guarded) continue;
            if (allowReason !== undefined) {
              if (allowReason === '') {
                findings.push({
                  file,
                  line: entry.line,
                  severity: 'error',
                  consumer,
                  statement: statement.trim(),
                  detail: 'pipefail-lint: allow annotation carries no reasoning',
                });
              }
              continue;
            }
            findings.push({
              file,
              line: entry.line,
              severity: pipefail ? 'error' : 'warning',
              consumer,
              statement: statement.trim(),
              detail: pipefail
                ? 'pipefail is in scope: the producer takes SIGPIPE once its output outruns the pipe buffer, and the pipeline reports 141'
                : 'default shell (`bash -e`): the pipeline reports only the consumer, so a failed producer is laundered',
            });
          }
        }
      }
    }
  }
  return findings;
}

/** Findings for every workflow in a directory, ordered by file then line. */
export function lintWorkflows(workflowsDir = WORKFLOWS_DIR) {
  return readdirSync(workflowsDir)
    // GitHub reads both spellings, so linting only `.yml` would leave a hole the day
    // someone adds a `.yaml`.
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .flatMap((name) => analyzeWorkflow(name, readFileSync(join(workflowsDir, name), 'utf8')));
}

function main() {
  const findings = lintWorkflows();
  const errors = findings.filter((finding) => finding.severity === 'error');

  for (const finding of findings) {
    const where = `.github/workflows/${finding.file}:${finding.line}`;
    const level = finding.severity === 'error' ? '::error' : '::warning';
    process.stdout.write(
      `${level} file=.github/workflows/${finding.file},line=${finding.line}::` +
        `unguarded pipe into ${finding.consumer} — ${finding.detail}\n` +
        `  ${where}: ${finding.statement}\n`,
    );
  }

  if (errors.length > 0) {
    process.stdout.write(
      `\n${errors.length} unguarded early-exit pipe consumer(s) under pipefail.\n` +
        'Guard the pipeline (`… || true`), read the whole input (`grep -E … > /dev/null`),\n' +
        'or annotate the site with `# pipefail-lint: allow -- <why this producer cannot fill the pipe>`.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `No unguarded early-exit pipe consumers under pipefail (${findings.length} advisory warning(s)).\n`,
  );
}

if (process.argv[1] === import.meta.filename) main();
