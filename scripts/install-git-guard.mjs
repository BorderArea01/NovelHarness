import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
if (resolve(gitRoot) !== resolve(root)) throw new Error('Install from the NovelHarness Git checkout.');
let previous;
try { previous = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
catch (error) { if (error.status !== 1) throw error; }
if (previous && previous !== '.githooks') throw new Error('Existing custom hooksPath was preserved. Integrate the guard with that hook chain first.');
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
console.log('Repository push guard installed; direct pushes to shared branches are blocked.');
