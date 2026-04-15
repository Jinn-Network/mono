/**
 * Unit Test: Recognition Helpers
 * Migrated from: tests/unit/recognition-helpers.test.ts
 * Migration Date: November 7, 2025
 *
 * Tests recognition helper functions for parsing and formatting recognition learnings.
 * Pure unit test - no I/O, just string transformations.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDefaultQueryText,
  buildRecognitionPrompt,
  extractPromptSections,
  formatRecognitionMarkdown,
  normalizeLearnings,
  parseRecognitionJson,
} from 'jinn-node/worker/recognition_helpers.js';

describe('recognition helpers', () => {
  it('extracts structured sections from prompts', () => {
    const sections = extractPromptSections(`# Objective
Improve uptime
# Context
Existing incidents tracked in pager duty
# Constraints
No new infra`);
    expect(sections.Objective).toBe('Improve uptime');
    expect(sections.Context).toContain('Existing incidents');
    expect(sections.Constraints).toBe('No new infra');
  });

  it('builds default query text from sections', () => {
    const query = buildDefaultQueryText('Improve uptime', {
      Objective: 'Increase uptime to 99.9%',
      Context: 'Current uptime 98%',
      'Acceptance Criteria': 'Incident rate < 3 per quarter',
    });
    expect(query).toContain('Improve uptime');
    expect(query).toContain('Incident rate');
  });

  it('parses recognition responses from fenced code blocks', () => {
    const raw = parseRecognitionJson(`
Here is the result:
\`\`\`json
{
  "learnings": [
    { "sourceRequestId": "0x1", "insight": "Enable retries" }
  ]
}
\`\`\`
`);
    expect(raw?.learnings).toHaveLength(1);
    expect(raw.learnings[0].insight).toBe('Enable retries');
  });

  it('normalizes learning structures with multiple shapes', () => {
    const learnings = normalizeLearnings({
      result: {
        learnings: [
          {
            source_request_id: '0x1',
            title: 'Retry logic',
            insight: 'Enable exponential backoff',
            actions: ['Add retry helper'],
            warnings: ['Beware rate limits'],
            confidence_level: 'high',
          },
        ],
      },
    });
    expect(learnings).toHaveLength(1);
    expect(learnings[0]).toMatchObject({
      sourceRequestId: '0x1',
      title: 'Retry logic',
      actions: ['Add retry helper'],
      warnings: ['Beware rate limits'],
      confidence: 'high',
    });
  });

  it('formats recognition learnings into markdown prompt prefix', () => {
    const markdown = formatRecognitionMarkdown([
      {
        sourceRequestId: '0xabc',
        title: 'Retry strategy',
        insight: 'Use exponential backoff on RPC',
        actions: ['Implement retry helper', 'Add metrics'],
        warnings: ['Monitor for escalating delays'],
        confidence: 'high',
      },
    ]);
    expect(markdown).toContain('## Recognition Learnings');
    expect(markdown).toContain('Retry strategy');
    expect(markdown).toContain('source: 0xabc');
    expect(markdown).toContain('Confidence: high');
  });

  it('builds recognition prompt with job overview and query hint', () => {
    const prompt = buildRecognitionPrompt(
      ['Request ID: 0x1', 'Job Name: Analyze gas usage'],
      'Analyze gas usage',
    );
    expect(prompt).toContain('Recognize → Analyze → Synthesize');
    expect(prompt).toContain('Request ID: 0x1');
    expect(prompt).toContain('Default query_text');
  });
});
