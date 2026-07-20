export function explicitEnvironmentFlag(
  raw: string | undefined,
  label: string,
): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${label} must be true or false`);
}
