#!/usr/bin/env tsx
/**
 * Generic Workstream Launcher
 *
 * Launches a blueprint-based workstream with automatic GitHub repository creation.
 *
 * Usage: yarn launch:workstream <blueprint-name> [options]
 *
 * Options:
 *   --dry-run         Print what would happen without creating repo or dispatching
 *   --model           Specify model (default: gemini-2.5-flash)
 *   --context         Additional context string to inject
 *   --skip-repo       Skip GitHub repository creation (artifact-only mode)
 *   --repo            Use existing repo (e.g., "owner/repo"). Auto-clones locally if needed.
 *   --cyclic          Enable continuous operation (auto-redispatch after completion)
 *
 * Example:
 *   yarn launch:workstream x402-data-service
 *   yarn launch:workstream x402-data-service.json --dry-run
 *   yarn launch:workstream blog-growth-orchestrator --repo=Jinn-Network/jinn-blog
 *   yarn launch:workstream monitoring-job --cyclic
 */

import 'dotenv/config';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { getServiceProfile } from 'jinn-node/env/operate-profile.js';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { scriptLogger } from 'jinn-node/logging';
import { buildIpfsPayload } from 'jinn-node/agent/shared/ipfs-payload-builder.js';
import { deepSubstitute, loadInputConfig } from './shared/template-substitution.js';
import { resolveGitUrl } from './shared/git-url.js';
import { validateInvariantsStrict } from 'jinn-node/worker/prompt/invariant-validator.js';
import { extractToolPolicyFromBlueprint } from 'jinn-node/shared/template-tools.js';
import { getRandomStakedMech } from 'jinn-node/worker/filters/stakingFilter.js';
import { assertValidJinnJobEnvKey } from 'jinn-node/shared/job-env.js';

interface GitHubRepoResponse {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

async function loadBlueprint(filename: string): Promise<{ content: string; path: string; name: string }> {
  // Auto-append .json if not present
  let blueprintFile = filename;
  if (!blueprintFile.endsWith('.json')) {
    blueprintFile = `${blueprintFile}.json`;
  }

  // Try exact path first, then look in blueprints dir
  let blueprintPath = blueprintFile;
  if (!blueprintFile.includes('/')) {
    blueprintPath = join(process.cwd(), 'blueprints', blueprintFile);
  }

  try {
    const content = await readFile(blueprintPath, 'utf-8');
    const name = basename(blueprintPath, extname(blueprintPath));
    return { content, path: blueprintPath, name };
  } catch (err) {
    throw new Error(`Could not load blueprint '${filename}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function createGitHubRepo(repoName: string, token: string): Promise<GitHubRepoResponse> {
  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false, // We'll initialize it ourselves
      description: `Workstream repository for ${repoName}`,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 422 && errorBody.includes('already exists')) {
      throw new RepoExistsError(repoName);
    }
    throw new Error(`GitHub API error (${response.status}): ${errorBody}`);
  }

  return await response.json() as GitHubRepoResponse;
}

class RepoExistsError extends Error {
  constructor(public repoName: string) {
    super(`Repository '${repoName}' already exists`);
    this.name = 'RepoExistsError';
  }
}

async function initializeRepo(localPath: string, sshUrl: string, repoName: string): Promise<void> {
  // Create directory
  await mkdir(localPath, { recursive: true });

  // Initialize git repo
  execSync('git init', { cwd: localPath, stdio: 'pipe' });

  // Create minimal README
  const readmeContent = `# ${repoName}\n`;
  await writeFile(join(localPath, 'README.md'), readmeContent, 'utf-8');

  // Git initial commit
  execSync('git add README.md', { cwd: localPath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: localPath, stdio: 'pipe' });

  // Create main branch explicitly (in case default is not 'main')
  try {
    execSync('git branch -M main', { cwd: localPath, stdio: 'pipe' });
  } catch {
    // Ignore if already on main
  }

  // Add remote and push using SSH (consistent with --repo flag pattern)
  execSync(`git remote add origin ${sshUrl}`, { cwd: localPath, stdio: 'pipe' });
  execSync('git push -u origin main', { cwd: localPath, stdio: 'pipe' });
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('dry-run', { type: 'boolean', description: 'Simulate without creating repo or dispatching' })
    .option('model', { type: 'string', default: 'gemini-3-flash-preview', description: 'Model to use' })
    .option('context', { type: 'string', description: 'Additional context to inject' })
    .option('skip-repo', { type: 'boolean', description: 'Skip GitHub repository creation (artifact-only mode)' })
    .option('repo', { type: 'string', description: 'Use existing repo. Format: "owner/repo" or "ssh-host:owner/repo" (e.g., "ritsukai:Jinn-Network/jinn-blog")' })
    .option('cyclic', { type: 'boolean', description: 'Enable continuous operation (auto-redispatch after completion)' })
    .option('input', { type: 'string', description: 'Path to JSON config file with template inputs for variable substitution' })
    .option('env', { type: 'array', description: 'Environment variables to inject (KEY=VALUE format, repeatable)' })
    .option('workspace-repo', { type: 'string', description: 'Repository URL to clone as workspace for the agent' })
    .option('venture-id', { type: 'string', description: 'Venture UUID to associate with this workstream (required for VENTURE_FILTER workers)' })
    .demandCommand(1, 'Please provide a blueprint filename (e.g., x402-data-service)')
    .help()
    .parse();

  const blueprintArg = String(argv._[0]);

  try {
    scriptLogger.info('Loading blueprint...');
    const { content: blueprintContent, path: blueprintPath, name: blueprintName } = await loadBlueprint(blueprintArg);
    scriptLogger.info({ blueprintPath }, 'Blueprint loaded');

    // 3-letter random suffix (used for repo disambiguation and job name)
    const shortId = Math.random().toString(36).substring(2, 5).toUpperCase();

    // Convert kebab-case or snake_case to Title Case for job name
    const title = blueprintName
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    const jobName = `${title} – ${shortId}`;

    // Prepare context
    let context = argv.context || '';

    let repoPath: string | undefined;
    let repoUrl: string | undefined;

    // Load input config early if provided (needed to extract repoUrl before repo handling)
    let inputConfig: Record<string, unknown> | undefined;
    if (argv.input) {
      scriptLogger.info({ inputPath: argv.input }, 'Loading input config...');
      try {
        inputConfig = await loadInputConfig(argv.input);
        scriptLogger.info({ keys: Object.keys(inputConfig) }, 'Input config loaded');
      } catch (err) {
        scriptLogger.error({ inputPath: argv.input, error: err }, 'Failed to load input config');
        throw err;
      }
    }

    // Auto-detect repoUrl from input config if --repo not explicitly provided
    let effectiveRepoArg = argv.repo as string | undefined;
    if (!effectiveRepoArg && inputConfig?.repoUrl) {
      const configRepoUrl = inputConfig.repoUrl as string;
      // Extract owner/repo from various URL formats
      // HTTPS: https://github.com/owner/repo
      // SSH: git@host:owner/repo.git
      const httpsMatch = configRepoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      const sshMatch = configRepoUrl.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        effectiveRepoArg = httpsMatch[1];
        scriptLogger.info({ repoUrl: configRepoUrl, effectiveRepoArg }, 'Using repoUrl from input config (HTTPS)');
      } else if (sshMatch) {
        const [, sshHost, owner, repoName] = sshMatch;
        effectiveRepoArg = `${sshHost}:${owner}/${repoName}`;
        scriptLogger.info({ repoUrl: configRepoUrl, effectiveRepoArg, sshHost }, 'Using repoUrl from input config (SSH)');
      }
    }

    // Option 1: Use existing repo (--repo flag or from input config)
    if (effectiveRepoArg) {
      const repoSpec = effectiveRepoArg;

      // Parse formats:
      // - "owner/repo" → ssh-host defaults to github.com
      // - "ssh-host:owner/repo" → custom ssh-host
      let sshHost = 'github.com';
      let owner: string;
      let repoName: string;

      const hostMatch = repoSpec.match(/^([^:]+):([^/]+)\/([^/]+)$/);
      const simpleMatch = repoSpec.match(/^([^/]+)\/([^/]+)$/);

      if (hostMatch) {
        // Format: ssh-host:owner/repo
        [, sshHost, owner, repoName] = hostMatch;
      } else if (simpleMatch) {
        // Format: owner/repo
        [, owner, repoName] = simpleMatch;
      } else {
        throw new Error(`Invalid repo format: "${repoSpec}". Expected "owner/repo" or "ssh-host:owner/repo"`);
      }

      const cloneUrl = `git@${sshHost}:${owner}/${repoName}.git`;
      repoUrl = `https://github.com/${owner}/${repoName}`;

      const workerId = process.env.WORKER_ID || 'default';
      const workstreamsDir = join(homedir(), '.jinn', 'workstreams', 'workers', workerId);
      await mkdir(workstreamsDir, { recursive: true });
      repoPath = join(workstreamsDir, repoName);

      scriptLogger.info({ repoSpec, repoPath }, 'Using existing repository');

      // Clone if doesn't exist, otherwise fetch
      const { existsSync } = await import('fs');
      if (!existsSync(repoPath)) {
        scriptLogger.info({ cloneUrl, repoPath }, 'Cloning repository...');
        try {
          execSync(`git clone ${cloneUrl} ${repoPath}`, { stdio: 'pipe' });
          scriptLogger.info('Repository cloned');
        } catch (cloneError: any) {
          const stderr = String(cloneError?.message || '');
          const authFailed = stderr.includes('Permission denied (publickey)') || stderr.includes('publickey');
          const token = process.env.GITHUB_TOKEN;
          const httpsCloneUrl = token ? `https://${token}@github.com/${owner}/${repoName}.git` : `https://github.com/${owner}/${repoName}.git`;

          if (authFailed) {
            try {
              execSync(`git clone ${httpsCloneUrl} ${repoPath}`, { stdio: 'pipe' });
              scriptLogger.info('Repository cloned via HTTPS');
            } catch (fallbackError: any) {
              throw fallbackError;
            }
          } else {
            throw cloneError;
          }
        }
      } else {
        scriptLogger.info({ repoPath }, 'Repository already exists locally, fetching...');
        execSync('git fetch --all', { cwd: repoPath, stdio: 'pipe' });
        scriptLogger.info('Fetched latest');
      }

      // Add repo context
      if (!context) {
        context = `Repository: ${repoUrl}\nLocal path: ${repoPath}`;
      } else {
        context = `${context}\n\nRepository: ${repoUrl}\nLocal path: ${repoPath}`;
      }
    }
    // Option 2: Create new GitHub repo (default, unless --skip-repo)
    else if (!argv.skipRepo) {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error('GITHUB_TOKEN environment variable is required for repository creation. Use --skip-repo to launch without a repository.');
      }

      let repoName = blueprintName; // Start with blueprint name

      scriptLogger.info({ repoName }, 'Creating GitHub repository');

      if (argv.dryRun) {
        scriptLogger.info('[DRY RUN] Would create private repository');
      } else {
        let repo: GitHubRepoResponse;
        try {
          repo = await createGitHubRepo(repoName, githubToken);
        } catch (error) {
          if (error instanceof RepoExistsError) {
            // Repo exists, append suffix and retry
            repoName = `${blueprintName}-${shortId.toLowerCase()}`;
            scriptLogger.info({ repoName }, 'Repository exists, retrying with suffix');
            repo = await createGitHubRepo(repoName, githubToken);
          } else {
            throw error;
          }
        }

        repoUrl = repo.html_url;
        scriptLogger.info({ repoUrl }, 'Repository created');

        // Clone to local workstream directory (with worker isolation)
        const workerId = process.env.WORKER_ID || 'default';
        const workstreamsDir = join(homedir(), '.jinn', 'workstreams', 'workers', workerId);
        repoPath = join(workstreamsDir, repoName);

        scriptLogger.info({ repoPath }, 'Initializing local repository');
        // Replace github.com with SSH host alias if configured (for multi-account SSH configs)
        const sshUrl = resolveGitUrl(repo.ssh_url, {
          sshHost: inputConfig?.sshHost as string | undefined,
        });
        if (sshUrl !== repo.ssh_url) {
          scriptLogger.debug({ originalSshUrl: repo.ssh_url, sshUrl, sshHost: inputConfig?.sshHost }, 'Using SSH host alias from input config');
        }
        await initializeRepo(repoPath, sshUrl, repoName);
        scriptLogger.info('Initialized and pushed to main branch');

        // Add repo context
        if (!context) {
          context = `Repository: ${repoUrl}\nLocal path: ${repoPath}`;
        } else {
          context = `${context}\n\nRepository: ${repoUrl}\nLocal path: ${repoPath}`;
        }
      }
    } else {
      scriptLogger.info('Skipping repository creation (--skip-repo flag set)');
    }

    // Inject context into blueprint
    let blueprintObj = JSON.parse(blueprintContent);

    // Apply variable substitution if input config was loaded
    if (inputConfig) {
      // Deep substitute {{variable}} placeholders throughout the blueprint
      blueprintObj = deepSubstitute(blueprintObj, inputConfig, blueprintObj.inputSchema);
      scriptLogger.info('Variable substitution applied to blueprint');

      // Inject input config into blueprint context so agent can access parameters
      // This ensures workstreamId and other input fields reach the agent
      if (Object.keys(inputConfig).length > 0) {
        const inputSection = `\n\n[INPUT PARAMETERS]\n${JSON.stringify(inputConfig, null, 2)}`;
        blueprintObj.context = (blueprintObj.context || '') + inputSection;
        scriptLogger.info({ keys: Object.keys(inputConfig) }, 'Input parameters injected into context');
      }
    }

    if (blueprintObj.context) {
      blueprintObj.context = `${blueprintObj.context}\n\n[LAUNCHER CONTEXT]\n${context}`;
    } else {
      blueprintObj.context = context || `Launched via generic launcher on ${new Date().toISOString()}.\nBlueprint: ${blueprintName}`;
    }

    // Validate invariants early (before dispatch) to catch schema errors
    const invariants = blueprintObj.invariants || blueprintObj.assertions || [];
    if (invariants.length > 0) {
      scriptLogger.info({ count: invariants.length }, 'Validating invariants...');
      try {
        validateInvariantsStrict(invariants);
        scriptLogger.info('Invariants valid');
      } catch (err) {
        scriptLogger.error({ error: err instanceof Error ? err.message : String(err) }, 'Invalid invariants in blueprint');
        throw new Error(`Blueprint has invalid invariants: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Strip template metadata before dispatching
    // We only want the agent to see invariants, context, and outputSpec
    const cleanBlueprint: Record<string, unknown> = {
      invariants: blueprintObj.invariants || blueprintObj.assertions || [],
      context: blueprintObj.context
    };
    // Include outputSpec so OutputInvariantProvider can generate constraints
    if (blueprintObj.outputSpec) {
      cleanBlueprint.outputSpec = blueprintObj.outputSpec;
    }
    const finalBlueprint = JSON.stringify(cleanBlueprint);

    const { requiredTools, availableTools } = extractToolPolicyFromBlueprint(blueprintObj);
    const enabledTools = requiredTools.length > 0
      ? requiredTools
      : (availableTools.length > 0 ? availableTools : [
        'google_web_search',
        'create_artifact',
        'write_file',
        'read_file',
        'replace',
        'list_directory',
        'run_shell_command',
        'dispatch_new_job',
      ]);

    // Parse --env flags into additionalContextOverrides
    const additionalContextOverrides: {
      env?: Record<string, string>;
      workspaceRepo?: { url: string; branch?: string };
    } = {};

    if (argv.env && Array.isArray(argv.env) && argv.env.length > 0) {
      additionalContextOverrides.env = {};
      for (const pair of argv.env as string[]) {
        const [key, ...rest] = String(pair).split('=');
        if (!key || rest.length === 0) {
          throw new Error(`Invalid --env value "${pair}". Expected format: JINN_JOB_KEY=value`);
        }
        assertValidJinnJobEnvKey(key, '--env');
        additionalContextOverrides.env[key] = rest.join('=');
        scriptLogger.debug({ key }, 'Parsed environment variable from --env flag');
      }
    }

    // Parse --workspace-repo flag
    if (argv.workspaceRepo) {
      additionalContextOverrides.workspaceRepo = { url: String(argv.workspaceRepo) };
      scriptLogger.debug({ url: argv.workspaceRepo }, 'Parsed workspace repo from --workspace-repo flag');
    }

    // Extract env vars from inputConfig using inputSchema.envVar mappings
    // inputSchema can be at root level or inside templateMeta
    const inputSchema = blueprintObj.templateMeta?.inputSchema ?? blueprintObj.inputSchema;
    if (inputConfig && inputSchema?.properties) {
      const extractedEnv: Record<string, string> = {};
      for (const [field, spec] of Object.entries(inputSchema.properties)) {
        const fieldSpec = spec as { envVar?: string };
        if (fieldSpec.envVar && inputConfig[field] !== undefined) {
          assertValidJinnJobEnvKey(fieldSpec.envVar, `inputSchema.properties.${field}.envVar`);
          extractedEnv[fieldSpec.envVar] = String(inputConfig[field]);
          scriptLogger.debug({ field, envVar: fieldSpec.envVar }, 'Extracted env var from inputConfig');
        }
      }

      if (Object.keys(extractedEnv).length > 0) {
        // Merge with CLI --env flags (CLI takes precedence)
        additionalContextOverrides.env = { ...extractedEnv, ...additionalContextOverrides.env };
        scriptLogger.info({ count: Object.keys(extractedEnv).length }, 'Extracted env vars from inputConfig');
      }
    }

    scriptLogger.info({
      jobName,
      blueprint: blueprintName,
      model: argv.model,
      repoPath,
      envVars: additionalContextOverrides.env ? Object.keys(additionalContextOverrides.env) : [],
    }, 'Job configuration');

    if (argv.dryRun) {
      scriptLogger.info('Dry run complete. No job dispatched.');
      if (repoPath) {
        scriptLogger.info('Note: Repository was NOT created (dry run mode).');
      }
      return;
    }

    scriptLogger.info('Dispatching job...');

    // Set CODE_METADATA_REPO_ROOT if we created a repo
    if (repoPath) {
      process.env.CODE_METADATA_REPO_ROOT = repoPath;
      scriptLogger.debug({ CODE_METADATA_REPO_ROOT: repoPath }, 'Set CODE_METADATA_REPO_ROOT');
    }

    const jobDefinitionId = randomUUID();
    const profile = getServiceProfile();

    if (!profile.mechAddress) {
      throw new Error('No mech address found in operate-profile. Run setup:service first.');
    }
    if (!profile.privateKey) {
      throw new Error('No private key found in operate-profile. Check .operate/keys directory.');
    }

    // Clear any stale JINN_* env vars before building payload
    // This prevents env contamination from previous worker runs that could
    // pollute the baseBranch and other metadata in the IPFS payload
    const jinnEnvVars = Object.keys(process.env).filter(k => k.startsWith('JINN_'));
    if (jinnEnvVars.length > 0) {
      scriptLogger.warn({ clearedVars: jinnEnvVars }, 'Clearing stale JINN_* env vars before payload build');
      for (const key of jinnEnvVars) {
        delete process.env[key];
      }
    }

    // Use shared payload builder for ALL dispatches (cyclic and non-cyclic)
    // This ensures consistent payload structure with codeMetadata, lineage, etc.
    scriptLogger.info({ cyclic: !!argv.cyclic }, 'Building IPFS payload...');

    const { ipfsJsonContents } = await buildIpfsPayload({
      blueprint: finalBlueprint,
      jobName,
      jobDefinitionId,
      model: argv.model as string,
      enabledTools,
      tools: blueprintObj?.templateMeta?.tools ?? blueprintObj?.tools,
      cyclic: !!argv.cyclic,
      ventureId: argv.ventureId as string | undefined,
      additionalContextOverrides: Object.keys(additionalContextOverrides).length > 0
        ? additionalContextOverrides
        : undefined,
    });

    // Dispatch via marketplaceInteract
    const priorityMech = await getRandomStakedMech(profile.mechAddress);
    const result = await marketplaceInteract({
      prompts: [finalBlueprint],
      priorityMech,
      tools: enabledTools,
      ipfsJsonContents,
      chainConfig: profile.chainConfig,
      keyConfig: { source: 'value', value: profile.privateKey },
      postOnly: true,
      responseTimeout: 61,
    });

    if (!result?.request_ids?.[0]) {
      throw new Error('No request ID returned from marketplace dispatch');
    }

    const requestId = result.request_ids[0];

    scriptLogger.info({
      requestId,
      repoUrl,
      repoPath,
      explorerUrl: `https://explorer.jinn.network/workstreams/${requestId}`,
      runCommand: `yarn dev:mech --workstream=${requestId} --runs=15`,
      runParallelCommand: `yarn dev:mech:parallel --workstream=${requestId} --runs=15`,
    }, 'Workstream dispatched successfully');

  } catch (error) {
    scriptLogger.error({
      err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    }, 'Launch failed');
    process.exit(1);
  }
}

main();

