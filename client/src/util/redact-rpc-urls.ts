/**
 * Strip URLs from arbitrary error messages before they hit logs / stdout.
 * RPC endpoints often embed API keys; logging an `Error.message` verbatim leaks them.
 */
export function redactRpcUrls(input: unknown, configuredRpcUrls: readonly string[] = []): string {
  let message = input instanceof Error ? input.message : String(input);
  for (const url of configuredRpcUrlCandidates(configuredRpcUrls)) {
    message = message.replaceAll(url, '<rpc-url>');
  }
  for (const secret of configuredRpcSecretCandidates(configuredRpcUrls)) {
    message = message.replaceAll(secret, '<rpc-secret>');
  }
  return message.replace(/https?:\/\/[^\s"]+/g, '<rpc-url>');
}

function configuredRpcUrlCandidates(configuredRpcUrls: readonly string[]): string[] {
  return configuredRpcUrls
    .flatMap((url) => url.split(','))
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

function configuredRpcSecretCandidates(configuredRpcUrls: readonly string[]): string[] {
  const secrets = new Set<string>();
  for (const rawUrl of configuredRpcUrlCandidates(configuredRpcUrls)) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    addSecretCandidate(secrets, parsed.username);
    addSecretCandidate(secrets, parsed.password);
    for (const value of parsed.searchParams.values()) {
      addSecretCandidate(secrets, value);
    }

    const segments = parsed.pathname.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment) continue;
      const previous = segments[i - 1]?.toLowerCase();
      if (previous && /^v\d+$/.test(previous)) {
        addSecretCandidate(secrets, segment);
        continue;
      }
      if (segment.length >= 20 && /[A-Za-z]/.test(segment) && /[0-9A-Z]/.test(segment)) {
        addSecretCandidate(secrets, segment);
      }
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function addSecretCandidate(secrets: Set<string>, value: string): void {
  if (value.length < 6) return;
  secrets.add(value);
  try {
    secrets.add(decodeURIComponent(value));
  } catch {
    // Keep the encoded candidate when URL decoding fails.
  }
}
