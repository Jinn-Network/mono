/**
 * Deterministic AI-tell linter. Cheap regex pass that runs on every composer
 * output before it goes to the poster. If lint fails, the composer retries
 * once with the failure reason; if it fails again, the event is skipped.
 *
 * Returns `null` on pass, or a human-readable reason string on fail.
 */
export interface LintInput {
  text: string;
  link: string;
  maxChars: number;
}

const BANNED_TOKENS = [
  // superlatives
  'massive',
  'huge',
  'exciting',
  'thrilled',
  'proud',
  'incredible',
  'groundbreaking',
  'game-changing',
  // AI tells
  'delve',
  'dive into',
  'unlock',
  'unleash',
  'harness',
  'leverage',
  'ecosystem',
  'in essence',
  'moreover',
  'navigate',
  'embark',
  // CTAs / first-person plural
  'check it out',
  'learn more',
  ' we ',
  ' our ',
  ' us ',
  // forbidden punctuation
  '—',
];

const BANNED_REGEX = [
  /#[a-z0-9_]+/i, // hashtags
  /\?$/m,        // questions
  // common emoji ranges
  /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u,
];

export function lint(input: LintInput): string | null {
  const { text, link, maxChars } = input;
  if (!text.trim()) return 'empty output';
  if (text.length > maxChars) {
    return `output is ${text.length} chars, max is ${maxChars}`;
  }
  if (!text.includes(link)) {
    return `output is missing the link ${link}`;
  }
  const lower = ' ' + text.toLowerCase() + ' ';
  for (const token of BANNED_TOKENS) {
    if (lower.includes(token)) return `output contains banned token "${token.trim()}"`;
  }
  for (const re of BANNED_REGEX) {
    if (re.test(text)) return `output matches banned pattern ${re}`;
  }
  return null;
}
