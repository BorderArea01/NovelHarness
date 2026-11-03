import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { openSync,closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
assert(process.argv.includes('--owner-requested'));
const root=resolve('data/local-host'),active=JSON.parse(await readFile(join(root,'active.json'),'utf8'));
assert.equal(active.runtime,'official-dsh');
const dir=resolve(active.runtimeRoot);
assert.equal(dir,join(root,'official-runtime'));
const manifest=JSON.parse(await readFile(join(dir,'production-runtime.json'),'utf8'));
assert.equal(manifest.sourceRevision,active.baseRevision);
const out=openSync(join(root,'official-host.out.log'),'w'),err=openSync(join(root,'official-host.error.log'),'w');
const child=spawn(process.execPath,['--max-old-space-size=512','cloud/scripts/serve-official-production.mjs'],{
  cwd:dir,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,
    NOVEL_PRODUCTION_PORT:'3211',NOVEL_PRODUCTION_ORIGIN:active.publicOrigin},
});
closeSync(out);closeSync(err);child.unref();
let running;
for(let n=0;n<100;n++){
  if(child.exitCode!==null)throw new Error('Formal native host failed to start.');
  try{const value=JSON.parse(await readFile(join(dir,'production-running.json'),'utf8'));
    if(value.pid===child.pid&&value.port===3211){running=value;break;}}catch{}
  await delay(200);
}
assert(running,'New host readiness was not confirmed.');
await writeFile(join(root,'running.json'),JSON.stringify({...running,runtime:'official-dsh',runtimeRoot:dir,assetsRevision:active.assetsRevision},null,2));
active.pid=child.pid;
await writeFile(join(root,'active.json'),JSON.stringify(active,null,2));
console.log(JSON.stringify({ready:true,pid:child.pid,port:3211,publicWritesOpen:false}));
