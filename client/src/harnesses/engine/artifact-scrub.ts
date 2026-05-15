import {
  type IdentityScrubConfig,
  scrubIdentityString,
} from '../../trajectory/processors/identity-scrub.js';
import {
  CREDENTIAL_REDACTED,
  isSensitiveCredentialKey,
} from '../../trajectory/processors/credential-scrub.js';
import {
  type PathScrubConfig,
  scrubPathString,
} from '../../trajectory/processors/path-scrub.js';

export const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;

export interface ArtifactScrubConfig {
  identity?: IdentityScrubConfig;
  path?: PathScrubConfig;
}

export interface ArtifactScrubResult {
  bytes: Buffer;
  redactedKeys: string[];
}

const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes);
}

function scrubCredentialValues(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    out = out.replace(pattern, CREDENTIAL_REDACTED);
  }
  return out;
}

function scrubTextValue(value: string, cfg: ArtifactScrubConfig): string {
  let out = value;
  if (cfg.path) out = scrubPathString(out, cfg.path);
  if (cfg.identity) out = scrubIdentityString(out, cfg.identity);
  return scrubCredentialValues(out);
}

function scrubJsonValue(
  value: unknown,
  cfg: ArtifactScrubConfig,
  redactedKeys: Set<string>,
): unknown {
  if (typeof value === 'string') return scrubTextValue(value, cfg);
  if (Array.isArray(value)) return value.map((entry) => scrubJsonValue(entry, cfg, redactedKeys));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (isSensitiveCredentialKey(key)) {
        out[key] = CREDENTIAL_REDACTED;
        redactedKeys.add(key);
      } else {
        out[key] = scrubJsonValue(raw, cfg, redactedKeys);
      }
    }
    return out;
  }
  return value;
}

function scrubJsonText(text: string, cfg: ArtifactScrubConfig): ArtifactScrubResult | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const redactedKeys = new Set<string>();
    const scrubbed = scrubJsonValue(parsed, cfg, redactedKeys);
    if (JSON.stringify(scrubbed) === JSON.stringify(parsed)) return null;
    const out = `${JSON.stringify(scrubbed, null, 2)}\n`;
    return {
      bytes: Buffer.from(out, 'utf8'),
      redactedKeys: Array.from(redactedKeys).sort(),
    };
  } catch {
    return null;
  }
}

function scrubCredentialLines(text: string, redactedKeys: Set<string>): string {
  return text
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(.*)$/);
      if (!match) return line;
      const [, prefix, key, sep] = match;
      if (!isSensitiveCredentialKey(key)) return line;
      redactedKeys.add(key);
      return `${prefix}${key}${sep}${CREDENTIAL_REDACTED}`;
    })
    .join('\n');
}

export function scrubArtifactBytes(
  bytes: Buffer,
  cfg: ArtifactScrubConfig = {},
): ArtifactScrubResult {
  if (!isUtf8Text(bytes)) return { bytes, redactedKeys: [] };

  const text = bytes.toString('utf8');
  const jsonResult = scrubJsonText(text, cfg);
  if (jsonResult) return jsonResult;

  const redactedKeys = new Set<string>();
  let scrubbed = scrubTextValue(text, cfg);
  scrubbed = scrubCredentialLines(scrubbed, redactedKeys);
  if (scrubbed === text && redactedKeys.size === 0) {
    return { bytes, redactedKeys: [] };
  }
  return {
    bytes: Buffer.from(scrubbed, 'utf8'),
    redactedKeys: Array.from(redactedKeys).sort(),
  };
}
