// Inspect only Git-tracked source, never private data or ignored configuration.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
for (const file of files) {
  if (
    /(?:^|\/)(?:data|node_modules|\.wrangler|test-results|backups)\//.test(file) ||
    /(?:\.sqlite(?:-wal|-shm)?|\.pem|\.pfx|\.jsonl|owner-key\.txt|visitor-secret\.json|\.env)$/.test(file)
  )
    failures.push(file + ': private file');
  const text = await readFile(file, 'utf8');
  if (/\b(?:sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/.test(text))
    failures.push(file + ': possible credential');
  if (
    text.includes(['novel-studio', 'e8c6af49c25a'].join('-')) ||
    /C:[\\/]Users[\\/]31093|192\.168\.20\.99/.test(text)
  )
    failures.push(file + ': private deployment reference');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Tracked-source audit passed: ' + files.length + ' files; no deployment data or credential patterns.',
  );
