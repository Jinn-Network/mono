#!/usr/bin/env node
// Unguarded early-exit pipe consumers in `run:` blocks — every `.github/workflows/*.y*ml`
// and every composite `action.y*ml` in the tree.
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
import { isAbsolute, join, relative, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOWS_DIR = join(REPOSITORY_ROOT, '.github', 'workflows');

// Directories that hold no source of ours. Pruning them keeps the composite-action walk
// cheap; the `git ls-files` guard in the test suite fails if one ever hides a tracked
// action file, so the gate cannot go quietly blind to a surface it stopped reading.
const PRUNED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

// Shells whose `run:` body is a POSIX-ish pipeline language. Anything else (`pwsh`,
// `python`, `node`, …) has no `|` semantics this lint models, and is skipped whole.
const PIPELINE_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh']);

// grep options that consume the following argument, so a pattern that happens to look
// like `-q` is never read as a flag.
const GREP_ARG_TAKING = new Set(['-e', '-f', '-m', '--regexp', '--file', '--max-count']);

// grep options that stop it reading: `-q` exits at the first match, `-m N` after N of
// them, and `-l`/`-L` stop each file at its first match — on a pipe that is the same
// early exit as `-q`. grep gives none of these letters another meaning, so a cluster
// carrying one stops early.
const GREP_STOPS_SHORT = new Map([
  ['q', '-q'],
  ['m', '-m'],
  ['l', '-l'],
  ['L', '-L'],
]);
const GREP_STOPS_LONG = new Set([
  '--quiet',
  '--silent',
  '--max-count',
  '--files-with-matches',
  '--files-without-match',
]);

const SED_ARG_TAKING = new Set(['-f', '--file']);

const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const AWK_ARG_TAKING = new Set(['-v', '-f', '-F', '--assign', '--file', '--field-separator', '--source']);

// Shell reserved words that open and close a compound statement. `{`/`}` and `(`/`)` are
// handled alongside them; `do` is deliberately not an opener, because `for … ; do` puts a
// genuine top-level `;` before it and the loop is already opened by `for`.
const COMPOUND_OPENERS = new Set(['if', 'for', 'while', 'until', 'case', 'select', '{', '(']);
const COMPOUND_CLOSERS = new Set(['fi', 'done', 'esac', '}', ')']);

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

// The option that makes this grep stop reading, or null. Naming the option rather than
// the class is the point: for a lint whose whole output is "the site is here, and this is
// why", reporting `-q` on a `grep -l` would be a defect of its own.
function grepStopsEarly(words) {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (GREP_ARG_TAKING.has(words[index - 1])) continue;
    if (word === '--') break;
    if (word.startsWith('--')) {
      const name = word.split('=')[0];
      if (GREP_STOPS_LONG.has(name)) return name;
      continue;
    }
    if (!word.startsWith('-') || word.length < 2) continue;
    for (const flag of word.slice(1)) {
      const option = GREP_STOPS_SHORT.get(flag);
      if (option !== undefined) return option;
    }
  }
  return null;
}

// `s/…/…/flags`, `y/…/…/` and `/regex/` addresses are pattern text, not commands. Probing
// the raw script reads the `q` in `sed 's/ q / /'` as the quit command and reports a
// pipeline that never exits early — a false positive on a required gate, which is the
// one failure mode a lint cannot afford.
function stripSedPatterns(script) {
  return script
    .replaceAll(
      /[sy](?<delim>[^\\\s])(?:\\.|(?!\k<delim>)[^\\])*\k<delim>(?:\\.|(?!\k<delim>)[^\\])*\k<delim>[A-Za-z0-9]*/gu,
      ' ',
    )
    .replaceAll(/\/(?:\\.|[^/\\])*\//gu, ' ');
}

// A `q` used as a sed command — `sed -n '1p;q'`, `sed 2q`, `sed -n '/foo/q'` — rather
// than a `q` inside a pattern or replacement. The script is rejoined before it is probed:
// `sed 's/ q / /'` is three whitespace-separated words, and probing the middle one alone
// reads a bare `q` as the quit command.
function sedStopsEarly(words) {
  const script = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (SED_ARG_TAKING.has(word)) {
      index += 1; // `-f prog.sed` names a file, not a script this lint can read
      continue;
    }
    if (word.startsWith('-')) continue;
    script.push(word);
  }
  return /(?:^|[;{}\s])[0-9,$~+]*q(?:[;}\s]|$)/u.test(stripSedPatterns(unquote(script.join(' '))));
}

// `awk` drains its input unless its program can `exit`. The program is read as the rest
// of the segment rather than as one word, because `awk 'NR==1 {print; exit}'` splits into
// three whitespace-separated words and the `exit` is in the last of them. A program the
// lint cannot see — `awk -f prog.awk` — is left alone rather than guessed at.
function awkStopsEarly(words) {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (AWK_ARG_TAKING.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-') || word === '--') continue;
    return /\bexit\b/u.test(words.slice(index).join(' '));
  }
  return false;
}

// A group or subshell wrapping the consumer — `producer | { head -1; }`,
// `producer | ( head -1 )` — is the same early exit as the bare consumer, so look past
// the wrapper instead of classifying `{` as the command name.
function unwrapGroup(segment) {
  const match = /^\s*(?<open>[({])(?<body>.*)(?<close>[)}])\s*$/su.exec(segment);
  if (match === null) return null;
  if ((match.groups.open === '{') !== (match.groups.close === '}')) return null;
  return match.groups.body.replace(/;\s*$/u, '');
}

// The early-exit consumer this segment is, or null. Only ever asked about segments that
// have a producer piping into them.
export function earlyExitConsumer(segment) {
  const grouped = unwrapGroup(segment);
  if (grouped !== null) {
    // A guard inside the group guards the group.
    if (splitUnquoted(grouped, ['||']).length > 1) return null;
    for (const part of splitUnquoted(grouped, [';', '&&'])) {
      const consumer = earlyExitConsumer(part);
      if (consumer !== null) return consumer;
    }
    return null;
  }

  const words = commandWords(segment);
  if (words.length === 0) return null;
  const command = unquote(words[0]).split('/').at(-1);

  if (command === 'head') return 'head';
  if (['grep', 'egrep', 'fgrep', 'zgrep', 'rg'].includes(command)) {
    const option = grepStopsEarly(words);
    return option === null ? null : `${command} ${option}`;
  }
  if (command === 'sed') return sedStopsEarly(words) ? 'sed …q' : null;
  if (AWK_COMMANDS.has(command)) return awkStopsEarly(words) ? 'awk …exit' : null;
  return null;
}

// ---------------------------------------------------------------------------
// Compound statements
// ---------------------------------------------------------------------------

// One logical line as shell words and the `;` / `&&` / `||` operators between them.
// A single `|` stays inside its word: the pipeline split is `splitUnquoted`'s job, and
// only the operators that separate *statements* matter here.
function shellTokens(text) {
  const { mask } = syntaxMask(text);
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    if (mask[index] === true && /\s/u.test(text[index])) {
      index += 1;
      continue;
    }
    if (mask[index] === true) {
      const pair = text.slice(index, index + 2);
      if ((pair === '&&' || pair === '||') && mask[index + 1] === true) {
        tokens.push({ type: 'operator', value: pair, start: index, end: index + 2 });
        index += 2;
        continue;
      }
      if (text[index] === ';') {
        tokens.push({ type: 'operator', value: ';', start: index, end: index + 1 });
        index += 1;
        continue;
      }
    }
    const start = index;
    while (index < text.length) {
      if (mask[index] !== true) {
        index += 1;
        continue;
      }
      const char = text[index];
      if (/\s/u.test(char) || char === ';') break;
      if ((char === '&' || char === '|') && text[index + 1] === char && mask[index + 1] === true) break;
      index += 1;
    }
    tokens.push({ type: 'word', value: text.slice(start, index), start, end: index });
  }
  return tokens;
}

/**
 * Split one logical line into statements at nesting depth 0, on `;`, `&&` and `||`
 * together, each carrying the operator that follows it (`null` for the last).
 *
 * Splitting on `;`/`&&` first and only then on `||` — which is what this replaces — puts
 * the guard of `{ producer | head -1; } || true` in a different fragment from the
 * consumer and reports a genuinely guarded pipeline as an error. Splitting on `||` first
 * is not the fix either: `producer | head -1; other || true` would then read as guarded.
 * Only nesting tells the two apart, so an operator inside a *matched* opener/closer pair
 * is not a split point. An opener with no closer on this line — `if …; then` written
 * across body lines — matches nothing and leaves its `;` splitting exactly as before,
 * which is what keeps a multi-line compound reporting on the line that owns the site.
 */
function splitTopLevel(text) {
  const tokens = shellTokens(text);
  const enclosed = new Array(tokens.length).fill(false);
  const open = [];
  for (const [position, token] of tokens.entries()) {
    if (token.type !== 'word') continue;
    if (COMPOUND_OPENERS.has(token.value)) {
      open.push(position);
      continue;
    }
    if (COMPOUND_CLOSERS.has(token.value) && open.length > 0) {
      for (let inner = open.pop() + 1; inner < position; inner += 1) enclosed[inner] = true;
    }
  }

  const units = [];
  let start = 0;
  for (const [position, token] of tokens.entries()) {
    if (token.type !== 'operator' || enclosed[position]) continue;
    units.push({ text: text.slice(start, token.start), separator: token.value });
    start = token.end;
  }
  units.push({ text: text.slice(start), separator: null });
  return units;
}

// The body of a compound statement, or null. Unwrapping lets the guard that covers the
// compound cover its contents, and keeps the finding naming the statement inside rather
// than the whole construct.
const COMPOUNDS = [
  { open: /^\s*\{\s/u, close: /\s\}\s*$/u },
  { open: /^\s*\(/u, close: /\)\s*$/u },
  { open: /^\s*if\s/u, close: /\sfi\s*$/u },
  { open: /^\s*(?:for|while|until|select)\s/u, close: /\sdone\s*$/u },
  { open: /^\s*case\s/u, close: /\sesac\s*$/u },
];

function compoundBody(statement) {
  for (const { open, close } of COMPOUNDS) {
    const opener = open.exec(statement);
    if (opener === null) continue;
    const closer = close.exec(statement);
    const bodyStart = opener.index + opener[0].length;
    if (closer === null || closer.index < bodyStart) continue;
    return statement.slice(bodyStart, closer.index);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workflow structure
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// Which lines are the body of a block scalar (`run: |`, `script: >`, …). No YAML key can
// legally live there, so the structure readers below must not detect one: a workflow that
// writes a workflow or action fixture through a heredoc would otherwise contribute a
// phantom `defaults:` or `run:` to the lint's model of the file, and a phantom job-level
// `defaults:` escalates an entirely unrelated neighbouring step from `warning` to
// `error`. `logicalLines` already treats a heredoc body as the data it is; this is the
// same rule one level up, and it covers every heredoc, because a heredoc body written in
// a `run:` step is inside a block scalar by construction.
function blockScalarBodies(lines) {
  const inside = new Array(lines.length).fill(false);
  let bodyIndent = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (bodyIndent !== null) {
      if (line.trim() === '' || indentOf(line) > bodyIndent) {
        inside[index] = true;
        continue;
      }
      bodyIndent = null;
    }
    const match = /^(?<indent>\s*)(?<dash>-\s+)?[A-Za-z0-9_.-]+:\s*[|>][+-]?[0-9]*\s*(?:#.*)?$/u.exec(line);
    if (match !== null) bodyIndent = match.groups.indent.length + (match.groups.dash?.length ?? 0);
  }
  return inside;
}

// `shell:` inside a flow mapping — `defaults: { run: { shell: bash } }`, or a block
// `defaults:` whose `run:` is written flow-style. Both are legal YAML that the block-form
// reader alone misses, and missing one silently downgrades a real site to a warning.
const FLOW_SHELL = /\bshell:\s*(?<value>[^,}]+?)\s*(?:[,}]|$)/u;

// `defaults: { run: { shell: … } }` at workflow scope (column 0) and job scope
// (column 4, under `jobs:` > `<job>:`). Returned as a list of scopes ordered by the
// line they open on, so a run block resolves against the last one that encloses it.
function collectDefaultShells(lines, inside) {
  const scopes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (inside[index]) continue;
    const match = /^(?<indent>\s*)defaults:\s*(?<flow>\{.*\})?\s*(?:#.*)?$/u.exec(lines[index]);
    if (match === null) continue;
    const indent = match.groups.indent.length;
    let shell = null;
    if (match.groups.flow !== undefined) {
      const flow = FLOW_SHELL.exec(match.groups.flow);
      if (flow !== null) shell = unquote(flow.groups.value);
    } else {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === '' || inside[cursor]) continue;
        if (indentOf(line) <= indent) break;
        const shellMatch = /^\s*shell:\s*(?<value>.+?)\s*$/u.exec(line);
        if (shellMatch !== null) {
          shell = unquote(shellMatch.groups.value);
          break;
        }
        const flow = FLOW_SHELL.exec(line);
        if (flow !== null) {
          shell = unquote(flow.groups.value);
          break;
        }
      }
    }
    if (shell !== null) scopes.push({ indent, line: index, shell });
  }
  return scopes;
}

// The lines each top-level job spans, so a job-level `defaults:` is resolved against the
// steps it actually covers rather than leaking into the next job.
function collectJobRanges(lines, inside) {
  const starts = [];
  let inJobs = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#') || inside[index]) continue;
    // A trailing comment is legal on any of these keys, and missing `jobs: # all lanes`
    // costs every job-level `defaults:` in the file its scope.
    if (/^jobs:\s*(?:#.*)?$/u.test(line)) {
      inJobs = true;
      continue;
    }
    if (indentOf(line) === 0) {
      inJobs = false;
      continue;
    }
    if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*(?:#.*)?$/u.test(line)) starts.push(index);
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
function stepShell(lines, inside, runLine, keyIndent, opensStep) {
  for (const direction of opensStep ? [1] : [-1, 1]) {
    for (let index = runLine + direction; index >= 0 && index < lines.length; index += direction) {
      const line = lines[index];
      if (line.trim() === '' || inside[index]) continue;
      const indent = indentOf(line);
      if (indent > keyIndent) continue;
      if (indent < keyIndent - 1) {
        // The step opens here; its inline first key may be the `shell:` we want, and
        // nothing beyond it belongs to this step. The dash may be followed by any run of
        // spaces — `-   shell: bash` is legal YAML — so the opener is recognised by the
        // column its first key lands in, not by a fixed two-character `- `.
        const opener = /^(?<lead>\s*-\s+)\S/u.exec(line);
        if (direction === -1 && opener !== null && opener.groups.lead.length === keyIndent) {
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
  const inside = blockScalarBodies(lines);
  const defaultScopes = collectDefaultShells(lines, inside);
  const jobRanges = collectJobRanges(lines, inside);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (inside[index]) continue;
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

    const declared = stepShell(lines, inside, index, keyIndent, match.groups.dash !== undefined);
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

// GitHub invokes `bash --noprofile --norc -eo pipefail {0}` for `shell: bash`, `sh -e {0}`
// for `shell: sh`, and `bash -e {0}` when a step declares no shell. Only the shells that
// do *not* set pipefail reach this, so name the one that actually laundered the producer
// rather than always saying `bash`.
function invokedShellLabel(shell) {
  if (shell === null) return 'default shell (`bash -e`)';
  const trimmed = shell.trim();
  const name = trimmed.split(/\s+/u)[0].split('/').at(-1);
  return trimmed === name ? `\`${name} -e\`` : `\`${trimmed}\``;
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
  // Whether the heredoc's opener line left its statement genuinely open. `cat <<EOF` is
  // structurally complete at the opener, so the line after the terminator starts a new
  // statement; `cat <<EOF |` ends on a pipe and must keep spanning the body to stay one
  // pipeline. Carrying the opener's own answer across the skipped body is what keeps the
  // terminator from swallowing the next statement — which mis-attributed the finding to
  // the opener's line and ate any allow annotation written above the real site.
  let heredocOpenerOpen = false;

  for (const entry of body) {
    if (heredoc !== null) {
      if (entry.text.trim() !== heredoc) continue;
      heredoc = null;
      if (heredocOpenerOpen || pending === null) continue;
      lines.push(pending);
      pending = null;
      continue;
    }
    const scanned = scanLine(entry.text, state);
    state = scanned.state;
    heredoc = scanned.heredoc;

    pending ??= { line: entry.line, text: '', annotation: undefined };
    pending.text += (pending.text === '' ? '' : ' ') + scanned.code.replace(/\\$/u, '').trim();
    pending.annotation ??= annotationReason(entry.text);

    if (heredoc !== null) {
      heredocOpenerOpen = statementIsOpen(scanned.code, state);
      continue;
    }
    if (statementIsOpen(scanned.code, state)) continue;
    lines.push(pending);
    pending = null;
  }
  if (pending !== null) lines.push(pending);
  return lines;
}

/**
 * Walk one logical line's statements, honouring nesting: a `||` guard written after a
 * compound guards everything inside it. A compound is unwrapped and re-walked so the
 * finding still names the statement that owns the pipeline.
 *
 * @param {string} text
 * @param {boolean} guarded
 * @param {{pipefail: boolean, report: (statement: string, consumer: string) => void}} context
 */
function scanStatements(text, guarded, context) {
  for (const unit of splitTopLevel(text)) {
    const statement = unit.text;
    if (statement.trim() === '') continue;
    const unitGuarded = guarded || unit.separator === '||';

    const toggle = pipefailToggle(statement);
    if (toggle !== null) {
      context.pipefail = toggle;
      continue;
    }

    const body = compoundBody(statement);
    if (body !== null) {
      scanStatements(body, unitGuarded, context);
      continue;
    }
    if (unitGuarded) continue;

    for (const segment of splitUnquoted(statement, ['|&', '|']).slice(1)) {
      const consumer = earlyExitConsumer(segment);
      if (consumer !== null) context.report(statement.trim(), consumer);
    }
  }
}

/**
 * Findings for one workflow or composite-action source.
 *
 * @param {string} file path used in the finding and in the GitHub annotation
 * @param {string} source
 * @param {{defaultShell?: string|null}} [options] `defaultShell` is the shell a step with
 *   no resolvable `shell:` runs under. `null` (a workflow) is the runner default; a
 *   composite action passes `bash`, because GitHub *requires* every composite `run:` step
 *   to declare one — so an unresolved shell there is this reader failing, and the safe
 *   default is pipefail in scope.
 * @returns {Finding[]}
 */
export function analyzeWorkflow(file, source, { defaultShell = null } = {}) {
  /** @type {Finding[]} */
  const findings = [];

  for (const block of collectRunBlocks(source)) {
    const shell = block.shell ?? defaultShell;
    if (!shellIsPipeline(shell)) continue;
    const context = { pipefail: shellSetsPipefail(shell), report: () => {} };

    const logical = logicalLines(block.body);

    // An annotation applies to the next statement, however many comment or blank lines
    // its own reasoning runs to.
    let carried;
    for (const entry of logical) {
      if (entry.annotation !== undefined) {
        carried = entry.annotation;
        // The hatch may never be used without a reason. Reporting this only from inside
        // the finding loop left it unenforced in the one placement where the annotation
        // is inert — written above a statement that has nothing to silence.
        if (entry.annotation === '') {
          findings.push({
            file,
            line: entry.line,
            severity: 'error',
            consumer: 'pipefail-lint: allow',
            statement: entry.text.trim() === '' ? '# pipefail-lint: allow' : entry.text.trim(),
            detail: 'pipefail-lint: allow annotation carries no reasoning',
          });
        }
      }
      if (entry.text.trim() === '') continue;
      const allowReason = carried;
      carried = undefined;

      context.report = (statement, consumer) => {
        if (allowReason !== undefined) return;
        findings.push({
          file,
          line: entry.line,
          severity: context.pipefail ? 'error' : 'warning',
          consumer,
          statement,
          detail: context.pipefail
            ? 'pipefail is in scope: the producer takes SIGPIPE once its output outruns the pipe buffer, and the pipeline reports 141'
            : `${invokedShellLabel(shell)}: the pipeline reports only the consumer, so a failed producer is laundered`,
        });
      };
      scanStatements(entry.text, false, context);
    }
  }
  return findings;
}

/** Whether a directory entry is a workflow source. GitHub reads both spellings. */
export function isWorkflowSource(name) {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

// The path a finding names: repository-relative inside the repository, so the GitHub
// annotation points at the file; the bare name for a corpus outside it.
function displayPath(directory, name) {
  const path = relative(REPOSITORY_ROOT, join(directory, name));
  return path.startsWith('..') || isAbsolute(path) ? name : path;
}

/** Findings for every workflow in a directory, ordered by file then line. */
export function lintWorkflows(workflowsDir = WORKFLOWS_DIR) {
  return readdirSync(workflowsDir)
    .filter((name) => isWorkflowSource(name))
    .sort()
    .flatMap((name) =>
      analyzeWorkflow(displayPath(workflowsDir, name), readFileSync(join(workflowsDir, name), 'utf8')),
    );
}

/** Every `action.yml` / `action.yaml` in the tree, as repository-relative paths. */
export function findActionFiles(root = REPOSITORY_ROOT) {
  /** @type {string[]} */
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not a place a composite action of ours lives
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!PRUNED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && (entry.name === 'action.yml' || entry.name === 'action.yaml')) {
        found.push(relative(root, join(directory, entry.name)));
      }
    }
  };
  walk(root);
  return found.sort();
}

function isCompositeAction(source) {
  return /^\s*using:\s*(?<quote>['"]?)composite\k<quote>\s*(?:#.*)?$/mu.test(source);
}

/**
 * Findings for every composite action in the tree.
 *
 * A composite action is the highest-density pipefail surface there is: GitHub requires
 * each of its `run:` steps to declare `shell:`, so every pipeline in one is in scope by
 * construction. Reading only `.github/workflows` left that surface unscanned, with no
 * signal on the day the first composite action lands.
 */
export function lintCompositeActions(root = REPOSITORY_ROOT) {
  return findActionFiles(root).flatMap((path) => {
    const source = readFileSync(join(root, path), 'utf8');
    return isCompositeAction(source) ? analyzeWorkflow(path, source, { defaultShell: 'bash' }) : [];
  });
}

/** Findings for the whole repository: workflows and composite actions. */
export function lintRepository(root = REPOSITORY_ROOT) {
  return [...lintWorkflows(join(root, '.github', 'workflows')), ...lintCompositeActions(root)];
}

function main() {
  const findings = lintRepository();
  const errors = findings.filter((finding) => finding.severity === 'error');

  for (const finding of findings) {
    const where = `${finding.file}:${finding.line}`;
    const level = finding.severity === 'error' ? '::error' : '::warning';
    process.stdout.write(
      `${level} file=${finding.file},line=${finding.line}::` +
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
