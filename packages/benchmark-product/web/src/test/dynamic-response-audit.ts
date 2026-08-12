import { setTimeout as delay } from "node:timers/promises";

export interface AuditableResponse {
  readonly body: () => Promise<Buffer>;
  readonly request: () => {
    readonly failure: () => { readonly errorText: string } | null;
    readonly method: () => string;
  };
  readonly status: () => number;
  readonly url: () => string;
}

export type AuditedResponseBody =
  | { readonly kind: "complete"; readonly bytes: Buffer }
  | { readonly kind: "aborted"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export interface AuditedResponseCapture<TResponse extends AuditableResponse> {
  readonly response: TResponse;
  readonly body: Promise<AuditedResponseBody>;
}

export interface DynamicResponseBodyAuditOptions {
  readonly failurePollAttempts?: number;
  readonly failurePollDelayMs?: number;
}

/** Chromium may surround its network failure text with transport whitespace. Normalize only that
 * framing; do not fold case, punctuation, suffixes, or prose into the one accepted abort code. */
export function isExactChromiumAbort(detail: string): boolean {
  return detail.trim() === "net::ERR_ABORTED";
}

/**
 * Starts body retention at the response event and provides an explicit barrier before the next
 * browser operation. Chromium frees protocol response bodies on navigation; awaiting this barrier
 * keeps the audit byte-complete rather than turning that browser lifecycle race into an exemption.
 */
export class DynamicResponseBodyAudit<TResponse extends AuditableResponse> {
  readonly #captures: AuditedResponseCapture<TResponse>[] = [];
  readonly #failurePollAttempts: number;
  readonly #failurePollDelayMs: number;
  #settled = 0;

  constructor(options: DynamicResponseBodyAuditOptions = {}) {
    this.#failurePollAttempts = options.failurePollAttempts ?? 100;
    this.#failurePollDelayMs = options.failurePollDelayMs ?? 10;
  }

  get captures(): readonly AuditedResponseCapture<TResponse>[] {
    return this.#captures;
  }

  capture(response: TResponse): void {
    const body = response.request().method() === "HEAD"
      || response.status() === 204
      || response.status() === 304
      ? Promise.resolve({ kind: "complete" as const, bytes: Buffer.alloc(0) })
      : this.#captureBody(response);
    this.#captures.push({ response, body });
  }

  async settleBeforeNextBrowserOperation(): Promise<void> {
    // Deliberately observe the live length: responses whose headers arrive while an earlier body
    // is finishing are part of the same audit barrier and must settle before navigation continues.
    while (this.#settled < this.#captures.length) {
      const capture = this.#captures[this.#settled]!;
      const result = await capture.body;
      const label = `${capture.response.request().method()} ${capture.response.url()}`;
      if (result.kind === "error") {
        throw new Error(`${label} response body was not auditable: ${result.detail}`);
      }
      if (result.kind === "aborted" && !isExactChromiumAbort(result.detail)) {
        throw new Error(`${label} response ended with an unexpected failure: ${result.detail}`);
      }
      this.#settled += 1;
    }
  }

  async #captureBody(response: TResponse): Promise<AuditedResponseBody> {
    try {
      return { kind: "complete", bytes: await response.body() };
    } catch (cause) {
      for (let attempt = 0; attempt < this.#failurePollAttempts; attempt += 1) {
        const requestFailure = response.request().failure();
        if (requestFailure !== null) return { kind: "aborted", detail: requestFailure.errorText };
        await delay(this.#failurePollDelayMs);
      }
      return { kind: "error", detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
