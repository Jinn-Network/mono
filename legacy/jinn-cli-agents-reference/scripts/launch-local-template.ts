#!/usr/bin/env tsx
/**
 * Generic Local Template Launcher
 * 
 * Launches any local blueprint file as a job, with support for input variables.
 * 
 * Usage:
 *   yarn launch:template blueprints/code-health-venture.json --input '{"repoUrl": "..."}'
 *   yarn launch:template my-blueprint.json --dry-run
 */

import 'dotenv/config';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { execSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { scriptLogger } from 'jinn-node/logging';
import { extractToolPolicyFromBlueprint } from 'jinn-node/shared/template-tools.js';
import { resolveGitUrl } from './shared/git-url.js';

// --- Helper Functions (Reused from x402-execute-template.ts) ---

/**
 * Substitute {{variable}} placeholders in a string with input values.
 * Falls back to defaults from inputSchema if available.
 */
function substituteVariables(
    text: string,
    input: Record<string, any>,
    inputSchema?: Record<string, any>
): string {
    return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        // Check input first
        if (input[varName] !== undefined) {
            return String(input[varName]);
        }
        // Fall back to default from schema
        const schemaProp = inputSchema?.properties?.[varName];
        if (schemaProp?.default !== undefined) {
            return String(schemaProp.default);
        }
        // Keep placeholder if no value found (agent will see it as-is)
        scriptLogger.warn({ varName }, 'No value found for template variable');
        return match;
    });
}

/**
 * Deep substitute variables in an object (recursively processes strings).
 */
function deepSubstitute(
    obj: any,
    input: Record<string, any>,
    inputSchema?: Record<string, any>
): any {
    if (typeof obj === 'string') {
        return substituteVariables(obj, input, inputSchema);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => deepSubstitute(item, input, inputSchema));
    }
    if (obj && typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = deepSubstitute(value, input, inputSchema);
        }
        return result;
    }
    return obj;
}

// --- Repo Setup Logic ---

async function prepareRepo(repoUrl: string, targetDir: string): Promise<string> {
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'unknown-repo';
    const repoPath = join(targetDir, repoName);

    scriptLogger.info({ repoUrl, repoPath }, 'Preparing repository...');

    // Convert HTTPS GitHub URL to SSH format for consistent auth pattern
    const gitUrl = resolveGitUrl(repoUrl);
    if (gitUrl !== repoUrl) {
        scriptLogger.debug({ originalUrl: repoUrl, sshUrl: gitUrl }, 'Converted to SSH URL');
    }

    try {
        // Check if exists
        try {
            await readFile(join(repoPath, '.git/config'));
            scriptLogger.info('Repo exists, updating remote and fetching...');
            // Enable push access by updating remote to SSH
            execSync(`git remote set-url origin ${gitUrl}`, { cwd: repoPath, stdio: 'pipe' });
            try {
                execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });
            } catch (fetchError) {
                scriptLogger.warn('Git fetch failed, proceeding with current state');
            }
        } catch {
            scriptLogger.info('Cloning repository...');
            if (!existsSync(targetDir)) {
                await mkdir(targetDir, { recursive: true });
            }
            execSync(`git clone ${gitUrl} ${repoPath}`, { stdio: 'pipe' });
        }
        return repoPath;
    } catch (error) {
        throw new Error(`Failed to prepare repo at ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// --- Main Logic ---

async function loadBlueprint(filename: string): Promise<{ content: any; path: string; name: string }> {
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
        const text = await readFile(blueprintPath, 'utf-8');
        const content = JSON.parse(text);
        const name = basename(blueprintPath, extname(blueprintPath));
        return { content, path: blueprintPath, name };
    } catch (err) {
        throw new Error(`Could not load blueprint '${filename}': ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function main() {
    const argv = await yargs(hideBin(process.argv))
        .option('input', { type: 'string', description: 'JSON input parameters' })
        .option('dry-run', { type: 'boolean', description: 'Simulate without dispatching' })
        .option('model', { type: 'string', default: 'auto-gemini-3', description: 'Model to use' })
        .option('context', { type: 'string', description: 'Additional context to inject' })
        .option('setup-repo', { type: 'string', description: 'Parent directory to clone/use repo in (e.g. ../jinn-repos)' })
        .demandCommand(1, 'Please provide a blueprint filename')
        .help()
        .parse();

    const blueprintArg = String(argv._[0]);

    try {
        // 1. Load Blueprint
        scriptLogger.info('Loading blueprint...');
        const { content: blueprintJson, path: blueprintPath, name: blueprintName } = await loadBlueprint(blueprintArg);
        scriptLogger.info({ blueprintPath }, 'Blueprint loaded');

        // 2. Parse Input
        let input: Record<string, any> = {};
        if (argv.input) {
            try {
                input = JSON.parse(argv.input);
            } catch {
                throw new Error('Invalid JSON provided for --input');
            }
        }

        // Inject system-provided context variables
        // currentTimestamp: ISO timestamp at dispatch time (for explicit time calculations)
        input.currentTimestamp = new Date().toISOString();

        // 2b. Repo Setup (Side Effect)
        let envVarPrefix = '';
        if (argv.setupRepo && input.repoUrl) {
            const absRepoPath = await prepareRepo(input.repoUrl, argv.setupRepo);
            envVarPrefix = `CODE_METADATA_REPO_ROOT=${absRepoPath} `;
            // CRITICAL: Set in current process so dispatchNewJob can auto-collect codeMetadata
            process.env.CODE_METADATA_REPO_ROOT = absRepoPath;
            scriptLogger.info({ absRepoPath }, 'Repository ready for worker');
        }

        // 3. Process Blueprint (Substitutions)
        scriptLogger.info('Processing blueprint...');

        // Get invariants (support both 'invariants' and legacy 'assertions')
        const rawInvariants = blueprintJson.invariants || blueprintJson.assertions || [];
        const invariants = deepSubstitute(rawInvariants, input, blueprintJson.inputSchema);

        // Update blueprint object
        if (blueprintJson.invariants) blueprintJson.invariants = invariants;
        if (blueprintJson.assertions) blueprintJson.assertions = invariants;

        // Inject context
        const inputContext = [
            blueprintJson.context || '',
            '',
            '## Input Parameters',
            JSON.stringify(input, null, 2),
            '',
            argv.context ? `## Additional Context\n${argv.context}` : '',
        ].filter(Boolean).join('\n');

        // Strip template metadata before dispatching
        // We only want the agent to see invariants, context, and outputSpec
        const cleanBlueprint: Record<string, unknown> = {
            invariants,
            context: inputContext
        };
        // Include outputSpec so OutputInvariantProvider can generate constraints
        if (blueprintJson.outputSpec) {
            cleanBlueprint.outputSpec = blueprintJson.outputSpec;
        }

        const finalBlueprint = JSON.stringify(cleanBlueprint);

        // 4. Job Name
        const shortId = Math.random().toString(36).substring(2, 5).toUpperCase();
        const title = (blueprintJson.name || blueprintName)
            .replace(/[^\w\s-]/g, '')
            .trim();
        const jobName = `${title} – ${shortId}`;

        scriptLogger.info({
            jobName,
            model: argv.model,
            inputKeys: Object.keys(input),
        }, 'Job configuration ready');

        // 5. Dry Run or Dispatch
        if (argv.dryRun) {
            console.log('\n=== DRY RUN ===\n');
            console.log('Job Name:', jobName);
            console.log('Invariants:', invariants.length);
            console.log('Context preview:', inputContext.slice(0, 200) + '...');
            if (invariants.length > 0) {
                console.log('\nFirst Invariant Substitution Check:');
                console.log('Original:', rawInvariants[0].invariant || rawInvariants[0].description);
                console.log('Final:   ', invariants[0].invariant || invariants[0].description);
            }
            if (envVarPrefix) {
                console.log('\nWorker Command would include:');
                console.log(envVarPrefix);
            }
            return;
        }

        scriptLogger.info('Dispatching job...');

        const result = await dispatchNewJob({
            jobName,
            blueprint: finalBlueprint,
            model: argv.model,
            enabledTools: (() => {
                const { requiredTools, availableTools } = extractToolPolicyFromBlueprint(blueprintJson);
                const tools = requiredTools.length > 0
                    ? requiredTools
                    : (availableTools.length > 0 ? availableTools : [
                        'google_web_search', 'create_artifact', 'web_fetch', 'get_details'
                    ]);
                return tools;
            })(),
            inputSchema: blueprintJson.inputSchema || blueprintJson.templateMeta?.inputSchema,
        });


        // Parse result (dispatchNewJob returns a specific tool response structure)
        // We need to handle the content format
        let requestId: string | undefined;

        if (result.content && result.content[0] && result.content[0].text) {
            try {
                const parsed = JSON.parse(result.content[0].text);
                if (parsed.data && (parsed.data.request_id || (parsed.data.request_ids && parsed.data.request_ids[0]))) {
                    requestId = parsed.data.request_id || parsed.data.request_ids[0];
                }
            } catch (e) {
                // ignore parse error provided we check result
            }
        }

        if (!requestId) {
            // Fallback for different return shapes or errors
            console.error('Dispatch returned unexpected format:', JSON.stringify(result, null, 2));
            throw new Error('Could not extract request ID from dispatch response');
        }

        console.log('\n✅ Job dispatched successfully!');
        console.log(`   Request ID: ${requestId}`);
        console.log(`   Job Name:   ${jobName}`);
        console.log(`   Explorer:   https://explorer.jinn.network/workstreams/${requestId}`);
        console.log(`\nRun worker:`);
        console.log(`   ${envVarPrefix}yarn dev:mech --workstream=${requestId} --single`);

    } catch (error) {
        scriptLogger.error({
            err: error instanceof Error ? { message: error.message } : String(error),
        }, 'Launch failed');
        console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

main();
