// One private runtime package, independent of the mutable laboratory install.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, readdir, symlink, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
assert(process.argv.includes('--owner-requested'));
const source = resolve('.'), target = resolve('data/local-host/official-runtime');
try { await access(join(target, 'production-runtime.json')); throw new Error('Existing runtime package cannot be overwritten.'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const receipt = JSON.parse(await readFile('data/official-validation/integration/formal-promotion/promotion.json', 'utf8'));
assert.equal(receipt.status, 'offline-conversion-verified');
await mkdir(target, { recursive: true });
for (const path of ['cloud/official/novel','cloud/official/node_modules','cloud/scripts','cloud/host','cloud/shared',
  'data/official-validation/integration/baseline','data/official-validation/integration/formal-promotion'])
  await cp(join(source,path),join(target,path),{recursive:true,dereference:true});
for (const path of ['data/official-validation/integration/vfs.mjs','data/official-validation/integration/baseline.json'])
  await cp(join(source,path),join(target,path));
await symlink(join(source,'node_modules'),join(target,'node_modules'),'junction');
await mkdir(join(target,'cloud/tools'),{recursive:true});
await symlink(join(source,'cloud/tools/node_modules'),join(target,'cloud/tools/node_modules'),'junction');
// Rebase only host-owned absolute imports embedded by the laboratory's existing
// compatibility patches, including their plugin backups. Never copy a profile
// or credential from the staging home.
const replacements = [
  [pathToFileURL(join(source,'cloud/official/novel')).href,pathToFileURL(join(target,'cloud/official/novel')).href],
  [pathToFileURL(join(source,'data/official-validation/integration')).href,pathToFileURL(join(target,'data/official-validation/integration')).href],
];
let changed = 0;
async function rebase(dir) {
  for (const e of await readdir(dir,{withFileTypes:true})) {
    const path = join(dir,e.name);
    if(e.isDirectory()) await rebase(path);
    else if(e.isFile() && /\.(?:mjs|js|bak)$/.test(e.name)) {
      const old = await readFile(path,'utf8'); let next=old;
      for(const [a,b] of replacements) next=next.replaceAll(a,b);
      if(next!==old){await writeFile(path,next);changed++;}
    }
  }
}
await rebase(join(target,'cloud/official/node_modules'));
await writeFile(join(target,'production-runtime.json'),JSON.stringify({format:'novel-private-production-runtime-v1',
  sourceRevision:receipt.codeRevision,dataPolicy:receipt.dataPolicy,reboundFiles:changed,readyForPublic:false},null,2));
console.log(JSON.stringify({packaged:true,reboundFiles:changed,productionSwitched:false}));
