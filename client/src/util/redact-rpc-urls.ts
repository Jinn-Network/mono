/**
 * Strip URLs from arbitrary error messages before they hit logs / stdout.
 * RPC endpoints often embed API keys; logging an `Error.message` verbatim leaks them.
 */
export function redactRpcUrls(input: unknown): string {
  const message = input instanceof Error ? input.message : String(input);
  return message.replace(/https?:\/\/[^\s"]+/g, '<rpc-url>');
}
