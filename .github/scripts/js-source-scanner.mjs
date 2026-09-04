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
 * Two characters are ambiguous on their own and are resolved by looking behind them:
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
 */
function valueMayBeginAfter(source, back) {
  if (back < 0) return true;
  const character = source[back];
  if ((character === '+' || character === '-') && source[back - 1] === character) return false;
  if (character === '!') return valueMayBeginAfter(source, previousSignificant(source, back - 1));
  if ('(,=:[&|?{;+-*%~^<>'.includes(character)) return true;
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
 */
export function quotedSpanEnd(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (quote !== '`' && source[index] === '\n') return index;
    index += source[index] === '\\' ? 2 : 1;
  }
  return index;
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
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const stop = Math.min(quotedSpanEnd(source, index) + 1, source.length);
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
