// Formal-only candidate: native PIN, cold history and actual browser. No prompt.
import assert from 'node:assert/strict';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { openChapter, waitEditor } from './editor-client.mjs';
import { vfsFileFingerprint } from '../official/novel/storage.mjs';
const dir=resolve('data/local-host/official-runtime');
const data=join(dir,'data/official-validation/integration/formal-promotion');
const report={at:new Date().toISOString(),passed:false,productionSwitched:false,modelCalls:0};
const deployment=JSON.parse(await readFile('data/cloud-platform/deployment.json','utf8'));
const origin='http://127.0.0.1:3213';
let child,browser,logs='';
try {
  const formal=JSON.parse(await readFile('data/local-host/active.json','utf8'));
  assert(!(formal.runtime==='official-dsh'&&resolve(formal.runtimeRoot)===dir),'Refusing to modify or start a preview against the live formal package.');
  const manifest=JSON.parse(await readFile(join(dir,'production-runtime.json'),'utf8'));
  assert.equal(manifest.readyForPublic,false,'Published packages are immutable to preview tests.');
  for(const name of ['cloud/official/novel','cloud/scripts/serve-official-production.mjs'])
    await cp(resolve(name),join(dir,name),{recursive:true});
  await cp(resolve('data/official-validation/integration/baseline/worker'),join(dir,'cloud/worker'),{recursive:true});
  await cp(resolve('cloud/shared'),join(dir,'cloud/shared'),{recursive:true});
  const verificationKey=randomBytes(32).toString('hex');
  await writeFile(join(dir,'production-control.json'),JSON.stringify({published:false,revision:manifest.sourceRevision,verificationKey}));
  child=spawn(process.execPath,['--max-old-space-size=512','cloud/scripts/serve-official-production.mjs'],{
    cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,
      NOVEL_PRODUCTION_PORT:'3213',NOVEL_PRODUCTION_ORIGIN:new URL(deployment.url).origin},
  });
  child.stdout.on('data',b=>{logs=(logs+b).slice(-16000);});
  child.stderr.on('data',b=>{logs=(logs+b).slice(-16000);});
  let ready=false;
  for(let n=0;n<100;n++){
    if(child.exitCode!==null)throw new Error('Candidate boot failed: '+logs.slice(-2400));
    try{const r=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(500)});if(r.ok){await r.arrayBuffer();ready=true;break;}}catch{}
    await delay(200);
  }
  assert(ready,'Candidate not ready.');
  assert.equal((await fetch(origin+'/')).status,503);
  const owner=(await readFile(join(data,'owner-key.txt'),'utf8')).trim();
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args:['--disable-background-networking','--disable-extensions','--js-flags=--max-old-space-size=192']});
  const context=await browser.newContext({viewport:{width:1280,height:900},extraHTTPHeaders:{'x-novel-verification':verificationKey}});
  const a=await context.request.post(origin+'/api/auth/recover',{headers:{origin},data:{accessKey:owner}});
  assert.equal(a.status(),200);await a.dispose();
  const api=async path=>{const r=await context.request.get(origin+path);assert.equal(r.status(),200,path);const v=await r.json();await r.dispose();return v;};
  assert.equal((await api('/api/auth/session')).authenticated,true);
  assert.equal((await api('/api/auth/pin')).configured,true);
  const books=(await api('/api/novels')).books;
  assert.equal(books.length,5);
  const list=await context.request.post(origin+'/api/session/list',{headers:{origin},data:{type:'client-request',rpcId:crypto.randomUUID(),
    method:'session/list',payload:{args:{_request:{}}}}});
  const wire=await list.json();await list.dispose();
  assert.equal(wire.result.ok,true);
  assert.equal(wire.result.value.items.length,31);
  assert(wire.result.value.items.every(v=>v.running===false));
  const history=JSON.parse(await readFile(join(data,'history-import.json'),'utf8'));
  const item=history.sessions.find(x=>x.eventCount>0);
  const h=await context.request.post(origin+'/api/session/page',{headers:{origin},data:{type:'client-request',rpcId:crypto.randomUUID(),
    method:'session/page',payload:{args:{request:{address:{kind:'session',sessionId:item.id},throughSeq:item.eventCount-1,maxMessages:20}}}}});
  assert.equal((await h.json()).result.ok,true,'Cold formal history failed.');await h.dispose();
  const page=await context.newPage();page.setDefaultTimeout(20000);
  for(const name of ['继续','稍后配置'])await page.addLocatorHandler(page.getByRole('button',{name,exact:true}),async()=>{
    await page.getByRole('button',{name,exact:true}).click();},{noWaitAfter:true});
  await page.addLocatorHandler(page.getByRole('button',{name:/我已知晓并继续|I understand/}),async()=>{
    await page.getByRole('checkbox').first().check();await page.getByRole('button',{name:/我已知晓并继续|I understand/}).click();});
  let opened=false;
  for(const book of books){
    const docs=await api('/api/novels/'+book.id+'/documents');
    const chapter=docs.documents.find(x=>x.category==='chapter');
    if(!chapter)continue;
    const original=await api('/api/novels/'+book.id+'/document?path='+encodeURIComponent(chapter.path));
    await page.goto(origin+'/?novel='+book.id,{waitUntil:'commit'});
    await page.locator('.novel-manuscript').waitFor({timeout:30000});
    await openChapter(page,chapter.path);
    const editor=page.getByRole('textbox',{name:'书稿正文',exact:true});
    await waitEditor(editor,original.text.replace(/\r\n|\r/g,'\n'));
    await page.reload({waitUntil:'commit'});await waitEditor(editor,original.text.replace(/\r\n|\r/g,'\n'));
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    opened=true;break;
  }
  assert(opened);
  const forward={origin:new URL(deployment.url).origin,'x-novel-host-auth':owner,
    'x-novel-forwarded-origin':new URL(deployment.url).origin,'x-novel-forward-as':'harness','x-novel-verification':verificationKey};
  const secure=await fetch(origin+'/api/auth/recover',{method:'POST',headers:{...forward,'content-type':'application/json'},body:JSON.stringify({accessKey:owner})});
  assert.equal(secure.status,200);await secure.arrayBuffer();
  assert(secure.headers.getSetCookie().every(c=>c.startsWith('__Host-')&&/; Secure/i.test(c)));
  const cookies=secure.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const auth=await fetch(origin+'/api/auth/session',{headers:{...forward,cookie:cookies}});
  assert.equal((await auth.json()).authenticated,true);
  assert(!logs.includes('PREVIEW_MODEL_CALL_REFUSED'));
  report.passed=true;report.books=5;report.sessions=31;report.coldHistory=true;report.browserReadReload=true;report.mobile390=true;report.secureRelayCookies=true;
}catch(e){report.failure=String(e.stack??e);process.exitCode=1;}
finally{
  if(browser)await browser.close();
  if(child&&child.exitCode===null){child.send({type:'novel-production-stop'});await new Promise(r=>child.once('exit',r));}
  await writeFile(join(dir,'preview-runtime.log'),logs,{mode:0o600});
  const raw=new Database(join(data,'main.sqlite'),{readonly:true,fileMustExist:true});
  const db={one:(sql,...args)=>raw.prepare(sql).get(...args),all:(sql,...args)=>raw.prepare(sql).all(...args),
    scalar(sql,...args){return Object.values(this.one(sql,...args)??{})[0];},run(){throw new Error('Read-only candidate check');}};
  const {SQLiteWorkspaceProvider}=await import(pathToFileURL(resolve('data/official-validation/integration/vfs.mjs')));
  const storage={raw,fs:new SQLiteWorkspaceProvider(db)};
  try{
    const expected=JSON.parse(await readFile(join(data,'book-fingerprints.json'),'utf8'));
    assert.deepEqual(vfsFileFingerprint(storage),expected,'Original formal book bytes changed in preview.');
    report.bookFilesUnchanged=expected.length;
  }finally{raw.close();}
  await writeFile(join(dir,'production-preview.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({...report,failure:report.failure?.split('\n')[0]}));
}
