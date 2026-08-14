/** Machine-local profile and protected-grant storage. Never point this at a workspace. */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { AGENT_PROFILE_FORMAT, AgentIdSchema, AgentProfileSchema, type AgentProfile } from "./profile.js";
import { readRegularFileNoFollow, regularFileIsReady } from "./safe-file.js";
import { observeAgentVersion, type AgentVersionCommand } from "./version.js";

const CREDENTIAL_FORMAT = "colophon-agent-credential/1" as const;
const SecretBasenameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/u).refine((value) => value !== "." && value !== "..");
const CredentialGrantSchema = z.object({
  format: z.literal(CREDENTIAL_FORMAT),
  agentId: AgentIdSchema,
  kind: z.enum(["api-key", "credential-artifact"]),
  secretBasename: SecretBasenameSchema,
}).strict();

export type CredentialGrant = z.infer<typeof CredentialGrantSchema>;

export interface AgentRuntimeBinding {
  readonly profile: AgentProfile;
  readonly credential: CredentialGrant;
  /** Host-only protected file path. Never write this into a task, submission, plan, or bundle. */
  readonly credentialFile: string;
}

/** Evidence that an exact harness version can keep its login artifact in the terminal-wiped boundary. */
export interface HarnessLoginQualification {
  readonly adapter: AgentProfile["adapter"];
  readonly executableSha256: string;
  readonly executableVersion: string;
  readonly mode: "credential-artifact";
}

/** Empty until a real isolated login flow is qualified. This is a fail-closed policy table. */
export const QUALIFIED_HARNESS_LOGIN_ARTIFACTS: readonly HarnessLoginQualification[] = [];

function profilePath(dataDir: string, agentId: string): string {
  return join(dataDir, "agents", `${agentId}.json`);
}
function credentialPath(dataDir: string, agentId: string): string {
  return join(dataDir, "credentials", `${agentId}.json`);
}
function protectedSecretPath(dataDir: string, basenameValue: string): string {
  return join(dataDir, "secrets", basenameValue);
}

function parseDocument<T>(schema: z.ZodType<T>, path: string): T {
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(readRegularFileNoFollow(path, { maximumBytes: 1_048_576 }))));
  } catch {
    throw new Error(`invalid Colophon machine-local document at ${path}`);
  }
}

function assertMachineLocalRoot(dataDir: string): void {
  if (!dataDir.startsWith("/")) throw new Error("Colophon agent data directory must be absolute");
  // A workspace is recognizable from its own metadata. Refusing it prevents a caller from
  // accidentally committing profile or secret artifacts with their benchmark evidence.
  if (existsSync(join(dataDir, "workspace.json"))) throw new Error("Colophon agent data directory must not be a benchmark workspace");
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Colophon agent storage directory must be a non-symlink directory");
  chmodSync(path, 0o700);
}

export function storeAgentProfile(
  dataDir: string,
  input: unknown,
  options: { readonly versionCommand?: AgentVersionCommand } = {},
): AgentProfile {
  assertMachineLocalRoot(dataDir);
  ensurePrivateDirectory(dataDir);
  ensurePrivateDirectory(join(dataDir, "agents"));
  const profile = AgentProfileSchema.parse(input);
  const executableBytes = readRegularFileNoFollow(profile.executable.path);
  const actualDigest = createHash("sha256").update(executableBytes).digest("hex");
  if (actualDigest !== profile.executable.sha256) throw new Error("agent executable digest does not match the supplied profile");
  const observedVersion = observeAgentVersion(profile, options.versionCommand);
  if (observedVersion !== profile.executable.version) {
    throw new Error(`agent executable version does not match the supplied profile: observed ${observedVersion}`);
  }
  const stored = { ...profile, executable: { ...profile.executable, version: observedVersion } };
  atomicWriteFileSync(profilePath(dataDir, profile.agentId), JSON.stringify(stored, null, 2));
  chmodSync(profilePath(dataDir, profile.agentId), 0o600);
  return stored;
}

export function readAgentProfile(dataDir: string, agentId: string): AgentProfile | undefined {
  assertMachineLocalRoot(dataDir);
  if (!AgentIdSchema.safeParse(agentId).success) throw new Error("agentId must match [A-Za-z0-9_-]{1,64}");
  const path = profilePath(dataDir, agentId);
  return existsSync(path) ? parseDocument(AgentProfileSchema, path) : undefined;
}

export function listAgentProfiles(dataDir: string): readonly AgentProfile[] {
  assertMachineLocalRoot(dataDir);
  const directory = join(dataDir, "agents");
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Colophon agent profile directory must be a non-symlink directory");
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => parseDocument(AgentProfileSchema, join(directory, entry)));
}

/**
 * Copies only the explicitly supplied API-key file into a Colophon-owned 0700 directory.
 * It never reads, copies, or points at either harness's normal home/config directory.
 */
export function storeApiKeyCredential(dataDir: string, agentId: string, sourceFile: string): CredentialGrant {
  return storeProtectedCredential(dataDir, agentId, sourceFile, "api-key");
}

function storeProtectedCredential(
  dataDir: string,
  agentId: string,
  sourceFile: string,
  kind: CredentialGrant["kind"],
): CredentialGrant {
  assertMachineLocalRoot(dataDir);
  ensurePrivateDirectory(dataDir);
  AgentIdSchema.parse(agentId);
  const source = resolve(sourceFile);
  if (source.split("/").some((part) => part === ".codex" || part === ".claude")) {
    throw new Error("API key source must not be copied from a normal harness home");
  }
  const sourceBytes = readRegularFileNoFollow(source, { maximumBytes: 1_048_576 });
  const secretBasename = `${agentId}.${kind === "api-key" ? "api-key" : "login-artifact"}`;
  const target = protectedSecretPath(dataDir, secretBasename);
  ensurePrivateDirectory(join(dataDir, "secrets"));
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("protected credential target must not be a symlink");
  atomicWriteFileSync(target, sourceBytes);
  chmodSync(target, 0o600);
  const grant: CredentialGrant = { format: CREDENTIAL_FORMAT, agentId, kind, secretBasename };
  ensurePrivateDirectory(join(dataDir, "credentials"));
  atomicWriteFileSync(credentialPath(dataDir, agentId), JSON.stringify(grant, null, 2));
  chmodSync(credentialPath(dataDir, agentId), 0o600);
  return grant;
}

/**
 * Stores a captured credential-only login artifact only when the internal qualification table
 * exactly binds adapter, executable digest, and version. The empty production table fails closed.
 */
export function storeQualifiedLoginArtifact(
  dataDir: string,
  profile: AgentProfile,
  sourceFile: string,
): CredentialGrant {
  if (!harnessLoginIsQualified(profile)) {
    throw new Error("login artifact is not qualified for the stored agent profile");
  }
  return storeProtectedCredential(dataDir, profile.agentId, sourceFile, "credential-artifact");
}

function harnessLoginIsQualified(profile: AgentProfile): boolean {
  return QUALIFIED_HARNESS_LOGIN_ARTIFACTS.some((qualification) =>
    qualification.mode === "credential-artifact"
    && qualification.adapter === profile.adapter
    && qualification.executableSha256 === profile.executable.sha256
    && qualification.executableVersion === profile.executable.version);
}

export function readCredentialGrant(dataDir: string, agentId: string): CredentialGrant | undefined {
  assertMachineLocalRoot(dataDir);
  AgentIdSchema.parse(agentId);
  const path = credentialPath(dataDir, agentId);
  return existsSync(path) ? parseDocument(CredentialGrantSchema, path) : undefined;
}

/** The descriptor is safe to give a neutral SecretForwardResolver; it is not a secret value. */
export function credentialGrantDescriptor(dataDir: string, grant: CredentialGrant): { readonly file: string } {
  const file = protectedSecretPath(dataDir, grant.secretBasename);
  if (basename(file) !== grant.secretBasename || !file.startsWith(`${join(dataDir, "secrets")}/`)) {
    throw new Error("credential grant resolves outside the protected secrets directory");
  }
  return { file };
}

export function credentialGrantIsReady(dataDir: string, grant: CredentialGrant): boolean {
  return regularFileIsReady(credentialGrantDescriptor(dataDir, grant).file, {
    maximumBytes: 1_048_576,
    requiredMode: 0o600,
    requireCurrentUser: true,
  });
}

/** Returns only qualified protected API-key bindings; uncredentialed profiles do not advertise a runnable harness. */
export function configuredAgentRuntimes(dataDir: string): readonly AgentRuntimeBinding[] {
  return listAgentProfiles(dataDir).flatMap((profile) => {
    const credential = readCredentialGrant(dataDir, profile.agentId);
    if (credential === undefined || !credentialGrantIsReady(dataDir, credential)) return [];
    if (credential.kind === "credential-artifact" && !harnessLoginIsQualified(profile)) return [];
    return [{ profile, credential, credentialFile: credentialGrantDescriptor(dataDir, credential).file }];
  });
}

/** No provider login is run until the exact pinned harness version has been independently qualified. */
export function requireQualifiedHarnessLogin(profile: AgentProfile): never {
  if (harnessLoginIsQualified(profile)) {
    throw new Error(`${profile.adapter} login capture is qualified but has not been invoked with a fresh credential-only destination`);
  }
  throw new Error(
    `${profile.adapter} login is not qualified for this pinned harness version; Colophon will not read or copy an existing harness home`,
  );
}

export { AGENT_PROFILE_FORMAT, CREDENTIAL_FORMAT };
