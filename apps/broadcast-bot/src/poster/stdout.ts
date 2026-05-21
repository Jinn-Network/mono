import type { Poster } from './poster.js';
import type { BroadcastEvent } from '../types.js';

export class StdoutPoster implements Poster {
  async post(event: BroadcastEvent, text: string): Promise<void> {
    process.stdout.write(`\n── ${event.type} ${event.dedupeKey} ──\n${text}\n`);
  }
}
