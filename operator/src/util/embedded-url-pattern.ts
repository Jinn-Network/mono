/**
 * The one pattern for finding an `http(s)://` or `ws(s)://` URL embedded in
 * free text — an error message, a log line, a debug-bundle string value.
 *
 * Shared by `rpc/transport.ts` (`maskUrlsInMessage`, host-only masking) and
 * `observability/redact-secrets.ts` (credential stripping). The two carried
 * separate copies until #4426, when the redactor's copy was found to differ
 * in exactly the two ways that leak:
 *
 * - `]` and `)` are deliberately NOT excluded from the URL body. A bracketed
 *   IPv6 host (`wss://u:pw@[2001:db8::1]:8546/...`) contains `]`; a pattern
 *   that stops there hands `new URL` an unparseable prefix, and the caller's
 *   catch path returns the credentials intact. The mirror case — a URL whose
 *   authority is closed by a prose `]` or `)` (`[https://u:pw@host]`) —
 *   swallows that bracket into the host and defeats `new URL` too, so this
 *   is safe only because `redactRpcUrl`'s catch path fails closed and strips
 *   userinfo and query textually.
 * - The `i` flag, because `new URL` accepts `HTTPS://` and a pattern without
 *   it matches nothing on an uppercase scheme.
 *
 * Both consumers call `String.prototype.replace`, which resets `lastIndex` on
 * a global regex before and after each call, so sharing one instance across
 * callers is safe. Do not use it with `exec` / `test` in a loop without
 * resetting `lastIndex` yourself.
 *
 * Protocol-relative `//host/path` is not matched — see the `maskUrlsInMessage`
 * doc comment for why.
 */
export const EMBEDDED_URL_RE = /(?:https?|wss?):\/\/[^\s"'<>]+/gi;
