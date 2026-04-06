#!/usr/bin/env tsx
/**
 * Setup a venture with a dispatch schedule.
 *
 * Convenience script: takes a venture ID and template IDs,
 * creates schedule entries, and updates the venture's dispatch_schedule.
 *
 * Usage:
 *   tsx scripts/setup-scheduled-venture.ts \
 *     --ventureId <uuid> \
 *     --entry "weekly-content:<template-id>:0 6 * * 1" \
 *     --entry "daily-measurement:<template-id>:0 6 * * *"
 *
 * Entry format: <label>:<templateId>:<cron>
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { getVenture, updateVenture } from '../jinn-node/src/data/ventures.js';
import type { ScheduleEntry } from '../jinn-node/src/data/types/scheduleEntry.js';

async function main() {
  const args = process.argv.slice(2);
  const ventureIdIdx = args.indexOf('--ventureId');

  if (ventureIdIdx === -1 || !args[ventureIdIdx + 1]) {
    console.error('Usage: tsx scripts/setup-scheduled-venture.ts --ventureId <uuid> --entry "<label>:<templateId>:<cron>"');
    process.exit(1);
  }

  const ventureId = args[ventureIdIdx + 1];

  // Parse --entry flags
  const entries: ScheduleEntry[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--entry' && args[i + 1]) {
      const parts = args[i + 1].split(':');
      if (parts.length < 3) {
        console.error(`Invalid entry format: ${args[i + 1]}`);
        console.error('Expected: <label>:<templateId>:<cron>');
        process.exit(1);
      }
      const label = parts[0];
      const templateId = parts[1];
      const cron = parts.slice(2).join(':'); // cron can contain colons in some formats

      entries.push({
        id: randomUUID(),
        templateId,
        cron,
        label,
        enabled: true,
      });
    }
  }

  if (entries.length === 0) {
    console.error('No --entry flags provided');
    process.exit(1);
  }

  // Verify venture exists
  const venture = await getVenture(ventureId);
  if (!venture) {
    console.error(`Venture not found: ${ventureId}`);
    process.exit(1);
  }

  console.log(`\nVenture: ${venture.name} (${venture.id})`);
  console.log(`Current schedule: ${(venture.dispatch_schedule || []).length} entries`);
  console.log(`\nAdding ${entries.length} schedule entries:`);

  for (const entry of entries) {
    console.log(`  - ${entry.label}: template=${entry.templateId}, cron="${entry.cron}"`);
  }

  // Merge with existing schedule
  const existingSchedule = venture.dispatch_schedule || [];
  const newSchedule = [...existingSchedule, ...entries];

  const updated = await updateVenture({
    id: ventureId,
    dispatchSchedule: newSchedule,
  });

  console.log(`\nUpdated! New schedule has ${updated.dispatch_schedule.length} entries.`);
  console.log('\nTo enable the venture watcher, set ENABLE_VENTURE_WATCHER=1 on the worker.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
