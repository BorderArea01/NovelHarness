// Explicit formal-only promotion. Keep the previous data owner and public
// deployment available for rollback; do not open public writes here.
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { requireIdleRuntime } from './runtime-activity.mjs';
import { vfsFileFingerprint } from '../official/novel/storage.mjs';
assert(process.argv.includes('--owner-requested'));
const root=resolve('data/local-host'),dir=join(root,'official-runtime');
const data=join(dir,'data/official-validation/integration/formal-promotion');
const receipt=JSON.parse(await readFile(join(data,'promotion.json'),'utf8'));
const preview=JSON.parse(await readFile(join(dir,'production-preview.json'),'utf8'));
assert.equal(preview.passed,true);assert.equal(preview.modelCalls,0);
const activeBytes=await readFile(join(root,'active.json')),active=JSON.parse(activeBytes);
const running=JSON.parse(await readFile(join(root,'running.json'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(activeBytes),receipt.formalActiveHash,'Formal release changed since candidate snapshot.');
function resources(){
  const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '$g=@(Get-Process NRC-Win64-Shipping -ErrorAction SilentlyContinue);[pscustomobject]@{game=($g.Count -gt 0);free=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory}|ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}));
  assert.equal(result.game,false,'Game is running; no formal process was stopped.');
  assert(result.free>=4*1024*1024,'Less than 4 GiB available; formal host not stopped.');
}
resources();
const owner=(await readFile(join(active.candidate,'owner-key.txt'),'utf8')).trim();
await requireIdleRuntime('http://127.0.0.1:3211',owner,fetch,{pinWrapper:true});
const {SQLiteWorkspaceProvider}=await import(pathToFileURL(resolve('data/official-validation/integration/vfs.mjs')));
function readOnly(path){
  const raw=new Database(path,{readonly:true,fileMustExist:true});
  const db={one:(sql,...a)=>raw.prepare(sql).get(...a),all:(sql,...a)=>raw.prepare(sql).all(...a),
    scalar(sql,...a){return Object.values(this.one(sql,...a)??{})[0];},run(){throw new Error('Read-only final proof');}};
  return {raw,fs:new SQLiteWorkspaceProvider(db)};
}
const original=readOnly(receipt.sourceDatabases.main.path),snapshot=readOnly(join(data,'source-main.sqlite'));
try{
  assert.equal(original.raw.pragma('quick_check',{simple:true}),'ok');
  assert.deepEqual(vfsFileFingerprint(original),JSON.parse(await readFile(join(data,'book-fingerprints.json'),'utf8')),'Formal book edits occurred since preview; promotion aborted.');
  for(const table of ['dsh_sessions','dsh_session_events','_cf_KV','dsh_edge_attachment_objects','dsh_edge_attachment_chunks']){
    const digest=db=>{const h=createHash('sha256');for(const row of db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').iterate())h.update(JSON.stringify(row));return h.digest('hex');};
    assert.equal(digest(original.raw),digest(snapshot.raw),'Formal state changed in '+table+'; candidate cannot overwrite it.');
  }
}finally{original.raw.close();snapshot.raw.close();}
const backup=join(root,'official-before-switch');await mkdir(backup,{recursive:true});
await writeFile(join(backup,'active-before.json'),activeBytes,{flag:'wx',mode:0o600});
await writeFile(join(backup,'running-before.json'),JSON.stringify(running),{mode:0o600});
for(const kind of ['main','pin']){
  const db=new Database(receipt.sourceDatabases[kind].path,{readonly:true});
  try{await db.backup(join(backup,kind+'.sqlite'));}finally{db.close();}
}
// Capture the CURRENT PIN state, including any legitimate login state updated
// since the preview. The candidate writer is stopped before this copy.
const sourcePin=new Database(join(backup,'pin.sqlite'),{readonly:true});
const {deserialize}=await import('node:v8');
const pin=deserialize(sourcePin.prepare('SELECT value FROM _cf_KV WHERE key=?').get('pin-state').value);sourcePin.close();
const pinTarget=new Database(join(data,'home/web-pin.sqlite'));
pinTarget.prepare('UPDATE pin_kv SET value=? WHERE key=?').run(JSON.stringify(pin),'pin-state');pinTarget.close();
resources();await requireIdleRuntime('http://127.0.0.1:3211',owner,fetch,{pinWrapper:true});
// Inspect only this known owner's identity, then invoke its original graceful
// shutdown. Never globally terminate Node/workerd, a network service or Tunnel.
try{await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(250)});throw new Error('Inspector already occupied; formal host not stopped.');}
catch(error){if(error.message==='Inspector already occupied; formal host not stopped.')throw error;}
process._debugProcess(running.pid);
let target;
for(let n=0;n<30;n++){try{target=(await fetch('http://127.0.0.1:9229/json/list').then(r=>r.json()))[0];if(target)break;}catch{}await delay(100);}
assert(target?.webSocketDebuggerUrl);
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done,fail)=>{ws.once?.('open',done);ws.addEventListener('open',done,{once:true});ws.addEventListener('error',fail,{once:true});});
let seq=0;
const evaluate=expression=>new Promise((done,fail)=>{
  const id=++seq,timer=setTimeout(()=>fail(new Error('Owned inspection timed out.')),5000);
  const onmessage=event=>{const message=JSON.parse(event.data);if(message.id!==id)return;
    clearTimeout(timer);ws.removeEventListener('message',onmessage);
    if(message.error||message.result.exceptionDetails)fail(new Error('Owned inspection refused.'));else done(message.result.result.value);};
  ws.addEventListener('message',onmessage);ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
});
const identity=await evaluate('JSON.stringify({pid:process.pid,cwd:process.cwd(),entry:process.argv[1]})');
const who=JSON.parse(identity);assert.equal(who.pid,running.pid);assert.equal(resolve(who.cwd),resolve('.'));
assert.equal(resolve(who.cwd,who.entry),resolve('cloud/host/serve.mjs'));
await requireIdleRuntime('http://127.0.0.1:3211',owner,fetch,{pinWrapper:true});
await evaluate('setImmediate(()=>process.listeners("SIGTERM").find(f=>f.name==="stop")()); true');ws.close();
for(let n=0;n<80;n++){try{process.kill(running.pid,0);}catch{break;}await delay(100);}
try{process.kill(running.pid,0);throw new Error('Old formal owner has not stopped.');}catch(error){if(error.message==='Old formal owner has not stopped.')throw error;}
const deployment=JSON.parse(await readFile('data/cloud-platform/deployment.json','utf8'));
const manifest=JSON.parse(await readFile(join(dir,'production-runtime.json'),'utf8'));
const next={...active,runtime:'official-dsh',runtimeRoot:dir,baseRevision:receipt.codeRevision,
  revision:receipt.codeRevision,assetsRevision:JSON.parse(await readFile(join(dir,'data/official-validation/integration/baseline.json'),'utf8')).novelAssetsRevision,
  publicOrigin:new URL(deployment.url).origin,activatedAt:new Date().toISOString(),verifiedReady:false,previousRuntimeBackup:backup};
delete next.pid;
await writeFile(join(root,'active.json'),JSON.stringify(next,null,2));
try{execFileSync(process.execPath,['--max-old-space-size=96','cloud/scripts/launch-official-host.mjs','--owner-requested'],{windowsHide:true,stdio:'pipe'});}
catch(error){
  await writeFile(join(root,'active.json'),activeBytes);
  throw new Error('New host startup failed; previous formal pointer restored; original data retained.');
}
console.log(JSON.stringify({nativeFormalStarted:true,publicWritesOpen:false,books:5,sessions:31,backup,oldDataRetained:true}));
