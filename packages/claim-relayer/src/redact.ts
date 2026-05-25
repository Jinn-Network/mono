const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>\\\])}]+/gi;

export function redactSecrets(value: string): string {
  return value.replace(URL_PATTERN, '[redacted-url]');
}

export function errorToMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message);
}

export function errorToLogMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.stack ?? error.message);
  }
  return redactSecrets(String(error));
}
