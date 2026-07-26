import { canonicalJsonBytes, sha256Digest } from "../bytes.js";
import { EvidenceDerivationError } from "../errors.js";
import type {
  ConfidenceBand,
  CreateEvidenceDeriverOptions,
  DerivationDetector,
  DerivationDetectorDescriptor,
  DerivationFinding,
  DerivationSurface,
  DerivationOperationOptions,
} from "../types.js";

export interface BuiltinPrivateConfiguration {
  readonly schemaVersion: "jinn.private-detector-configuration.v1";
  readonly nonce: string;
  readonly knownIdentities: readonly string[];
  readonly privateAllowlist: readonly string[];
}

export interface BuiltinDetectorOptions {
  readonly privateConfiguration: BuiltinPrivateConfiguration;
}

type Match = {
  readonly class: string;
  readonly start: number;
  readonly end: number;
  readonly confidence?: ConfidenceBand;
  readonly evidence: string;
};

function descriptor(
  id: string,
  configurationDigest?: `sha256:${string}`,
): DerivationDetectorDescriptor {
  return Object.freeze({
    id,
    version: "1.0.0",
    implementationDigest: sha256Digest(
      canonicalJsonBytes({ id, version: "1.0.0" }),
    ),
    reproducibility: "byte-stable",
    ...(configurationDigest ? { configurationDigest } : {}),
  });
}

function finding(
  surface: DerivationSurface,
  match: Match,
  detectorDescriptor: DerivationDetectorDescriptor,
): DerivationFinding {
  return Object.freeze({
    class: match.class,
    confidence: match.confidence ?? "VERY_HIGH",
    surfaceId: surface.surfaceId,
    start: match.start,
    end: match.end,
    evidence: Object.freeze([match.evidence]),
    detector: detectorDescriptor,
  });
}

function regexMatches(
  text: string,
  pattern: RegExp,
  classification: string,
  evidence: string,
  confidence?: ConfidenceBand,
): Match[] {
  const matches: Match[] = [];
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let result: RegExpExecArray | null;
  while ((result = regex.exec(text)) !== null) {
    if (result[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({
      class: classification,
      start: result.index,
      end: result.index + result[0].length,
      evidence,
      ...(confidence ? { confidence } : {}),
    });
  }
  return matches;
}

function luhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function ipRange(ip: string): "public" | "private" | "ignored" {
  const [a, b, c] = ip.split(".").map(Number);
  if (
    a === 127 ||
    a === 0 ||
    a === 255 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a !== undefined && a >= 224)
  ) {
    return "ignored";
  }
  if (
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  ) {
    return "private";
  }
  return "public";
}

function patternMatches(text: string): Match[] {
  const matches = [
    ...regexMatches(
      text,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "email",
      "email-shape",
    ),
    ...regexMatches(
      text,
      /\/(?:Users|home)\/[^/\s"'`]+/g,
      "absolute-path",
      "home-path",
    ),
    ...regexMatches(
      text,
      /\b(?:ghp_|xox[baprs]-|npm_|sk-(?:proj-)?|rk_live_|sk_live_)[A-Za-z0-9_-]{16,}\b/g,
      "credential",
      "credential-token-shape",
    ),
    ...regexMatches(
      text,
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}/g,
      "credential",
      "cloud-credential-id",
    ),
    ...regexMatches(
      text,
      /https?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+|[?&](?:token|key|secret|password)=[^&\s]+/gi,
      "url-credential",
      "url-credential",
    ),
    ...regexMatches(
      text,
      /\b0x[a-fA-F0-9]{40}\b/g,
      "wallet-address",
      "wallet-address",
    ),
    ...regexMatches(
      text,
      /(?:^|\n)(?:Author|Committer):[^\n]+|(?:user\.name|user\.email)\s*=[^\n]+/g,
      "git-identity",
      "git-identity-carrier",
    ),
    ...regexMatches(
      text,
      /\b(?:hostname|machine(?:-name)?)\s*[:=]\s*[A-Za-z0-9._-]+/gi,
      "machine-identity",
      "machine-identity-carrier",
    ),
  ];
  const keyContext =
    /\b(?:private[_\s-]?key|privkey|secret[_\s-]?key|wallet[_\s-]?key|signing[_\s-]?key)\b/i;
  if (keyContext.test(text)) {
    matches.push(
      ...regexMatches(
        text,
        /(?<!0x)\b[a-fA-F0-9]{64}\b/g,
        "funds-controlling-secret",
        "private-key-hex64",
      ),
    );
  }
  const env = /(?:^|\n)(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*(?:\n(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*){2,}/g;
  matches.push(
    ...regexMatches(text, env, "environment-dump", "environment-assignment-run"),
  );
  const card = /\b(?:\d[ -]*?){13,19}\b/g;
  for (const candidate of text.matchAll(card)) {
    if (luhn(candidate[0])) {
      matches.push({
        class: "payment-instrument",
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        evidence: "luhn-valid-card",
      });
    }
  }
  const ipv4 =
    /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
  for (const candidate of text.matchAll(ipv4)) {
    const range = ipRange(candidate[0]);
    if (range !== "ignored") {
      matches.push({
        class: "ip-address",
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        confidence: range === "public" ? "VERY_HIGH" : "MEDIUM",
        evidence: `ipv4-${range}`,
      });
    }
  }
  return matches;
}

export function createBuiltinDerivationDetectors(
  options: BuiltinDetectorOptions,
): readonly DerivationDetector[] {
  const configuration = options?.privateConfiguration;
  if (
    !configuration ||
    configuration.schemaVersion !==
      "jinn.private-detector-configuration.v1" ||
    typeof configuration.nonce !== "string" ||
    configuration.nonce.length < 32 ||
    !Array.isArray(configuration.knownIdentities) ||
    !Array.isArray(configuration.privateAllowlist)
  ) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Built-in detector private configuration requires a nonce of at least 128 bits.",
    );
  }
  const configurationDigest = sha256Digest(
    canonicalJsonBytes({
      schemaVersion: configuration.schemaVersion,
      nonce: configuration.nonce,
      values: configuration.knownIdentities,
    }),
  );
  const knownDescriptor = descriptor("known-identity", configurationDigest);
  const knownValues = Object.freeze([...configuration.knownIdentities]);
  const knownIdentity: DerivationDetector = Object.freeze({
    descriptor: knownDescriptor,
    async detect(surface: DerivationSurface) {
      const results: DerivationFinding[] = [];
      for (const value of knownValues) {
        if (!value) continue;
        let offset = surface.text.indexOf(value);
        while (offset >= 0) {
          results.push(
            finding(
              surface,
              {
                class: "known-identity",
                start: offset,
                end: offset + value.length,
                evidence: "known-identity-exact",
              },
              knownDescriptor,
            ),
          );
          offset = surface.text.indexOf(value, offset + value.length);
        }
      }
      return results;
    },
  });
  const patternsDescriptor = descriptor("deterministic-patterns");
  const patterns: DerivationDetector = Object.freeze({
    descriptor: patternsDescriptor,
    async detect(
      surface: DerivationSurface,
      operationOptions?: DerivationOperationOptions,
    ) {
      if (operationOptions?.signal?.aborted) {
        throw new EvidenceDerivationError(
          "OPERATION_ABORTED",
          "Derivation was aborted.",
        );
      }
      return patternMatches(surface.text).map((match) =>
        finding(surface, match, patternsDescriptor),
      );
    },
  });
  return Object.freeze([knownIdentity, patterns]);
}

function descriptorKey(descriptorValue: DerivationDetectorDescriptor): string {
  return [
    descriptorValue.id,
    descriptorValue.version,
    descriptorValue.implementationDigest,
    descriptorValue.configurationDigest ?? "",
  ].join("\u0000");
}

export function normalizeDetectorFindings(
  surface: DerivationSurface,
  findings: readonly DerivationFinding[],
): readonly DerivationFinding[] {
  const normalized: DerivationFinding[] = [];
  for (const candidate of findings) {
    if (
      candidate.surfaceId !== surface.surfaceId ||
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end) ||
      candidate.start < 0 ||
      candidate.end <= candidate.start ||
      candidate.end > surface.text.length ||
      !candidate.class ||
      !Array.isArray(candidate.evidence) ||
      candidate.evidence.some(
        (code) =>
          typeof code !== "string" ||
          !/^[a-z0-9][a-z0-9:-]*$/.test(code) ||
          code.includes(surface.text.slice(candidate.start, candidate.end)),
      )
    ) {
      throw new EvidenceDerivationError(
        "DETECTOR_CONTRACT_VIOLATION",
        "Detector emitted an invalid finding.",
      );
    }
    normalized.push(
      Object.freeze({
        ...candidate,
        evidence: Object.freeze([...candidate.evidence]),
        detector: Object.freeze({ ...candidate.detector }),
      }),
    );
  }
  normalized.sort(
    (left, right) =>
      left.surfaceId.localeCompare(right.surfaceId) ||
      left.start - right.start ||
      left.end - right.end ||
      left.class.localeCompare(right.class) ||
      descriptorKey(left.detector).localeCompare(descriptorKey(right.detector)),
  );
  const unique = normalized.filter(
    (candidate, index) =>
      index === 0 ||
      JSON.stringify(candidate) !== JSON.stringify(normalized[index - 1]),
  );
  return Object.freeze(unique);
}

export function snapshotDetectors(
  detectors: CreateEvidenceDeriverOptions["detectors"],
): readonly DerivationDetector[] {
  const ids = new Set<string>();
  return Object.freeze(
    detectors.map((detector) => {
      if (ids.has(detector.descriptor.id)) {
        throw new EvidenceDerivationError(
          "INVALID_DERIVATION_INPUT",
          "Detector ids must be unique.",
        );
      }
      ids.add(detector.descriptor.id);
      return detector;
    }),
  );
}
