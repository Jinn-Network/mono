import { timingSafeEqual } from "node:crypto";

export interface ConstructorTokenExpectation {
  token: string;
  expiresAt?: string;
}

function tokensEqual(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Token comparison bound at construction time — the expected secret is not
 * re-read per call. Callers (HTTP middleware, CLI) pass the presented secret in.
 */
export class ConstructorTokenGate {
  constructor(
    private readonly expected: ConstructorTokenExpectation,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accept(supplied: string | undefined): boolean {
    if (this.expected.expiresAt !== undefined) {
      const expires = Date.parse(this.expected.expiresAt);
      if (!Number.isFinite(expires) || this.now().getTime() >= expires) return false;
    }
    if (supplied === undefined || supplied.length === 0) return false;
    return tokensEqual(supplied, this.expected.token);
  }
}
