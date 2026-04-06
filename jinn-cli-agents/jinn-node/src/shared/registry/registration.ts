/**
 * Registration File Builder
 *
 * Pure function that constructs a Registration File from existing
 * artifact/document data. No IO — just data mapping.
 */

import type {
  RegistrationFile,
  DocumentType,
  Profile,
  Provenance,
  Trust,
  StorageLocation,
  Identifier,
} from './types.js';
import { REGISTRATION_TYPE } from './types.js';

export interface BuildRegistrationFileParams {
  // Required fields
  contentHash: string;
  name: string;
  documentType: DocumentType;
  creator: string;

  // Optional core
  description?: string;
  version?: string;
  created?: string;

  // Extended
  tags?: string[];
  license?: string;
  language?: string;
  supersedes?: string;
  identifiers?: Identifier[];
  storage?: StorageLocation[];
  provenance?: Provenance;
  trust?: Trust;
  profile?: Profile;
}

/**
 * Build a Registration File from artifact/document data.
 *
 * Maps existing Jinn fields to ERC-8004 registration metadata:
 *   cid          → contentHash
 *   name         → name
 *   topic        → profile.topic (for artifacts)
 *   type         → profile.artifactType (for artifacts)
 *   tags         → tags
 *   worker addr  → creator (formatted as eip155:8453:0x...)
 */
export function buildRegistrationFile(params: BuildRegistrationFileParams): RegistrationFile {
  const {
    contentHash,
    name,
    documentType,
    creator,
    description = '',
    version = '1.0.0',
    created = new Date().toISOString(),
    tags,
    license,
    language,
    supersedes,
    identifiers,
    storage,
    provenance,
    trust,
    profile,
  } = params;

  const registration: RegistrationFile = {
    type: REGISTRATION_TYPE,
    documentType,
    version,
    name,
    description,
    contentHash,
    creator,
    created,
  };

  // Extended metadata — only include if present
  if (tags?.length) registration.tags = tags;
  if (license) registration.license = license;
  if (language) registration.language = language;
  if (supersedes) registration.supersedes = supersedes;
  if (identifiers?.length) registration.identifiers = identifiers;
  if (storage?.length) registration.storage = storage;
  if (provenance) registration.provenance = provenance;
  if (trust) registration.trust = trust;
  if (profile) registration.profile = profile;

  return registration;
}

/**
 * Format a wallet address as a creator identifier.
 * Uses CAIP-10 format: eip155:{chainId}:{address}
 */
export function formatCreatorId(address: string, chainId: number = 8453): string {
  return `eip155:${chainId}:${address}`;
}

/**
 * Build an IPFS storage location entry.
 */
export function buildIpfsStorageLocation(cid: string, gateway?: string): StorageLocation {
  return {
    provider: 'ipfs',
    uri: `ipfs://${cid}`,
    ...(gateway ? { gateway } : {}),
  };
}
