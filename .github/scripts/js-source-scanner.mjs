// The JavaScript/TypeScript source scanner shared by the repository-structure guards that read
// config and source text without parsing it.
//
// Two guards need the same pass and each grew its own: `vitest-tmp-isolation.test.mjs`, which
// reads Vitest configs for the temp-directory seam, and `benchmark-product-source-boundaries.test.mjs`,
// which reads product source for hand-typed §9.2 method identifiers. The second copy was the
// weaker one and re-imported every defect already filed against the first (#3088, #3089, #3092)
// plus one the first does not have: entering string mode at a quote inside a regex literal, which
// hands the following comment back as live code (#3799). One copy means one fix.
//
// This module is deliberately not a `.test.mjs` file. `node:test` registers a file's tests on
// import, so a guard that imported the scanner from the other guard would run that guard's suite
// inside its own.

/**
 * The index of the character that closes the regex literal opened at `start` — its unescaped
 * closing `/`, or the newline that bounds it, or `source.length`.
 *
 * A `/` opens a regex only where a value may begin, which `regexStartsAt` decides. Inside the
 * literal a `/` in a character class does not close it, so `[...]` spans are tracked; a regex
 * literal cannot hold an unescaped newline, so one bounds the scan the same way it bounds a
 * `'`/`"` string.
 */
export function regexLiteralEnd(source, start) {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n') return index;
    if (character === '\\') index += 1;
    else if (inClass) inClass = character !== ']';
    else if (character === '[') inClass = true;
    else if (character === '/') return index;
  }
  return source.length;
}

/** Keywords a regex literal may directly follow. */
const REGEX_PRECEDING_KEYWORDS = [
  'typeof',
  'return',
  'delete',
  'yield',
  'await',
  'void',
  'case',
  'else',
  'new',
  'in',
  'of',
  'do',
];

/** The index of the last non-whitespace character at or before `from`, or `-1`. */
function previousSignificant(source, from) {
  let back = from;
  while (back >= 0 && /\s/u.test(source[back])) back -= 1;
  return back;
}

/**
 * Whether the token ending at `back` is one of the keywords above, rather than the tail of a longer
 * identifier or a property named after one.
 *
 * Both sides need a boundary. Without the leading one `typeof` ends in `of`; without rejecting a
 * preceding `.` — or `?.`, or the `#` of a private name, or one written with spaces around it —
 * `opts.in / 2` reads as `in`, and every one of `in`, `of`, `new`, `delete`, `void`, `case` and
 * `do` is a legal property name, private field name included (`this.#in / 2`).
 * Reading one as a keyword consumes the division as a regex, which is the fail-open this whole
 * back-scan exists to prevent.
 */
function keywordEndsAt(source, back) {
  return REGEX_PRECEDING_KEYWORDS.some((keyword) => {
    if (source.slice(back - keyword.length + 1, back + 1) !== keyword) return false;
    const before = previousSignificant(source, back - keyword.length);
    return before < 0 || !/[\w$.#]/u.test(source[before]);
  });
}

/**
 * Whether a value may begin at the position just after `back` — where `back` is the index of the
 * previous significant character, or `-1` at the start of the source.
 *
 * This is the usual heuristic for a scanner with no expression parser: a value may begin after an
 * operator, a separator, an opening bracket, or one of the keywords above, and not after something
 * that can end an operand. Closing brackets are read as operands, so `f(x) / 2` is division; a
 * regex directly after one — `(a + b) /re/.test(c)` — is not valid code anyway.
 *
 * Three characters are ambiguous on their own. Two are resolved by looking behind them; the third
 * is resolved by choosing which way to be wrong.
 *
 * `--`/`++` read the wrong way round from the character alone: the trailing `-` of `x-- / 2` looks
 * like an operator. So a `+`/`-` doubled with the character before it counts as an operand end.
 *
 * `!` is both the prefix logical not, after which a regex is ordinary (`!/re/.test(x)`), and
 * TypeScript's postfix non-null assertion, after which `opts.value! / 2` is a division. Neither
 * reading is right unconditionally, so the same question is asked one token further back: a `!`
 * that itself sits where a value may begin is the prefix operator, and one that follows an operand
 * is the assertion.
 *
 * Both matter for the same reason: consuming a division as a regex takes the rest of its line —
 * including any structure and, where the line ends in a comment, the first `/` of its `//` — which
 * hands the comment's prose back as live source in miniature (#3027).
 *
 * `>` is the third, and it stays in the set below on purpose. It ends a TypeScript generic and it
 * ends an arrow: `previousSignificant` before the `/` of `(x) => /re/.test(x)` is that `>`, and
 * reading it as an operand end makes an arrow body opening with a regex scan as a division — the
 * same fail-open as the `--` and `!` cases above, on a shape configs write freely. Keeping it costs
 * the other reading: `x: a<b> / 2` consumes the division as a regex to the end of its line, and
 * where that line ends in a comment its prose comes back as live source. Nothing in the tree writes
 * that shape, and separating a generic close from a comparison needs matched `<`/`>` pairs, which a
 * real TypeScript parser resolves by backtracking and a character-at-a-time scanner cannot.
 *
 * `<` used to sit in the set too, on the same reasoning, and it does not any more (#3170). It was
 * what made the `/` of a JSX closing tag — `</Link>` — read as opening a regex literal, and that
 * phantom literal ran to the end of its line and swallowed the opening backtick of the template
 * beside it. From there every backtick in the file paired off by one, which desynced the scanner
 * across two shipped `.tsx` files that `benchmark-product-source-boundaries.test.mjs` reads on
 * every run. Dropping it loses only the mirror of the generic-close cost above — an operand may not
 * legally follow a comparison's `<` with a regex anyway — so the asymmetry with `>` is real and
 * deliberate rather than an oversight.
 */
function valueMayBeginAfter(source, back) {
  if (back < 0) return true;
  const character = source[back];
  if ((character === '+' || character === '-') && source[back - 1] === character) return false;
  if (character === '!') return valueMayBeginAfter(source, previousSignificant(source, back - 1));
  if ('(,=:[&|?{;+-*%~^>'.includes(character)) return true;
  return keywordEndsAt(source, back);
}

/**
 * Whether the `/` at `index` opens a regex literal rather than a division.
 *
 * Whatever this still misreads consumes at most one line, because `regexLiteralEnd` and
 * `quotedSpanEnd` both stop at a newline. What that line costs is bounded separately by each
 * caller: `stripComments` can emit the tail of a mis-read line verbatim, and `projectEntryRanges`
 * drops the one `projects` entry whose braces that line took, not the array.
 */
export function regexStartsAt(source, index) {
  return valueMayBeginAfter(source, previousSignificant(source, index - 1));
}

/**
 * The index just past the `}` that closes the `${` interpolation whose `{` is at `start`, or
 * `source.length` where it never closes.
 *
 * An interpolation body is ordinary code, not span text, and it is reached only from a backtick
 * span. That makes this the one place the walk re-enters code from inside a string, so it repeats
 * the same four checks the top-level walk makes rather than counting braces.
 *
 * Repeating them is not thoroughness for its own sake — a brace-and-string-only version is measured
 * WORSE than not entering the body at all. Over the 5,792 first-party source files, it leaves 4
 * files desynced against a baseline of 2, and only one of the 2 is among them: it fixes one and
 * breaks three that were previously fine. The shape that breaks them is ordinary —
 * `` `"${term.replace(/"/gu, '""')}"` `` — where the body holds a regex literal whose own body is a
 * quote character. Without the regex check that quote opens a phantom string, and the desync it
 * causes is the same one this function exists to remove, just relocated. The comment checks are
 * there for the same reason one level up: a `//` or `/*` inside a multi-line interpolation would
 * otherwise have its prose read as structure.
 *
 * `quotedSpanEnd` and this function are mutually recursive, bounded by template nesting depth. Real
 * source nests one or two deep and the deepest in this tree is 2, so no explicit depth guard is
 * warranted; a hand-written stack would be more machinery than the bound needs.
 *
 * Not exported. It has one caller, and the behaviour is pinned through `quotedSpanEnd`.
 */
function interpolationEnd(source, start) {
  let depth = 0;
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"' || character === '`') {
      index = Math.min(quotedSpanEnd(source, index) + 1, source.length);
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '/' && regexStartsAt(source, index)) {
      index = Math.min(regexLiteralEnd(source, index) + 1, source.length);
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      if (depth === 0) return index + 1;
      depth -= 1;
    }
    index += 1;
  }
  return source.length;
}

/**
 * The index of the character that closes the quoted span opened at `start` — the matching quote, or
 * the newline that bounds it, or `source.length`.
 *
 * A `'`/`"` string cannot hold an unescaped newline, so ending the span at one bounds any mis-read
 * to a single line. Template literals really do span lines, so only `'` and `"` take the bound.
 *
 * The hazard is a quote the scanner cannot pair off — most often one inside a regex literal,
 * `/['"]/u`. `regexStartsAt` recognizes those where a value may begin, which is every position a
 * config actually writes one; the newline bound is what backstops the rest, and it is the reason a
 * mis-read costs one line rather than the file. Unbounded, such a quote swallowed everything up to
 * the next one anywhere in the source: in `stripComments` that handed later comments back as live
 * source, and in the balanced scanners it ran past a `projects` entry's closing brace and dropped
 * every range, putting each allowance and seam path back in one scope (issues #3027, #3154).
 *
 * A `${` inside a backtick span leaves span text and re-enters code, so it is handed to
 * `interpolationEnd` rather than walked as more of the string. Reading the body as span text let a
 * nested template's opening backtick close the outer span, and from there every backtick in the
 * file paired off by one — the scanner walking that file's strings and its code exactly inverted
 * (#3088). An escaped `\${` never reaches the check, because the escape advance consumes the `$`
 * with its backslash first.
 */
export function quotedSpanEnd(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (quote !== '`' && source[index] === '\n') return index;
    if (quote === '`' && source[index] === '$' && source[index + 1] === '{') {
      index = interpolationEnd(source, index + 1);
      continue;
    }
    index += source[index] === '\\' ? 2 : 1;
  }
  return index;
}

/**
 * Thrown by `stripComments` when a backtick span reaches the end of the source without closing.
 *
 * Carries the `offset` the span opened at and the 1-based `line` holding it, because that is all
 * this module can say: it is handed source text and never a path. The two guards that call
 * `stripComments` add the file name when they catch this (#3088).
 */
export class UnterminatedTemplateError extends Error {
  constructor(offset, line) {
    super(`unterminated template literal opened at line ${line}`);
    this.name = 'UnterminatedTemplateError';
    this.offset = offset;
    this.line = line;
  }
}

/**
 * `source` with line and block comments replaced by whitespace, preserving offsets and line
 * structure so the readers below can keep matching over a plain string.
 *
 * Every reader here matches the raw source, so without this a commented-out entry reads exactly
 * like a live one: prefixing `// ` to a config's `setupFiles` line left the wiring gate green while
 * the suite resumed leaking (issue #3027). Quoted text is skipped, so a `//` inside a path or URL
 * is not mistaken for a comment.
 *
 * Stripping also protects the balanced scanners below, which share this pass's quote and regex
 * awareness but not its comment awareness. These configs are prose-heavy: an apostrophe in a
 * comment inside a multi-line array opens a phantom string that swallows the closing bracket, and
 * a stray `]` in a comment closes the array early. Either one drops a real seam entry and reds a
 * correctly wired config.
 *
 * Regex literals are passed through verbatim rather than blanked: they preserve offsets either
 * way, and every reader below skips them itself, so leaving them intact keeps this pass to the one
 * job its name states. A comment marker wins over a regex — `//` never opens a regex literal, and
 * `/*` cannot start a valid one — so the comment checks run first.
 *
 * This function is partial: a backtick span that never closes raises `UnterminatedTemplateError`
 * rather than returning a desynced read. Every other mis-read this module can make is bounded to a
 * line, because a `'`/`"` span and a regex literal both stop at a newline — so their worst case is
 * the rest of one line and the readers stay worth running. Only a backtick crosses lines, so only a
 * backtick's failure is unbounded: everything past it comes back with the file's strings and its
 * code swapped, and a reader matching over that output is not reading the file it was handed. The
 * `'`/`"` cases keep their tolerated end-of-source behaviour for exactly that reason, and
 * `stripComments("a: 'unterminated // x")` returning itself stays pinned.
 *
 * Three places could hold this check, and the other two are worse:
 *
 * `quotedSpanEnd`'s contract is documented as total, and four readers — `balancedEnd`,
 * `projectEntryRanges`, `arrayElements` and `stringLiterals` — are deliberately fail-closed-empty
 * on an unterminated literal. Throwing there makes every one of those documented paths
 * unreachable.
 *
 * The guard level would mean two guards each re-walking the file to ask the question, which is the
 * duplication this module's header exists to end.
 *
 * `stripComments` is the seam: the single production entry point both guards take, already owning
 * the full-awareness walk, and the place the damage manifests — #3027 is a property of this
 * function's output.
 *
 * The blast radius is its two readers, not the tree. `benchmark-product-source-boundaries.test.mjs`
 * walks `benchmark-product/{cli,core,verify,web}/src` and `vitest-tmp-isolation.test.mjs` walks the
 * Vitest configs; a file outside both is no more covered after this than before.
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const end = quotedSpanEnd(source, index);
      if (char === '`' && end >= source.length) {
        throw new UnterminatedTemplateError(index, source.slice(0, index).split('\n').length);
      }
      const stop = Math.min(end + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      const stop = newline === -1 ? source.length : newline;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/gu, ' ');
      index = stop;
      continue;
    }
    if (char === '/' && regexStartsAt(source, index)) {
      const stop = Math.min(regexLiteralEnd(source, index) + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
