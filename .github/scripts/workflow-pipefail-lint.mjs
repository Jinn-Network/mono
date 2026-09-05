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
//   - the default `bash -e {0}` (or `sh -e {0}`) -> warning; printed, but not this
//     gate's failure. A bare `-e` pipeline reports only the last command's status, so it
//     launders a failed producer rather than inventing a failure (the PR #2819 finding).
//   - a composite action's step -> error even with no shell resolved. GitHub requires
//     every composite `run:` step to declare `shell:`, so an unresolved one is this
//     reader failing rather than a step running under the default.
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

// Trees that can never hold a composite action of ours. Deliberately only these three:
// a name like `dist` or `build` matches at *any* depth, so pruning it would hide
// `.github/actions/build/action.yml` — a real place to put one — and the discovery guard
// would then report a hole the walker itself had created. Dependency and VCS trees carry
// no such ambiguity. The `git ls-files` guard in the test suite still fails if one of
// these ever hides a tracked action file.
const PRUNED_DIRECTORIES = new Set(['.git', '.yarn', 'node_modules']);

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
// Matching by kind, rather than letting any closer pop any opener, is what keeps a
// `case` arm's `a)` from closing the `case` itself. Parens are recognised from the token
// text instead (see `tokenCompound`), because `(printf …` and `… echo yes)` glue the
// bracket to a word.
const OPENER_KIND = new Map([
  ['if', 'if'],
  ['for', 'loop'],
  ['while', 'loop'],
  ['until', 'loop'],
  ['select', 'loop'],
  ['case', 'case'],
  ['{', 'brace'],
]);
const CLOSER_KIND = new Map([
  ['fi', 'if'],
  ['done', 'loop'],
  ['esac', 'case'],
  ['}', 'brace'],
]);

const ANNOTATION = /#\s*pipefail-lint:\s*allow\b(?<rest>.*)$/u;

/**
 * @typedef {object} Finding
 * @property {string} file      path of the workflow or composite action
 * @property {number} line      1-based line in that file
 * @property {'pipe'|'annotation'} kind what was found — an unguarded pipe, or a misuse
 *   of the escape hatch itself. They read as different sentences, so the reporter must
 *   not describe an annotation as a pipe into a consumer.
 * @property {'error'|'warning'} severity
 * @property {string|null} consumer the early-exit consumer, e.g. `grep -q`; `null` for
 *   an annotation finding
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

// `/…/` regex literals and `"…"` strings inside an awk program are text, not code, so
// they are stripped before the probe below: `awk '/exit code/{print}'` and
// `awk '{print "exit"}'` read their whole input, and reporting either would be a false
// positive on a required gate. The same reasoning as `stripSedPatterns`.
function stripAwkLiterals(program) {
  return program
    .replaceAll(/\/(?:\\.|[^/\\\n])*\//gu, ' ')
    .replaceAll(/"(?:\\.|[^"\\])*"/gu, ' ');
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
    return /\bexit\b/u.test(stripAwkLiterals(words.slice(index).join(' ')));
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
    tokens.push({
      type: 'word',
      value: text.slice(start, index),
      start,
      end: index,
      // A shell-syntax `(`/`)` glued to the word. `$( … )` is transparent to the mask, so
      // its brackets are not shell syntax here and a command substitution neither opens
      // nor closes a compound.
      opensParen: mask[start] === true && text[start] === '(',
      closesParen: mask[index - 1] === true && text[index - 1] === ')',
    });
  }
  return tokens;
}

// Words after which the shell begins a new command, so a reserved word standing there
// is a keyword rather than an argument. `|` and `&` stay inside a word token, only `&&`,
// `||` and `;` being operators.
const COMMAND_POSITION_WORDS = new Set(['(', '|', '&', '!', 'then', 'else', 'elif', 'do', '{', 'time']);

const BRACE_TOKENS = new Set(['{', '}']);

function leadsStatement(previous) {
  if (previous === undefined) return true;
  if (previous.type === 'operator') return true;
  // A `case` arm pattern — `a)`, `*)`, `b|c)` — ends the word it is glued to, and the arm
  // body begins right after it. Without this a compound leading an arm was read as an
  // argument, which is the same false red this positional rule exists to remove.
  if (previous.closesParen === true) return true;
  return COMMAND_POSITION_WORDS.has(previous.value);
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
function tokenCompound(token, previous) {
  if (token.type !== 'word') return null;
  // `(cmd)` written with no spaces is self-contained: it can hold no top-level separator,
  // so counting it would only unbalance the depth.
  if (token.opensParen && token.closesParen) return null;
  if (token.opensParen) return { role: 'open', kind: 'paren' };
  if (token.closesParen) return { role: 'close', kind: 'paren' };
  // A reserved *word* is only a compound keyword where a statement may begin. Classifying
  // it by value alone made `grep -w case file` push a `case` nothing ever popped, and the
  // enclosing subshell's genuinely guarded `)` was then read as that phantom `case`'s arm
  // terminator and skipped — so the guard never retracted the pipeline it covered. `{`
  // and `}` are punctuation rather than words: they are exempt, because a function
  // definition writes its `{` after the `()` that no rule can call a command position.
  const positional = BRACE_TOKENS.has(token.value) || leadsStatement(previous);
  const opener = OPENER_KIND.get(token.value);
  if (opener !== undefined) return positional ? { role: 'open', kind: opener } : null;
  const closer = CLOSER_KIND.get(token.value);
  if (closer === undefined) return null;
  return positional ? { role: 'close', kind: closer } : null;
}

function matchCompounds(tokens) {
  const enclosed = new Array(tokens.length).fill(false);
  /** @type {{position: number, kind: string}[]} */
  const open = [];
  /** @type {{kind: string, guarded: boolean}[]} */
  const unmatchedClosers = [];
  for (const [position, token] of tokens.entries()) {
    const compound = tokenCompound(token, tokens[position - 1]);
    if (compound === null) continue;
    if (compound.role === 'open') {
      open.push({ position, kind: compound.kind });
      continue;
    }
    const depth = open.findLastIndex((entry) => entry.kind === compound.kind);
    if (depth === -1) {
      // A `)` with no `(` before it, written where a `case` is the innermost thing open,
      // is that `case`'s arm terminator — the only unmatched `)` a `case` can hold. It
      // closes nothing, so reporting it let it pop an enclosing subshell instead, and the
      // subshell's real `)` then closed nothing in turn and its guard never reached the
      // arm. A subshell opened *inside* the arm is matched by kind above and never
      // reaches here.
      if (compound.kind === 'paren' && open.at(-1)?.kind === 'case') continue;
      // A closer with no opener on this line closes a compound that began on an earlier
      // body line. Whether a `||` follows it is what says that compound is guarded; the
      // kind is what says which one; and `start` is what says which of this line's own
      // findings stand before it and are therefore inside it.
      const next = tokens[position + 1];
      unmatchedClosers.push({
        kind: compound.kind,
        guarded: next !== undefined && next.type === 'operator' && next.value === '||',
        start: token.start,
      });
      continue;
    }
    for (let inner = open[depth].position + 1; inner < position; inner += 1) enclosed[inner] = true;
    open.length = depth;
  }
  return { enclosed, unmatchedClosers, unmatchedOpeners: open };
}

/**
 * Whether the opener at `position` is the group of a function *definition* — `f () {`,
 * `f() (`, `function f {`. A `||` written after a definition guards defining the
 * function, which cannot fail; the body runs unguarded whenever the function is later
 * called, so the guard must not reach into it.
 */
function opensDefinition(text, tokens, position) {
  let statementStart = 0;
  for (let index = position - 1; index >= 0; index -= 1) {
    if (tokens[index].type === 'operator') {
      statementStart = tokens[index].end;
      break;
    }
  }
  const prefix = text.slice(statementStart, tokens[position].start);
  // `definitionPrefixLength` only counts a prefix that a group actually opens behind, so
  // the opener token is stood in for by a `{`; the prefix is a definition's when the
  // match consumes all of it.
  return prefix.trim() !== '' && definitionPrefixLength(`${prefix}{`) === prefix.length;
}

/**
 * How one logical line changes the compound nesting the *block* is in, for the compounds
 * it does not open and close by itself. `openerFirst` says the line's leading token is
 * the unmatched opener — `if producer | head -1; then` — so a guard on the eventual
 * closer covers findings on this line too, whereas in `producer | head -1; if x; then`
 * the pipeline stands outside the compound the line opens.
 */
function lineNesting(text) {
  const tokens = shellTokens(text);
  const { unmatchedClosers, unmatchedOpeners } = matchCompounds(tokens);
  const first = tokens[0];
  return {
    unmatchedClosers,
    unmatchedOpeners: unmatchedOpeners.map((entry) => ({
      kind: entry.kind,
      definition: opensDefinition(text, tokens, entry.position),
    })),
    openerFirst: first !== undefined && tokenCompound(first, undefined)?.role === 'open',
  };
}

function splitTopLevel(text) {
  const tokens = shellTokens(text);
  const { enclosed } = matchCompounds(tokens);

  const units = [];
  let start = 0;
  for (const [position, token] of tokens.entries()) {
    if (token.type !== 'operator' || enclosed[position]) continue;
    units.push({ text: text.slice(start, token.start), separator: token.value, offset: start });
    start = token.end;
  }
  units.push({ text: text.slice(start), separator: null, offset: start });
  return units;
}

// The body of a compound statement, or null. Unwrapping lets the guard that covers the
// compound cover its contents, and keeps the finding naming the statement inside rather
// than the whole construct.
//
// `carries` says whether a `set ±o pipefail` written in the body may reach the statements
// after the closing token. Only the brace group runs in the current shell *and*
// unconditionally; a subshell scopes the flag to a child shell, and an `if`, `case` or
// loop body may never run at all — so a toggle in any of those is read and dropped rather
// than allowed to move the boundary for code it does not govern.
const COMPOUNDS = [
  { open: /^\s*\{\s/u, close: /\s\}\s*$/u, carries: true },
  { open: /^\s*\(/u, close: /\)\s*$/u, carries: false },
  { open: /^\s*if\s/u, close: /\sfi\s*$/u, carries: false },
  { open: /^\s*(?:for|while|until|select)\s/u, close: /\sdone\s*$/u, carries: false },
  { open: /^\s*case\s/u, close: /\sesac\s*$/u, carries: false },
];

// The `f ()` / `function f` / `function f ()` prefix standing before a definition's group,
// as its length in characters, or 0. Without skipping it `compoundBody` never sees the
// opener, the definition falls through to the simple-pipeline branch, and splitting its
// raw text on `|` cuts an inner `||` in half and loses the guard entirely — a false
// positive on a required gate. The parentheses are what mark a definition unless
// `function` is written, so `f { …; }` stays the command with a brace-group argument that
// it is. A definition's body is never `carries`: defining a function does not run it.
const DEFINITION_PREFIX = /^\s*(?:function\s+[^\s(){}]+\s*(?:\(\s*\)\s*)?|[^\s(){}]+\s*\(\s*\)\s*)/u;

function definitionPrefixLength(statement) {
  const match = DEFINITION_PREFIX.exec(statement);
  if (match === null) return 0;
  // The prefix only counts when a group actually opens behind it; otherwise the leading
  // word is an ordinary command and the statement is not a definition at all.
  const rest = statement.slice(match[0].length);
  return /^[({]/u.test(rest) ? match[0].length : 0;
}

function compoundBody(statement) {
  const skip = definitionPrefixLength(statement);
  const text = statement.slice(skip);
  for (const { open, close, carries } of COMPOUNDS) {
    const opener = open.exec(text);
    if (opener === null) continue;
    const closer = close.exec(text);
    const bodyStart = opener.index + opener[0].length;
    if (closer === null || closer.index < bodyStart) continue;
    return {
      body: text.slice(bodyStart, closer.index),
      carries: skip === 0 && carries,
      // A definition's body does not run where it is written, so a guard on the
      // definition does not cover it. `deferred` is what stops that guard being handed
      // down; `offset` places the body back in the line it was cut from.
      deferred: skip > 0,
      offset: skip + bodyStart,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workflow structure
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// One YAML scalar value. A `#` preceded by whitespace opens a comment, so `shell: bash #
// see below` is the value `bash` — reading the comment as part of the shell string makes
// `shellSetsPipefail` miss the `bash` and downgrades a real pipefail site to a warning,
// which is a fail-open on the gate.
function scalarValue(text) {
  const quoted = /^(?<quote>['"])(?<value>.*?)\k<quote>\s*(?:#.*)?$/u.exec(text.trim());
  if (quoted !== null) return quoted.groups.value;
  return text.replace(/\s+#.*$/u, '').trim();
}

// A block scalar header — `key: |`, `- run: >-`, `script: |2` — with any chomping or
// indentation indicator, and the comment YAML allows after one.
const BLOCK_SCALAR_KEY =
  /^(?<indent>\s*)(?<dash>-\s+)?[\w.-]+:\s*[|>][-+0-9]*\s*(?:#.*)?$/u;

// The lines that are the *content* of a block scalar rather than structure of the file.
//
// A block scalar's body is a string, so every `defaults:`, `shell:` and `run:` written
// inside one is text. Read as structure, a workflow that writes a workflow — through a
// heredoc, a `printf`, anything — donates phantom keys to this lint's model of the file:
// an embedded `defaults:` is adopted as a job scope and escalates an unrelated
// neighbouring step from `warning` to `error`, and an embedded `- run: |` mints a step
// that does not exist. Neither has an honest allow annotation to write, because the site
// the lint reports is not the site that caused it.
//
// `logicalLines` already treats a heredoc body as data inside one run block; this is the
// same rule one level up. Masking the whole body rather than tracking heredocs again here
// covers every shape that can carry phantom structure, not only the heredoc-shaped one,
// and keeps the shell scanner the only place that knows what a heredoc is.
//
// Only the two readers that match at any indent — `collectDefaultShells` and the `run:`
// key scan — consult it. `collectJobRanges` wants a key at exactly column 2 and
// `stepShell` skips anything indented past the `run:` key it started from, and a body
// line is by definition indented past its own key, so neither can see one.
function blockScalarBodies(lines) {
  const inside = new Array(lines.length).fill(false);
  for (let index = 0; index < lines.length; index += 1) {
    // A header nested inside another body has already been masked; its body is covered
    // by the enclosing one.
    if (inside[index]) continue;
    const match = BLOCK_SCALAR_KEY.exec(lines[index]);
    if (match === null) continue;
    // The body is indented past the key's own column, which for `- run: |` is the key
    // rather than the dash — the same measurement `collectRunBlocks` makes of its own
    // `run:` key, so the mask ends exactly where that reader's body does.
    const keyIndent = match.groups.indent.length + (match.groups.dash?.length ?? 0);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
      inside[cursor] = true;
    }
  }
  return inside;
}

// `shell:` inside a flow mapping — `defaults: { run: { shell: bash } }`, or a block
// `defaults:` whose `run:` is written flow-style. Both are legal YAML that the block-form
// reader alone misses, and missing one silently downgrades a real site to a warning.
//
// FLOW_SHELL is only ever applied to text already known to be *inside* the braces.
// Applying it to a whole line reads `# shell: sh was the old setting` as a declaration
// and lets a comment beat the real key below it — a fail-open when the comment names a
// weaker shell, and a gate-failing false positive when it names a stronger one.
const FLOW_SHELL = /\bshell:\s*(?<value>[^,}]+?)\s*(?:[,}]|$)/u;
const FLOW_MAPPING = /^\s*[A-Za-z0-9_.-]+:\s*(?<flow>\{.*\})\s*(?:#.*)?$/u;

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
      if (flow !== null) shell = scalarValue(flow.groups.value);
    } else {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === '' || line.trimStart().startsWith('#') || inside[cursor]) continue;
        if (indentOf(line) <= indent) break;
        const shellMatch = /^\s*shell:\s*(?<value>.+?)\s*$/u.exec(line);
        if (shellMatch !== null) {
          shell = scalarValue(shellMatch.groups.value);
          break;
        }
        const mapping = FLOW_MAPPING.exec(line);
        const flow = mapping === null ? null : FLOW_SHELL.exec(mapping.groups.flow);
        if (flow !== null) {
          shell = scalarValue(flow.groups.value);
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
function collectJobRanges(lines) {
  const starts = [];
  let inJobs = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
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
  if (match === null) return null;
  const value = scalarValue(match.groups.value);
  return value === '' ? null : value;
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
  const jobRanges = collectJobRanges(lines);
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

// GitHub invokes `bash --noprofile --norc -eo pipefail {0}` for `shell: bash`, `sh -e {0}`
// for `shell: sh`, and `bash -e {0}` when a step declares no shell. Only the shells that
// do *not* set pipefail reach this, so name the one that actually laundered the producer
// rather than always saying `bash` — and name it as GitHub writes it, `{0}` included, so
// the advisory can be matched against the workflow syntax it is talking about.
function invokedShellLabel(shell) {
  if (shell === null) return 'default shell (`bash -e`)';
  const trimmed = shell.trim();
  const name = trimmed.split(/\s+/u)[0].split('/').at(-1);
  return trimmed === name ? `\`${name} -e {0}\`` : `\`${trimmed}\``;
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
 * Which unit of a list the operator after it guards. `||` guards the unit to its left, and
 * `&&` passes that guard further left, because `a && b || true` is `(a && b) || true` — a
 * failing `a` short-circuits into the same `|| true`. Reading only the immediate operator
 * reported `producer | head -1 && echo hit || true` as an error it could not honestly
 * clear.
 */
function guardFlags(units) {
  const guarded = new Array(units.length).fill(false);
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const separator = units[index].separator;
    guarded[index] = separator === '||' || (separator === '&&' && (guarded[index + 1] ?? false));
  }
  return guarded;
}

/**
 * Walk one logical line's statements, honouring nesting: a `||` guard written after a
 * compound guards everything inside it. A compound is unwrapped and re-walked so the
 * finding still names the statement that owns the pipeline.
 *
 * `scope` says what a `set ±o pipefail` found here may do. At `'top'` it moves the
 * boundary as it always has. Unwrapping compounds made nested toggles visible to the walk
 * for the first time, and honouring those unconditionally would let a `set +o pipefail`
 * written inside a branch that never runs downgrade every later pipeline from `error` to
 * `warning` — the required lane going green over a genuinely exposed site. So a nested
 * toggle may only ever tighten the verdict, and only from a compound that runs in the
 * current shell (`'carry'`); everywhere else it is read and dropped (`'sealed'`).
 *
 * @param {string} text
 * @param {boolean} guarded
 * @param {{pipefail: boolean, report: (statement: string, consumer: string, offset: number) => void}} context
 * @param {'top'|'carry'|'sealed'} [scope]
 * @param {number} [base] where `text` starts in the logical line, so a finding can be
 *   placed against the compound closers written on that line
 */
function scanStatements(text, guarded, context, scope = 'top', base = 0) {
  const units = splitTopLevel(text);
  const guards = guardFlags(units);

  for (const [index, unit] of units.entries()) {
    const statement = unit.text;
    if (statement.trim() === '') continue;
    const offset = base + unit.offset;
    const unitGuarded = guarded || guards[index];

    const toggle = pipefailToggle(statement);
    if (toggle !== null) {
      if (scope === 'top' || (scope === 'carry' && toggle)) context.pipefail = toggle;
      continue;
    }

    const compound = compoundBody(statement);
    if (compound !== null) {
      const nestedScope = scope !== 'sealed' && compound.carries ? 'carry' : 'sealed';
      scanStatements(
        compound.body,
        compound.deferred ? false : unitGuarded,
        context,
        nestedScope,
        offset + compound.offset,
      );
      continue;
    }
    if (unitGuarded) continue;

    for (const segment of splitUnquoted(statement, ['|&', '|']).slice(1)) {
      const consumer = earlyExitConsumer(segment);
      if (consumer !== null) context.report(statement.trim(), consumer, offset);
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

    // `splitTopLevel` resolves a compound written on one line. A compound written across
    // body lines — the ordinary spelling — needs the same guard honoured across them, so
    // findings are collected per block and those inside a compound whose closing line
    // carries the `|| …` are retracted before they are reported. Without this,
    // `{`/`producer | head -1`/`} || true` reddens a required gate over a pipeline that
    // is guarded, which is the defect this sweep exists to remove.
    /** @type {Finding[]} */
    const blockFindings = [];
    // How many function definitions each finding was written inside, so a guard on a
    // compound *outside* one cannot retract it while a guard inside one still can.
    /** @type {number[]} */
    const findingDepths = [];
    // This logical line's findings and where on it they stand, so a closer written
    // mid-line retracts what precedes it and leaves what follows it alone.
    /** @type {{index: number, offset: number}[]} */
    let lineFindings = [];
    /** @type {{kind: string, definition: boolean, findingIndex: number}[]} */
    const openCompounds = [];
    /** @type {[number, number, number][]} */
    const guardedRanges = [];

    const pushFinding = (finding, offset) => {
      lineFindings.push({ index: blockFindings.length, offset });
      findingDepths.push(openCompounds.filter((entry) => entry.definition).length);
      blockFindings.push(finding);
    };

    // One logical line's effect on the compounds the *block* is inside. Run after the
    // line is scanned, so `openerFirst` decides whether this line's own findings sit
    // inside the compound it opens: they do for `if producer | head -1; then`, and they
    // do not for `producer | head -1; if x; then`.
    const trackNesting = (text, beforeEntry) => {
      const nesting = lineNesting(text);
      for (const closer of nesting.unmatchedClosers) {
        const depth = openCompounds.findLastIndex((entry) => entry.kind === closer.kind);
        if (depth === -1) continue; // a closer with no opener
        // A `case` opened after the innermost open `(` makes this `)` that `case`'s arm
        // terminator rather than the subshell's closer.
        if (closer.kind === 'paren' && openCompounds.findLastIndex((entry) => entry.kind === 'case') > depth) {
          continue;
        }
        const opened = openCompounds[depth];
        const definitionsBelow = openCompounds.slice(0, depth).filter((entry) => entry.definition).length;
        openCompounds.length = depth;
        if (!closer.guarded) continue;
        // The range ends at the closer, not at the end of its line: a statement written
        // after the closer is outside the compound — it is the `||` fallback itself —
        // and retracting it lost a genuinely unguarded pipeline.
        const end = lineFindings.find((entry) => entry.offset >= closer.start)?.index ?? blockFindings.length;
        guardedRanges.push([opened.findingIndex, end, definitionsBelow]);
      }
      for (const { kind, definition } of nesting.unmatchedOpeners) {
        openCompounds.push({
          kind,
          definition,
          findingIndex: nesting.openerFirst ? beforeEntry : blockFindings.length,
        });
      }
    };

    const logical = logicalLines(block.body);

    // An annotation applies to the next statement, however many comment or blank lines
    // its own reasoning runs to.
    let carried;
    for (const entry of logical) {
      const beforeEntry = blockFindings.length;
      lineFindings = [];
      if (entry.annotation !== undefined) {
        carried = entry.annotation;
        // The hatch may never be used without a reason. Reporting this only from inside
        // the finding loop left it unenforced in the one placement where the annotation
        // is inert — written above a statement that has nothing to silence.
        if (entry.annotation === '') {
          pushFinding(
            {
              file,
              line: entry.line,
              kind: 'annotation',
              severity: 'error',
              consumer: null,
              statement: entry.text.trim() === '' ? '# pipefail-lint: allow' : entry.text.trim(),
              detail: 'pipefail-lint: allow annotation carries no reasoning',
            },
            0,
          );
        }
      }
      if (entry.text.trim() === '') {
        trackNesting(entry.text, beforeEntry);
        continue;
      }
      const allowReason = carried;
      carried = undefined;

      context.report = (statement, consumer, offset) => {
        if (allowReason !== undefined) return;
        pushFinding(
          {
            file,
            line: entry.line,
            kind: 'pipe',
            severity: context.pipefail ? 'error' : 'warning',
            consumer,
            statement,
            detail: context.pipefail
              ? 'pipefail is in scope: the producer takes SIGPIPE once its output outruns the pipe buffer, and the pipeline reports 141'
              : `${invokedShellLabel(shell)}: the pipeline reports only the consumer, so a failed producer is laundered`,
          },
          offset,
        );
      };
      scanStatements(entry.text, false, context);
      trackNesting(entry.text, beforeEntry);
    }

    for (const [index, finding] of blockFindings.entries()) {
      // A reasonless annotation is a violation of the hatch itself, not a pipeline a
      // guard can excuse, so it is never retracted.
      const guarded =
        finding.kind === 'pipe' &&
        guardedRanges.some(
          ([start, end, definitionsBelow]) =>
            index >= start && index < end && findingDepths[index] <= definitionsBelow,
        );
      if (!guarded) findings.push(finding);
    }
  }
  return findings;
}

/** Whether a directory entry is a workflow source. GitHub reads both spellings. */
export function isWorkflowSource(name) {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

/**
 * The path a finding names: repository-relative inside the repository, so the
 * `::error file=…` annotation attaches to the file in the GitHub UI; the bare name for a
 * corpus outside it. Exported because the live corpus reports nothing, so this is the
 * only place the in-repository arm can be pinned.
 */
export function workflowDisplayPath(directory, name) {
  const path = relative(REPOSITORY_ROOT, join(directory, name));
  return path.startsWith('..') || isAbsolute(path) ? name : path;
}

/** Findings for every workflow in a directory, ordered by file then line. */
export function lintWorkflows(workflowsDir = WORKFLOWS_DIR) {
  return readdirSync(workflowsDir)
    .filter((name) => isWorkflowSource(name))
    .sort()
    .flatMap((name) =>
      analyzeWorkflow(workflowDisplayPath(workflowsDir, name), readFileSync(join(workflowsDir, name), 'utf8')),
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
    const summary =
      finding.kind === 'annotation' ? finding.detail : `unguarded pipe into ${finding.consumer} — ${finding.detail}`;
    process.stdout.write(`${level} file=${finding.file},line=${finding.line}::${summary}\n  ${where}: ${finding.statement}\n`);
  }

  if (errors.length > 0) {
    const pipes = errors.filter((finding) => finding.kind === 'pipe').length;
    const annotations = errors.length - pipes;
    if (pipes > 0) {
      process.stdout.write(
        `\n${pipes} unguarded early-exit pipe consumer(s) under pipefail.\n` +
          'Guard the pipeline (`… || true`), read the whole input (`grep -E … > /dev/null`),\n' +
          'or annotate the site with `# pipefail-lint: allow -- <why this producer cannot fill the pipe>`.\n',
      );
    }
    if (annotations > 0) {
      process.stdout.write(
        `\n${annotations} allow annotation(s) with no reasoning.\n` +
          'Write `# pipefail-lint: allow -- <why this producer cannot fill the pipe>`, or remove the annotation.\n',
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `No unguarded early-exit pipe consumers under pipefail (${findings.length} advisory warning(s)).\n`,
  );
}

if (process.argv[1] === import.meta.filename) main();
