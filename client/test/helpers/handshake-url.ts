const HANDSHAKE_RE = /UI handshake URL:\s+(\S+)/;

export function extractHandshakeUrl(line: string): string | null {
  const m = line.match(HANDSHAKE_RE);
  return m ? m[1] : null;
}

export interface HandshakeCollector {
  feed: (chunk: string) => void;
  promise: Promise<string>;
}

export function makeHandshakeCollector(timeoutMs: number): HandshakeCollector {
  let buffer = '';
  let resolve!: (url: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => {
    reject(new Error(`handshake URL collector timed out after ${timeoutMs}ms; buffered: ${buffer.slice(0, 200)}`));
  }, timeoutMs);
  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // All lines except the last are complete (terminated by a newline)
      const completeLines = lines.slice(0, -1);
      for (const line of completeLines) {
        const url = extractHandshakeUrl(line);
        if (url) {
          clearTimeout(timer);
          resolve(url);
          return;
        }
      }
    },
    promise,
  };
}
