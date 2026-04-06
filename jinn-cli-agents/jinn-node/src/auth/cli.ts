#!/usr/bin/env node
/**
 * Jinn Auth CLI
 *
 * Commands for managing authentication credentials.
 *
 * Usage:
 *   npx tsx src/auth/cli.ts status    - Show credential status
 *   npx tsx src/auth/cli.ts sync      - Sync from external sources
 *   npx tsx src/auth/cli.ts list      - List all profiles
 */

import { getAuthManager, syncCredentials } from './index.js';

interface CLIArgs {
    command: 'status' | 'sync' | 'list' | 'help';
}

function parseArgs(): CLIArgs {
    const args = process.argv.slice(2);
    const rawCommand = args[0];

    if (!rawCommand || rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
        return { command: 'help' };
    }

    if (!['status', 'sync', 'list'].includes(rawCommand)) {
        console.error(`Unknown command: ${rawCommand}`);
        return { command: 'help' };
    }

    return { command: rawCommand as CLIArgs['command'] };
}

function printHelp(): void {
    console.log(`
Jinn Auth CLI - Manage authentication credentials

Usage:
  jinn-auth <command>

Commands:
  status    Show current credential status
  sync      Sync credentials from external sources (Gemini CLI, OpenClaw, etc.)
  list      List all credential profile IDs
  help      Show this help message

Examples:
  jinn-auth status
  jinn-auth sync
`);
}

function formatDuration(ms: number): string {
    if (ms <= 0) return 'expired';

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

function commandStatus(): void {
    const auth = getAuthManager();
    const status = auth.getStatus();

    if (status.profiles.length === 0) {
        console.log('\n⚠ No credentials found\n');
        console.log('Run "jinn-auth sync" to discover credentials from:');
        console.log('  • Gemini CLI (~/.gemini/)');
        console.log('  • OpenClaw (~/.openclaw/)');
        console.log('  • Claude CLI (Keychain)');
        console.log('  • Codex CLI (~/.codex/)');
        console.log('  • Environment variables\n');
        return;
    }

    console.log('\n╭────────────────────────────────────────────────────────────────────╮');
    console.log('│ Credential Status                                                  │');
    console.log('├────────────────────────────────────────────────────────────────────┤');

    // Header
    console.log(
        '│ ' +
        'Provider'.padEnd(18) +
        'Profile ID'.padEnd(25) +
        'Status'.padEnd(18) +
        '│'
    );
    console.log('├────────────────────────────────────────────────────────────────────┤');

    for (const profile of status.profiles) {
        let statusText: string;
        if (!profile.isValid) {
            statusText = '✗ Expired';
        } else if (profile.expiresIn !== undefined) {
            statusText = `✓ ${formatDuration(profile.expiresIn)} left`;
        } else {
            statusText = '✓ Valid (static)';
        }

        console.log(
            '│ ' +
            profile.provider.padEnd(18) +
            profile.profileId.padEnd(25) +
            statusText.padEnd(18) +
            '│'
        );
    }

    console.log('╰────────────────────────────────────────────────────────────────────╯');

    if (status.lastSync) {
        const syncAgo = formatDuration(Date.now() - status.lastSync);
        console.log(`\nLast sync: ${syncAgo} ago`);
    }
    console.log('');
}

function commandSync(): void {
    console.log('\nSyncing credentials...\n');

    const result = syncCredentials();

    if (result.sources.length === 0) {
        console.log('  No sources found\n');
    } else {
        for (const source of result.sources) {
            console.log(`  ✓ ${source}`);
        }
        console.log('');
    }

    if (result.errors && result.errors.length > 0) {
        console.log('Errors:');
        for (const error of result.errors) {
            console.log(`  ✗ ${error}`);
        }
        console.log('');
    }

    console.log(`Total profiles: ${result.profileCount}\n`);
}

function commandList(): void {
    const auth = getAuthManager();
    const profileIds = auth.getProfileIds();

    if (profileIds.length === 0) {
        console.log('\nNo credential profiles found.\n');
        return;
    }

    console.log('\nCredential Profiles:\n');
    for (const id of profileIds) {
        console.log(`  • ${id}`);
    }
    console.log('');
}

function main(): void {
    const args = parseArgs();

    switch (args.command) {
        case 'status':
            commandStatus();
            break;
        case 'sync':
            commandSync();
            break;
        case 'list':
            commandList();
            break;
        case 'help':
        default:
            printHelp();
            break;
    }
}

main();
