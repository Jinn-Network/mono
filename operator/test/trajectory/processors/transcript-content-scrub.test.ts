import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  containsSensitiveTranscriptContent,
  TranscriptContentScrubProcessor,
} from '../../../src/trajectory/processors/transcript-content-scrub.js';

function spanWith(attrs: Record<string, unknown>): ReadableSpan {
  return { attributes: { ...attrs } } as unknown as ReadableSpan;
}

describe('TranscriptContentScrubProcessor', () => {
  it('detects raw credentials embedded in transcript strings', () => {
    expect(containsSensitiveTranscriptContent('api_key=sk-aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(containsSensitiveTranscriptContent('Authorization: Bearer bbbbbbbbbbbbbbbbbbbbbbbb')).toBe(true);
    expect(containsSensitiveTranscriptContent('normal transcript text')).toBe(false);
  });

  it('detects sensitive keys inside JSON transcript attributes', () => {
    expect(containsSensitiveTranscriptContent(JSON.stringify({
      query: 'weather',
      headers: { authorization: 'Bearer bbbbbbbbbbbbbbbbbbbbbbbb' },
    }))).toBe(true);
    expect(containsSensitiveTranscriptContent(JSON.stringify({ query: 'weather' }))).toBe(false);
  });

  it('redacts transcript content fields to a sentinel value', () => {
    const proc = new TranscriptContentScrubProcessor();
    const span = spanWith({
      'message.content': 'please use api_key=sk-aaaaaaaaaaaaaaaaaaaaaaaa',
      'tool.args': JSON.stringify({ token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa' }),
      'tool.name': 'fetch',
    });

    proc.onEnd(span);

    expect(span.attributes['message.content']).toBe('<REDACTED>');
    expect(span.attributes['tool.args']).toBe('<REDACTED>');
    expect(span.attributes['tool.name']).toBe('fetch');
  });
});
