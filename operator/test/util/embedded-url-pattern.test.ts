import { describe, expect, it } from 'vitest';
import { EMBEDDED_URL_RE, EMBEDDED_URL_SCHEMES } from '../../src/util/embedded-url-pattern.js';

describe('EMBEDDED_URL_SCHEMES', () => {
  it.each([...EMBEDDED_URL_SCHEMES])('EMBEDDED_URL_RE matches %s://x', (scheme) => {
    EMBEDDED_URL_RE.lastIndex = 0;
    expect(`${scheme}://x`.match(EMBEDDED_URL_RE)?.[0]).toBe(`${scheme}://x`);
  });
});
