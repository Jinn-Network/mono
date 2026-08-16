/**
 * Errors the capture publisher throws. CLI `jinn capture` consumes these;
 * the HTTP captures surface retired in Stage 6 Task 17.
 */
export class CapturePublishUnavailableError extends Error {
  constructor(message = 'Capture publishing is not available yet') {
    super(message);
    this.name = 'CapturePublishUnavailableError';
  }
}

export class CapturePublishRateLimitError extends Error {
  readonly retryAfterMs?: number;
  readonly reason: string;

  constructor(reason: string, retryAfterMs?: number) {
    super(`Capture publish rate limit exceeded: ${reason}`);
    this.name = 'CapturePublishRateLimitError';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}
