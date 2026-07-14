import type { SkillRecord, SkillsPort } from '../ports/skills-port.js';
import { ok } from '../outcome.js';

export class InMemorySkillsPort implements SkillsPort {
  private readonly installed = new Map<string, SkillRecord>();

  async install(ref: string) {
    const record: SkillRecord = { ref, installedAt: new Date().toISOString() };
    this.installed.set(ref, record);
    return ok(record);
  }

  async list() {
    return ok([...this.installed.values()]);
  }

  async uninstall(ref: string) {
    this.installed.delete(ref);
    return ok({ ref });
  }
}
