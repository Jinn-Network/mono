import type { PortResult } from '../outcome.js';

export interface SkillRecord {
  ref: string;
  installedAt: string;
}

export interface SkillsPort {
  install(ref: string): Promise<PortResult<SkillRecord>>;
  list(): Promise<PortResult<SkillRecord[]>>;
  uninstall(ref: string): Promise<PortResult<{ ref: string }>>;
}
