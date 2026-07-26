// SPDX-License-Identifier: Apache-2.0

export type TechnicalValueClass =
  | "digest"
  | "transaction-digest"
  | "cid"
  | "dsse-material"
  | "public-key"
  | "version"
  | "model-id";

const CREDENTIAL = /(?:sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{4,}/;

export function classifyTechnicalValue(
  value: string,
  context: { readonly field?: string },
): TechnicalValueClass | null {
  if (CREDENTIAL.test(value)) return null;
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return "digest";
  if (/^0x[a-fA-F0-9]{64}$/.test(value)) return "transaction-digest";
  if (/^b[a-z2-7]{20,}$/.test(value)) return "cid";
  if (/^-----BEGIN (?:PUBLIC KEY|CERTIFICATE)-----/.test(value)) {
    return "public-key";
  }
  if (
    context.field === "payload" ||
    context.field === "sig" ||
    context.field === "signature"
  ) {
    return "dsse-material";
  }
  if (
    context.field?.includes("version") ||
    context.field === "version" ||
    context.field === "packageVersion"
  ) {
    if (/^(?:v)?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
      return "version";
    }
  }
  if (
    (context.field === "model" || context.field === "modelId") &&
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
  ) {
    return "model-id";
  }
  return null;
}
