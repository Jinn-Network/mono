import { existsSync, writeFileSync } from 'node:fs';
import { reindexEvidenceStore } from '../../dist/index.js';

const [episodesDir, indexPath, enteredPath, releasePath] = process.argv.slice(2);
if (!episodesDir || !indexPath) throw new Error('episodesDir and indexPath are required');

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const report = reindexEvidenceStore({
  episodesDir,
  indexPath,
  ...(enteredPath && releasePath
    ? {
      onScanComplete: () => {
        writeFileSync(enteredPath, 'entered');
        const deadline = Date.now() + 10_000;
        while (!existsSync(releasePath)) {
          if (Date.now() >= deadline) throw new Error('timed out waiting to release scan');
          Atomics.wait(sleeper, 0, 0, 10);
        }
      },
    }
    : {}),
});

if (!report.indexUpdated) {
  throw new Error(`index publication failed: ${report.indexError ?? 'unknown failure'}`);
}
