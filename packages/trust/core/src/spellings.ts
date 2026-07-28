// SPDX-License-Identifier: Apache-2.0

import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import { compareCodeUnitStrings } from "./order.js";
import { TrustCoreError, invalidInput } from "./errors.js";

function isAbsoluteIri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

function sortedVocabulary(vocabulary: readonly string[]): readonly string[] {
  return [...vocabulary].sort(compareCodeUnitStrings);
}

// ---------------------------------------------------------------------------
// EIP-55 checksum (design §3.1: "did:pkh grammar verbatim; profile adds
// mandatory EIP-55 checksum"). Implemented against @noble/hashes' keccak_256
// -- trust-core never imports viem.
// ---------------------------------------------------------------------------

const RAW_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function toChecksumAddress(address: string): `0x${string}` {
  if (!RAW_ADDRESS_PATTERN.test(address)) {
    invalidInput(`"${address}" is not a 20-byte hex address.`);
  }
  const lower = address.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  let checksummed = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const character = lower[index]!;
    if (/[0-9]/.test(character)) {
      checksummed += character;
      continue;
    }
    const hashByte = hash[Math.floor(index / 2)]!;
    const nibble = index % 2 === 0 ? hashByte >> 4 : hashByte & 0x0f;
    checksummed += nibble >= 8 ? character.toUpperCase() : character;
  }
  return checksummed as `0x${string}`;
}

export function isChecksummedAddress(address: string): boolean {
  return RAW_ADDRESS_PATTERN.test(address) && address === toChecksumAddress(address);
}

// ---------------------------------------------------------------------------
// did:pkh (design §3.1/§5): `did:pkh:eip155:<chainId>:0x<EIP-55-checksummed>`.
// CAIP-10 erases the EOA/contract distinction, so the contract-account flag
// travels alongside the DID string, not inside it.
// ---------------------------------------------------------------------------

const DID_PKH_PATTERN = /^did:pkh:eip155:([0-9]+):(0x[0-9a-fA-F]{40})$/;

export const DidPkhSchema = z.string().refine(
  (value) => {
    const match = DID_PKH_PATTERN.exec(value);
    return match !== null && isChecksummedAddress(match[2]!);
  },
  { message: "did:pkh must be did:pkh:eip155:<chainId>:0x<EIP-55-checksummed address>." },
);
export type DidPkh = z.infer<typeof DidPkhSchema>;

export function didPkh(chainId: number | string, address: string): DidPkh {
  return `did:pkh:eip155:${chainId}:${toChecksumAddress(address)}`;
}

export const AccountIdentitySchema = z.object({
  did: DidPkhSchema,
  contractAccount: z.boolean(),
});
export type AccountIdentity = z.infer<typeof AccountIdentitySchema>;

// ---------------------------------------------------------------------------
// did:key (design §3.1/§5): the standard spelling for a bare working key.
// Validated as format only (multibase base58btc, `z`-prefixed) -- trust-core
// does not decode the multicodec-prefixed key material here.
// ---------------------------------------------------------------------------

const DID_KEY_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

export const DidKeySchema = z.string().regex(
  DID_KEY_PATTERN,
  "did:key must be did:key:z<base58btc multibase-encoded key>.",
);
export type DidKey = z.infer<typeof DidKeySchema>;

// ---------------------------------------------------------------------------
// CAIP-19 ERC-8004 agent asset ID (design §3.1/§5):
// `eip155:<chainId>/erc721:0x<registry>/<agentId>`. Registry facts bind only
// by composition with an account ceremony (§7.2); this schema pins format.
// ---------------------------------------------------------------------------

const CAIP19_AGENT_PATTERN =
  /^eip155:([0-9]+)\/erc721:(0x[0-9a-fA-F]{40})\/([1-9][0-9]*)$/;

export const Caip19AgentSchema = z.string().refine(
  (value) => CAIP19_AGENT_PATTERN.test(value),
  {
    message:
      "CAIP-19 agent asset ID must be eip155:<chainId>/erc721:0x<registry>/<positive decimal agentId>.",
  },
);
export type Caip19Agent = z.infer<typeof Caip19AgentSchema>;

export function caip19Agent(chainId: number | string, registry: string, agentId: number | string): Caip19Agent {
  if (!RAW_ADDRESS_PATTERN.test(registry)) {
    invalidInput(`"${registry}" is not a 20-byte hex address.`);
  }
  return `eip155:${chainId}/erc721:${registry.toLowerCase()}/${agentId}`;
}

// ---------------------------------------------------------------------------
// GitHub Actions OIDC workflow subject (design §3.1/§5, machine identity):
// `repo:<owner>/<repo>:ref:refs/heads/<branch>` and sibling GitHub Actions
// OIDC `sub` claim shapes (environment, pull_request).
// ---------------------------------------------------------------------------

const OIDC_SUBJECT_PATTERN =
  /^repo:[\w.-]+\/[\w.-]+:(?:ref:refs\/(?:heads|tags)\/[\w./-]+|environment:[\w.-]+|pull_request)$/;

export const OidcSubjectSchema = z.string().regex(
  OIDC_SUBJECT_PATTERN,
  "OIDC workflow subject must be a GitHub Actions repo: subject (ref/environment/pull_request).",
);
export type OidcSubject = z.infer<typeof OidcSubjectSchema>;

// ---------------------------------------------------------------------------
// GitHub human identity (design §3.1/§5): login URI + immutable numeric ID,
// always `strength: weak`.
// ---------------------------------------------------------------------------

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export const GithubHumanSchema = z.object({
  profile: z.string().refine(
    (value) => value.startsWith("https://github.com/")
      && GITHUB_LOGIN_PATTERN.test(value.slice("https://github.com/".length)),
    { message: "GitHub human profile must be https://github.com/<login>." },
  ),
  id: z.number().int().positive(),
});
export type GithubHuman = z.infer<typeof GithubHumanSchema>;

// ---------------------------------------------------------------------------
// Agent IRI (design §5, Evidence §5.1): the durable identity. Minted once
// (`urn:uuid:` at bootstrap, or a persistent IRI where one exists), never
// rotated, never a key/address/registry entry.
// ---------------------------------------------------------------------------

export const AgentIriSchema = z.string().refine(isAbsoluteIri, {
  message: "Agent IRI must be an absolute IRI.",
});
export type AgentIri = z.infer<typeof AgentIriSchema>;

// ---------------------------------------------------------------------------
// Voucher identity (design §7.1): the vouching identity behind a key
// binding, canonical spelling per §5. A working key is never a voucher.
// ---------------------------------------------------------------------------

export const VoucherIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), did: DidPkhSchema, contractAccount: z.boolean() }),
  z.object({ kind: z.literal("agentId"), caip19: Caip19AgentSchema }),
  z.object({ kind: z.literal("oidc-machine"), subject: OidcSubjectSchema }),
  z.object({ kind: z.literal("github-human"), profile: GithubHumanSchema.shape.profile, id: GithubHumanSchema.shape.id }),
]);
export type VoucherIdentity = z.infer<typeof VoucherIdentitySchema>;

// ---------------------------------------------------------------------------
// Relationship and scope vocabularies (design §7.1).
// ---------------------------------------------------------------------------

export const RELATIONSHIP_VOCABULARY = ["controls", "operates", "signs-for"] as const;
export const RelationshipSchema = z.enum(RELATIONSHIP_VOCABULARY);
export type Relationship = (typeof RELATIONSHIP_VOCABULARY)[number];

export const SCOPE_VOCABULARY = [
  "authorizations",
  "bindings",
  "deliveries",
  "observations",
  "verdicts",
] as const;
export type ScopeVocabularyMember = (typeof SCOPE_VOCABULARY)[number];

const NAMESPACED_SCOPE_PATTERN = /^[a-z][a-z0-9-]*:[A-Za-z0-9-]+$/;

export function describeScopeVocabulary(): string {
  return `one of ${sortedVocabulary(SCOPE_VOCABULARY).join(", ")}, or a namespaced extension (namespace:custom)`;
}

export const ScopeSchema = z.string().refine(
  (value) => (SCOPE_VOCABULARY as readonly string[]).includes(value)
    || NAMESPACED_SCOPE_PATTERN.test(value),
  { message: `scope must be ${describeScopeVocabulary()}.` },
);
export type Scope = z.infer<typeof ScopeSchema>;

export function isTrustCoreValidationError(error: unknown): error is TrustCoreError {
  return error instanceof TrustCoreError && error.code === "INVALID_INPUT";
}
