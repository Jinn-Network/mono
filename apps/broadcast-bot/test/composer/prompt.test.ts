import { describe, it, expect } from 'vitest';
import { buildUserPrompt, SYSTEM_PROMPT } from '../../src/composer/prompt.js';

describe('prompt', () => {
  it('includes the event JSON in the user prompt', () => {
    const prompt = buildUserPrompt({
      type: 'release',
      dedupeKey: 'release:100',
      link: 'https://github.com/Jinn-Network/mono/releases/tag/v0.1.6',
      timestamp: '2026-05-18T09:00:00Z',
      payload: {
        tag: 'v0.1.6',
        name: 'tokenomics fork prep',
        repo: 'Jinn-Network/mono',
        link: 'https://github.com/Jinn-Network/mono/releases/tag/v0.1.6',
      },
    });
    expect(prompt).toContain('v0.1.6');
    expect(prompt).toContain('tokenomics fork prep');
    expect(prompt).toContain('Example 1');
  });

  it('system prompt forbids the major AI tells', () => {
    expect(SYSTEM_PROMPT).toContain('delve');
    expect(SYSTEM_PROMPT).toContain('leverage');
    expect(SYSTEM_PROMPT).toContain('ecosystem');
    expect(SYSTEM_PROMPT).toContain('Em dashes');
    expect(SYSTEM_PROMPT).toContain('First-person plural');
  });
});
