/**
 * `plan()` — fetch + licence-check, ZERO writes (plan Task 6).
 *
 * Takes only a SeedSource; it cannot publish, anchor or touch the ledger by
 * construction (no publish deps in the signature). Its output is the
 * ImportReport the human approves before `execute()` may run.
 */

import { checkLicence } from './licence.js';
import type { SeedSource } from './fetch.js';
import type { ImportReport } from './report.js';

export async function plan(source: SeedSource): Promise<ImportReport> {
  const skills = await source.list();
  return skills.map((skill) => {
    const { verdict, reason } = checkLicence(skill.licence);
    return {
      skill: skill.skill,
      source: skill.source,
      licence: skill.licence,
      verdict,
      reason,
    };
  });
}
