/**
 * Keystore Backup
 *
 * Creates encrypted backups of agent private keys at ~/.jinn/key-backups/.
 * Backups are password-protected (same OPERATE_PASSWORD encryption as .operate/keys/).
 *
 * Two entry points:
 *   - backupKeystore()  — back up a single key (called from stOLAS flows)
 *   - backupAllKeys()   — scan .operate/keys/ and back up any unbackup'd keys
 *                          (called after middleware bootstrap)
 *
 * SAFETY: Only encrypted keystores are written. No raw private keys touch backup disk.
 */

import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { logger } from '../logging/index.js';

const log = logger.child({ component: 'KEYSTORE-BACKUP' });

const BACKUP_DIR_NAME = '.jinn/key-backups';

/**
 * Resolve the backup directory path.
 * Defaults to ~/.jinn/key-backups/ (outside repo).
 */
function getBackupDir(): string {
    return join(homedir(), BACKUP_DIR_NAME);
}

/**
 * Generate a filesystem-safe ISO timestamp (colons → dashes).
 */
function safeTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

// ─── Public API ─────────────────────────────────────────────────────────────────

export interface BackupResult {
    backupPath: string;
}

/**
 * Back up a single encrypted keystore to ~/.jinn/key-backups/.
 *
 * Called directly from stOLAS storeAgentKey() and ServiceImporter after key creation.
 * The backup is the same encrypted keystore V3 JSON — decryptable only with OPERATE_PASSWORD.
 *
 * @param opts.address          Agent EOA address
 * @param opts.encryptedKeystore Encrypted keystore V3 JSON string
 * @param opts.operateBasePath   Path containing .operate/ (for logging context)
 * @param opts.context           Optional label (e.g. "stolas-401") for audit trail
 */
export async function backupKeystore(opts: {
    address: string;
    encryptedKeystore: string;
    operateBasePath: string;
    context?: string;
}): Promise<BackupResult> {
    const { address, encryptedKeystore, context } = opts;
    const backupDir = getBackupDir();

    try {
        await fs.mkdir(backupDir, { recursive: true });

        const filename = `${address}_${safeTimestamp()}.json`;
        const backupPath = join(backupDir, filename);

        await fs.writeFile(backupPath, encryptedKeystore, 'utf-8');

        log.info({ address, backupPath, context }, 'Key backup saved');

        // Print user-facing message to stdout
        console.log(`\n🔑 Key backup saved:`);
        console.log(`   ${backupPath}`);
        console.log(`\n   ⚠️  This backup is encrypted with your OPERATE_PASSWORD.`);
        console.log(`       Store both the backup file AND the password securely.`);
        console.log(`       Without the password, the key CANNOT be recovered.\n`);

        return { backupPath };
    } catch (err: any) {
        log.warn({ address, error: err.message, context }, 'Key backup failed (non-fatal)');
        throw err;
    }
}

/**
 * Scan .operate/keys/ and back up any keys that don't have an existing backup.
 *
 * Called after SimplifiedServiceBootstrap completes to capture keys
 * the Python middleware daemon created during the flow.
 *
 * @param opts.operateBasePath Directory containing .operate/
 * @returns Count of keys backed up and skipped
 */
export async function backupAllKeys(opts: {
    operateBasePath: string;
}): Promise<{ backedUp: number; skipped: number }> {
    const { operateBasePath } = opts;
    const keysDir = join(operateBasePath, '.operate', 'keys');
    const backupDir = getBackupDir();

    if (!existsSync(keysDir)) {
        log.info({ keysDir }, 'No .operate/keys/ directory found — nothing to back up');
        return { backedUp: 0, skipped: 0 };
    }

    // Read existing backups to avoid duplicates
    await fs.mkdir(backupDir, { recursive: true });
    const existingBackups = new Set<string>();
    try {
        const backupFiles = readdirSync(backupDir);
        for (const f of backupFiles) {
            // Extract address from filename: <address>_<timestamp>.json
            const address = f.split('_')[0];
            if (address) existingBackups.add(address.toLowerCase());
        }
    } catch {
        // Empty or unreadable backup dir — proceed
    }

    const keyFiles = readdirSync(keysDir);
    let backedUp = 0;
    let skipped = 0;

    for (const keyFile of keyFiles) {
        const address = basename(keyFile);

        // Skip non-address files (e.g. .bak copies, READMEs)
        if (!address.startsWith('0x') || address.includes('.')) {
            continue;
        }

        // Skip if already backed up
        if (existingBackups.has(address.toLowerCase())) {
            skipped++;
            continue;
        }

        try {
            const keyPath = join(keysDir, keyFile);
            const raw = readFileSync(keyPath, 'utf-8');
            const keyEntry = JSON.parse(raw);
            const encryptedKeystore = keyEntry.private_key;

            if (!encryptedKeystore || typeof encryptedKeystore !== 'string') {
                log.warn({ address }, 'Skipping key with no private_key field');
                skipped++;
                continue;
            }

            await backupKeystore({
                address,
                encryptedKeystore,
                operateBasePath: opts.operateBasePath,
                context: 'bulk-scan',
            });

            backedUp++;
        } catch (err: any) {
            log.warn({ address, error: err.message }, 'Failed to back up key (skipping)');
            skipped++;
        }
    }

    if (backedUp > 0) {
        log.info({ backedUp, skipped, backupDir }, 'Key backup scan complete');
    } else {
        log.info({ skipped, backupDir }, 'All keys already backed up');
    }

    return { backedUp, skipped };
}
