import { describe, it, expect } from 'vitest';
import { lint } from '../../src/composer/lint.js';

const link = 'https://github.com/Jinn-Network/mono/releases/tag/v0.1.6';
const base = { link, maxChars: 240 };

describe('lint', () => {
  it('accepts a plain factual tweet', () => {
    const text = `released v0.1.6 — tokenomics fork prep\n${link}`;
    // Note: this template uses an em dash, which the lint rejects.
    expect(lint({ ...base, text })).toMatch(/banned/);
  });

  it('accepts a tweet using a hyphen, not an em dash', () => {
    const text = `released v0.1.6: tokenomics fork prep\n${link}`;
    expect(lint({ ...base, text })).toBeNull();
  });

  it('rejects empty output', () => {
    expect(lint({ ...base, text: '   ' })).toBe('empty output');
  });

  it('rejects output over max chars', () => {
    const long = 'a'.repeat(241);
    expect(lint({ ...base, text: long + '\n' + link })).toMatch(/max is/);
  });

  it('rejects output missing the link', () => {
    expect(lint({ ...base, text: 'released v0.1.6' })).toMatch(/missing the link/);
  });

  it.each([
    ['delve', `delve into v0.1.6\n${link}`],
    ['leverage', `leverage v0.1.6\n${link}`],
    ['unlock', `unlock new capabilities\n${link}`],
    ['ecosystem', `ecosystem update\n${link}`],
    ['massive', `massive update\n${link}`],
    ['we ', `we shipped v0.1.6\n${link}`],
    ['em dash', `released — v0.1.6\n${link}`],
    ['hashtag', `released v0.1.6 #release\n${link}`],
    ['emoji', `released v0.1.6 🎉\n${link}`],
  ])('rejects banned token "%s"', (_label, text) => {
    expect(lint({ ...base, text })).toMatch(/banned/);
  });
});
