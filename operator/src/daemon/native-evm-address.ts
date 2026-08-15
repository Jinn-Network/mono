/**
 * The single lowercase-canonical form for an EVM address used as a persisted key or lookup
 * equality (#26). Addresses arrive from signed facts checksummed and from the evaluation state row
 * lowercase; SQLite `WHERE address = ?` is case-sensitive, so a writer and a reader that disagree
 * on casing silently miss each other. The invariant is: addresses are keyed lowercase-canonical
 * everywhere. This is the canonicalizer — lowercase, never checksumming — that both sides call.
 */
export function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new TypeError('address must be a 20-byte EVM address');
  return value.toLowerCase();
}
