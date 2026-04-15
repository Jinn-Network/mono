#!/usr/bin/env tsx
import 'dotenv/config';
import { Agent } from 'jinn-node/agent/agent.js';
import { createBlueprintBuilder } from 'jinn-node/worker/prompt/BlueprintBuilder.js';
import type { IpfsMetadata } from 'jinn-node/worker/types.js';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TARGET_REPO = '/Users/adrianobradley/jinn-repos/local-arcade';
const TARGET_BRANCH = 'job/e2e-test-1';

async function main() {
    console.log(`📂 Target Repo: ${TARGET_REPO}`);
    console.log(`🌿 Target Branch: ${TARGET_BRANCH}`);

    // 1. Checkout Branch
    try {
        console.log('🔄 Checking out branch...');
        execSync(`git checkout ${TARGET_BRANCH}`, { cwd: TARGET_REPO, stdio: 'inherit' });
    } catch (e) {
        console.error('❌ Failed to checkout branch. Is the path correct?');
        process.exit(1);
    }

    // 2. Build Verification Prompt
    console.log('🏗️ Building Verification Prompt...');
    const builder = createBlueprintBuilder({
        enableBeadsAssertions: userConfig('BLUEPRINT_ENABLE_BEADS', true),
        debug: true
    });

    // Mock Context Provider
    class MockContextProvider {
        name = 'mock-context';
        enabled() { return true; }
        async provide(ctx: any) {
            const children = ctx.metadata.additionalContext?.hierarchy || [];
            // Cast status to satisfy types at runtime (ChildWorkAssertionProvider expects 'COMPLETED')
            return {
                hierarchy: {
                    children,
                    totalJobs: children.length,
                    completedJobs: children.filter((c: any) => c.status === 'COMPLETED').length,
                    activeJobs: 0
                }
            };
        }
    }
    builder.registerContextProvider(new MockContextProvider());

    // LOAD BLUEPRINT FROM FILE
    const blueprintPath = join(__dirname, '../../blueprints/local-arcade.json');
    const { readFileSync } = await import('fs');
    const blueprintJson = readFileSync(blueprintPath, 'utf8');

    const metadata: IpfsMetadata = {
        jobName: 'simulate-verification',
        blueprint: blueprintJson, // Use real blueprint
        codeMetadata: {
            repo: { remoteUrl: 'https://github.com/jinn-repos/local-arcade.git' },
            branch: { name: TARGET_BRANCH, headCommit: 'mock-hash', status: { isDirty: false } },
            baseBranch: 'main',
            jobDefinitionId: 'mock-def',
            capturedAt: new Date().toISOString()
        },
        additionalContext: {
            verificationRequired: true,
            verificationAttempt: 1,
            hierarchy: [
                {
                    requestId: 'mock-child-req-1',
                    jobName: 'Implement Snake Game',
                    status: 'COMPLETED',
                    branchName: 'feat/snake-game',
                    isIntegrated: true,
                    summary: 'Implemented Snake game.'
                },
                {
                    requestId: 'mock-child-req-2',
                    jobName: 'Implement 2048',
                    status: 'COMPLETED',
                    branchName: 'feat/2048',
                    isIntegrated: true,
                    summary: 'Implemented 2048.'
                }
            ] as any[]
        }
    };

    const buildResult = await builder.build('mock-req-id', metadata);
    const prompt = JSON.stringify(buildResult.blueprint);

    // 3. Initialize Agent
    console.log('🤖 Initializing Gemini Agent...');
    // Enable browser_automation explicitly
    const enabledTools = [
        'browser_automation',
        'run_shell_command',
        'write_file',
        'read_file',
        'list_directory',
        'npm_run_script'
    ];

    process.env.CODE_METADATA_REPO_ROOT = TARGET_REPO; // Required for Agent to include dir

    const model = process.env.MECH_MODEL || process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest';
    console.log(`🧠 Using Model: ${model}`);

    const agent = new Agent(
        model,
        enabledTools,
        {
            jobId: 'mock-verification-job',
            jobDefinitionId: 'mock-ver-def',
            jobName: 'Verification Simulation',
            projectRunId: 'mock-run',
            sourceEventId: 'mock-event',
            projectDefinitionId: 'mock-proj-def'
        },
        TARGET_REPO,
        { isCodingJob: true }
    );

    // 4. Run Agent
    console.log('🚀 Launching Agent with Verification Prompt...');
    console.log('   (This will spawn npx @google/gemini-cli and use browser_automation)');

    try {
        const result = await agent.run(prompt);
        console.log('\n✅ Agent Execution Completed!');
        console.log('═══════════════════════════════════════════════════════════════════════');
        console.log(result.output);
        console.log('═══════════════════════════════════════════════════════════════════════');
    } catch (error: any) {
        console.error('\n❌ Agent Execution Failed:', error.message);
        if (error.telemetry) {
            console.error('Telemetry Error:', error.telemetry.errorMessage);
        }
    }
}

function userConfig(key: string, defaultVal: boolean): boolean {
    return process.env[key] ? process.env[key] === 'true' : defaultVal;
}

main().catch(console.error);
