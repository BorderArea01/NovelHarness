import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { watch } from 'node:fs';
import { sameHostSecret } from '../host/host-wire.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { startNovelWeb } from '../official/novel/web.mjs';
const manifest = JSON.parse(await readFile('production-runtime.json','utf8'));
assert.equal(manifest.format,'novel-private-production-runtime-v1');
assert.equal(manifest.dataPolicy,'preserve-current-formal-only');
const root=resolve('data/official-validation/integration/formal-promotion'),home=join(root,'home');
const receipt=JSON.parse(await readFile(join(root,'promotion.json'),'utf8'));
assert.equal(receipt.codeRevision,manifest.sourceRevision);
const port=Number(process.env.NOVEL_PRODUCTION_PORT ?? 3213);
assert([3211,3213].includes(port));
if(port===3213){
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(url.hostname==='api.deepseek.com'&&/(messages|completions)/.test(url.pathname)){
      console.error('PREVIEW_MODEL_CALL_REFUSED');
      throw new Error('Production preview prohibits paid model generation.');
    }
    return nativeFetch(input,init);
  };
}
const publicOrigin=process.env.NOVEL_PRODUCTION_ORIGIN;
assert(new URL(publicOrigin).protocol==='https:');
const ownerKey=(await readFile(join(root,'owner-key.txt'),'utf8')).trim();
const hosts=port===3211?Object.values(networkInterfaces()).flat().filter(x=>x&&!x.internal&&x.family==='IPv4').map(x=>x.address):[];
let app,web,stopping=false;
let control=JSON.parse(await readFile('production-control.json','utf8'));
const watcher=watch('.',(_event,file)=>{if(String(file)==='production-control.json')readFile('production-control.json','utf8').then(text=>{
  const next=JSON.parse(text);if(next.revision===manifest.sourceRevision&&next.verificationKey===control.verificationKey)control=next;
}).catch(()=>{});});
const isPublished=req=>control.published===true||sameHostSecret(req.headers['x-novel-verification'],control.verificationKey);
async function stop(){if(stopping)return;stopping=true;watcher.close();if(web)await web.close();if(app)await app.shutdown.shutdown(0);}
process.on('SIGTERM',()=>stop().then(()=>process.exit(0)));
process.on('SIGINT',()=>stop().then(()=>process.exit(0)));
process.on('message',message=>{if(message?.type==='novel-production-stop')stop().then(()=>process.exit(0));});
try {
  app=await startOfficialNovel({sqlite:join(root,'main.sqlite'),home,production:true});
  assert.equal(app.ctx.get('agents').list().length,0,'No paid turns may resume automatically.');
  web=await startNovelWeb(app,{ownerKey,home,port,lanHosts:hosts,publicOrigin,isPublished});
  await writeFile('production-running.json',JSON.stringify({pid:process.pid,port,sourceRevision:manifest.sourceRevision,
    readyAt:new Date().toISOString(),dataPolicy:manifest.dataPolicy,publicOrigin}));
  console.log(JSON.stringify({ready:true,port,sourceRevision:manifest.sourceRevision}));
} catch(error){console.error(error.stack);await stop();process.exitCode=1;}
