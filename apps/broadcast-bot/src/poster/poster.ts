import type { BroadcastEvent } from '../types.js';

export interface Poster {
  post(event: BroadcastEvent, text: string): Promise<void>;
}
