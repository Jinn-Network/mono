/**
 * Document Registry Type Definitions
 *
 * Metadata schema for ERC-8004 Identity Registry document registration.
 */

// ---------------------------------------------------------------------------
// Document Types
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = [
  'adw:Blueprint',
  'adw:Skill',
  'adw:Template',
  'adw:Artifact',
  'adw:Configuration',
  'adw:Knowledge',
  'adw:AgentCard',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Cross-System Identifiers
// ---------------------------------------------------------------------------

export interface Identifier {
  system: 'erc8004' | 'ens' | 'olas' | 'did' | string;
  id: string;
}

// ---------------------------------------------------------------------------
// Storage Locations
// ---------------------------------------------------------------------------

export interface StorageLocation {
  provider: 'ipfs' | 'arweave' | 'https' | string;
  uri: string;
  gateway?: string;
  contentDigest?: string;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface ProvenanceSource {
  contentHash: string;
  relationship: 'blueprint' | 'input' | 'context' | 'template' | 'predecessor' | 'review' | string;
  description?: string;
}

export interface ExecutionProvenance {
  agent?: string;
  requestId?: string;
  blueprint?: string;
  tools?: string[];
  chain?: string;
  requestTransaction?: string;
  deliveryTransaction?: string;
  timestamp?: string;
  duration?: string;
}

export interface Provenance {
  method: 'agent-execution' | 'human-authored' | 'generated' | string;
  execution?: ExecutionProvenance;
  derivedFrom?: ProvenanceSource[];
  zkProof?: {
    type: string;
    verifier?: string;
    proof?: string;
    publicInputs?: string[];
  };
}

// ---------------------------------------------------------------------------
// Trust & Verification
// ---------------------------------------------------------------------------

export interface CreatorProof {
  type: 'EIP-712';
  signer: string;
  signature: string;
  message: {
    contentHash: string;
    documentType: string;
    version: string;
    timestamp: string;
  };
}

export interface Trust {
  creatorProof?: CreatorProof;
  level?: 0 | 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Type-Specific Profiles
// ---------------------------------------------------------------------------

export interface BlueprintProfile {
  invariants?: Array<{
    id: string;
    type?: string;
    condition?: string;
    assessment?: string;
  }>;
  inputSchema?: Record<string, unknown>;
  outputSpec?: Record<string, unknown>;
  enabledTools?: Array<{ name: string; required?: boolean }>;
  estimatedDuration?: string;
  safetyTier?: string;
}

export interface SkillProfile {
  format?: string;
  allowedTools?: string[];
  triggers?: string[];
  targetAgent?: string;
  dependencies?: string[];
}

export interface TemplateProfile {
  blueprintHash?: string;
  inputSchema?: Record<string, unknown>;
  outputSpec?: Record<string, unknown>;
  pricing?: {
    priceWei?: string;
    currency?: string;
    paymentModel?: string;
  };
  safetyTier?: string;
  status?: string;
  executionCount?: number;
  averageDuration?: string;
}

export interface ArtifactProfile {
  topic?: string;
  artifactType?: string;
  sourceExecution?: {
    requestId?: string;
    jobDefinitionId?: string;
    agentId?: string;
  };
  contentPreview?: string;
  utilityScore?: number;
  accessCount?: number;
}

export interface ConfigurationProfile {
  targetSchema?: string;
  targetDocument?: string;
  parameters?: Record<string, unknown>;
}

export type Profile =
  | BlueprintProfile
  | SkillProfile
  | TemplateProfile
  | ArtifactProfile
  | ConfigurationProfile
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Registration File
// ---------------------------------------------------------------------------

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export interface RegistrationFile {
  // Core metadata (REQUIRED)
  type: typeof REGISTRATION_TYPE;
  documentType: DocumentType;
  version: string;
  name: string;
  description: string;
  contentHash: string;
  creator: string;
  created: string;

  // Extended metadata (OPTIONAL)
  license?: string;
  language?: string;
  tags?: string[];
  supersedes?: string;
  supersededBy?: string | null;
  deprecated?: boolean;
  identifiers?: Identifier[];
  storage?: StorageLocation[];
  provenance?: Provenance;
  trust?: Trust;
  profile?: Profile;
}
