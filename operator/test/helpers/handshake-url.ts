const HANDSHAKE_RE = /UI handshake URL:\s+(\S+)/;

export function extractHandshakeUrl(line: string): string | null {
  const m = line.match(HANDSHAKE_RE);
  return m ? m[1] : null;
}

export interface HandshakeCollector {
  feed: (chunk: string) => void;
  promise: Promise<string>;
  /**
   * Clears the pending timeout and marks the collector settled so further
   * `feed()` calls become no-ops. Idempotent. Callers should still detach
   * their own stream listeners; `promise` settling (resolve/reject/dispose)
   * is the signal to do so.
   */
  dispose: () => void;
}

export function makeHandshakeCollector(timeoutMs: number): HandshakeCollector {
  let buffer = '';
  let settled = false;
  let resolve!: (url: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error(`handshake URL collector timed out after ${timeoutMs}ms; buffered: ${buffer.slice(0, 200)}`));
  }, timeoutMs);
  return {
    feed(chunk: string) {
      if (settled) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // Keep only the trailing unterminated partial line; everything before it
      // is complete and has been scanned, so it must not accumulate in buffer.
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const url = extractHandshakeUrl(line);
        if (url) {
          settled = true;
          clearTimeout(timer);
          resolve(url);
          return;
        }
      }
    },
    promise,
    dispose() {
      if (settled) {
        clearTimeout(timer);
        return;
      }
      settled = true;
      clearTimeout(timer);
    },
  };
}
