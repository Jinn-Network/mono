import { describe, expect, it } from "vitest";
import {
  DynamicResponseBodyAudit,
  type AuditableResponse,
} from "./dynamic-response-audit";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(options: {
  readonly body: () => Promise<Buffer>;
  readonly failure?: { readonly errorText: string } | null;
  readonly method?: string;
  readonly status?: number;
  readonly url?: string;
}): AuditableResponse {
  return {
    body: options.body,
    request: () => ({
      failure: () => options.failure ?? null,
      method: () => options.method ?? "POST",
    }),
    status: () => options.status ?? 200,
    url: () => options.url ?? "http://127.0.0.1:3017/workspace/draft",
  };
}

describe("DynamicResponseBodyAudit", () => {
  it("holds the next browser operation until response bytes are retained", async () => {
    const body = deferred<Buffer>();
    const audit = new DynamicResponseBodyAudit<AuditableResponse>();
    audit.capture(response({ body: () => body.promise }));

    let nextOperationStarted = false;
    const nextOperation = (async () => {
      await audit.settleBeforeNextBrowserOperation();
      nextOperationStarted = true;
    })();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(nextOperationStarted).toBe(false);

    body.resolve(Buffer.from("audited application response"));
    await nextOperation;
    expect(nextOperationStarted).toBe(true);
    await expect(audit.captures[0]!.body).resolves.toEqual({
      kind: "complete",
      bytes: Buffer.from("audited application response"),
    });
  });

  it("remains fail-closed when Chromium loses an application response body", async () => {
    const audit = new DynamicResponseBodyAudit<AuditableResponse>({
      failurePollAttempts: 1,
      failurePollDelayMs: 0,
    });
    audit.capture(response({
      body: () => Promise.reject(new Error(
        "Protocol error (Network.getResponseBody): No resource with given identifier found",
      )),
    }));

    await expect(audit.settleBeforeNextBrowserOperation()).rejects.toThrow(
      /response body was not auditable.*No resource with given identifier found/u,
    );
  });

  it("distinguishes an explicit browser abort from a completed application response", async () => {
    const audit = new DynamicResponseBodyAudit<AuditableResponse>({
      failurePollAttempts: 1,
      failurePollDelayMs: 0,
    });
    audit.capture(response({
      body: () => Promise.reject(new Error("body unavailable")),
      failure: { errorText: "net::ERR_ABORTED" },
    }));

    await expect(audit.settleBeforeNextBrowserOperation()).resolves.toBeUndefined();
    await expect(audit.captures[0]!.body).resolves.toEqual({
      kind: "aborted",
      detail: "net::ERR_ABORTED",
    });
  });
});
