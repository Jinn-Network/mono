/**
 * Any absolute http(s) or ws(s) URL embedded in free text. Shared by
 * `observability/redact-secrets.ts` (`redactStringValue`) and
 * `rpc/transport.ts` (`maskUrlsInMessage`) so the two redaction paths cannot
 * drift (#4426 — they had, and a bracketed-IPv6 host was truncated at `]`,
 * leaking every credential through the unparseable-URL fallback).
 *
 * The class stops only at whitespace and quote/angle delimiters. `)` and `]`
 * are deliberately NOT excluded: `]` closes an IPv6 host literal, and a
 * trailing `)` swallowed from prose costs one bracket while an excluded one
 * cost the whole redaction. Case-insensitive because URL schemes are, and
 * nothing normalizes an operator-typed `HTTPS://` before it reaches a log.
 *
 * Global + stateful: use with `String.prototype.replace` only (which resets
 * `lastIndex`); never `.test()` / `.exec()` on the shared object.
 */
export const URL_IN_TEXT_RE = /(?:https?|wss?):\/\/[^\s"'<>]+/gi;
