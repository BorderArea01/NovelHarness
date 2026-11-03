// Mechanical redaction of this task's generated diagnostics only. No stories,
// credentials/configuration files or release code are modified.
import { readFile, readdir, writeFile } from 'node:fs/promises';
const folder = new URL('../../test-results/guarded-logs/', import.meta.url);
let scanned = 0,
  redacted = 0;
for (const name of await readdir(folder)) {
  if (!/^\d{8}-\d{6}-\d{3}-cloud-public-browser\.(?:out|error)\.log$/.test(name)) continue;
  const path = new URL(name, folder);
  const before = await readFile(path, 'utf8');
  const after = before
    .replace(/(cookie:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(
      /((?:__Host-dsh_edge_owner|__Host-novel_pin|dsh_edge_owner|novel_pin)=)[^;\s"']+/g,
      '$1[redacted]',
    );
  scanned++;
  if (before !== after) {
    await writeFile(path, after);
    redacted++;
  }
}
console.log(JSON.stringify({ generatedLogFilesScanned: scanned, redactedFiles: redacted }));
