import { describe, expect, it } from 'vitest';
import { isJsonMode, formatJson, formatHuman } from '../../src/cli/output.js';

describe('isJsonMode', () => {
  it('is true by default on a TTY', () => {
    expect(isJsonMode({ json: false, human: false, stdoutIsTty: true })).toBe(true);
  });

  it('is false when --human is set', () => {
    expect(isJsonMode({ json: false, human: true, stdoutIsTty: true })).toBe(false);
  });
});

describe('formatJson', () => {
  it('emits a single line ending in newline', () => {
    const out = formatJson({ a: 1, b: [2, 3] });
    expect(out).toBe('{"a":1,"b":[2,3]}\n');
  });
});

describe('formatHuman', () => {
  it('returns the input unchanged when NO_COLOR is not set', () => {
    expect(formatHuman('hello', { noColor: false })).toBe('hello');
  });

  it('strips ANSI escape sequences when NO_COLOR is set', () => {
    const colored = '\u001b[31mred\u001b[0m';
    expect(formatHuman(colored, { noColor: true })).toBe('red');
  });
});
