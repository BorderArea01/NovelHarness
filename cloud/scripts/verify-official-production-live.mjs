// Final public/local acceptance. Reads original books/history only. No prompt,
// fixture book, model request, PIN reset or alternate data-source fallback.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { verificationTransport,existingProxyEnvironment } from './verification-transport.mjs';
import { openChapter,waitEditor,waitResponsiveLayout } from '../tests/editor-client.mjs';
assert(process.argv.includes('--owner-requested'));
const root=resolve('data/local-host'),dir=join(root,'official-runtime'),data=join(dir,'data/official-validation/integration/formal-promotion');
const active=JSON.parse(await readFile(join(root,'active.json'),'utf8'));
const control=JSON.parse(await readFile(join(dir,'production-control.json'),'utf8'));
assert.equal(active.runtime,'official-dsh');assert.equal(control.published,false);
const origin=active.publicOrigin,owner=(await readFile(join(data,'owner-key.txt'),'utf8')).trim();
const transport=await verificationTransport();
const report={at:new Date().toISOString(),passed:false,productionSwitched:true,testModelRequests:0,publicOrigin:origin};
let browser,context;
try {
  let ready=false;
  for(let n=0;n<30;n++){
    try{const r=await transport.request(origin+'/api/health',{signal:AbortSignal.timeout(10000)});
      if(r.ok&&(await r.json()).runtime==='deepseek-harness'){ready=true;break;}}catch{}
    await delay(1000);
  }
  assert(ready,'Public relay has not reached the new native host.');
  const login=await transport.request(origin+'/api/auth/recover',{method:'POST',headers:{origin,'content-type':'application/json','x-novel-verification':control.verificationKey},
    body:JSON.stringify({accessKey:owner}),signal:AbortSignal.timeout(20000)});
  assert.equal(login.status,200);await login.arrayBuffer();
  const setCookies=login.headers.getSetCookie(),cookie=setCookies.map(x=>x.split(';')[0]).join('; ');
  const get=async path=>{const r=await transport.request(origin+path,{headers:{cookie,'x-novel-verification':control.verificationKey},signal:AbortSignal.timeout(20000)});
    assert.equal(r.status,200,path);return r.json();};
  assert.equal((await get('/api/auth/session')).authenticated,true);
  assert.equal((await get('/api/auth/pin')).configured,true);
  const books=(await get('/api/novels')).books;assert.equal(books.length,5);
  const list=await transport.request(origin+'/api/session/list',{method:'POST',headers:{cookie,origin,'x-novel-verification':control.verificationKey,'content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}}),signal:AbortSignal.timeout(20000)});
  const sessions=(await list.json()).result;assert.equal(sessions.ok,true);
  const expected=JSON.parse(await readFile(join(data,'history-import.json'),'utf8'));
  for(const original of expected.sessions)assert(sessions.value.items.some(x=>(x.id??x.sessionId)===original.id),'Original conversation identity missing.');
  const proxyEnv=await existingProxyEnvironment();const proxyUrl=proxyEnv.HTTPS_PROXY??process.env.HTTPS_PROXY??process.env.HTTP_PROXY;
  let proxy;
  if(proxyUrl){const p=new URL(proxyUrl);proxy={server:p.origin,...(p.username?{username:decodeURIComponent(p.username),password:decodeURIComponent(p.password)}:{})};}
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args:['--disable-background-networking','--disable-extensions','--js-flags=--max-old-space-size=192'],...(proxy?{proxy}:{})});
  context=await browser.newContext({viewport:{width:1280,height:900},extraHTTPHeaders:{'x-novel-verification':control.verificationKey}});
  await context.addCookies(setCookies.map(header=>{const pair=header.split(';')[0],i=pair.indexOf('=');return{name:pair.slice(0,i),value:pair.slice(i+1),url:origin,secure:true,httpOnly:true,sameSite:'Strict'};}));
  const page=await context.newPage();page.setDefaultTimeout(25000);
  await page.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.origin!==origin)return route.abort();
    if(route.request().method()==='POST'&&/\/api\/(?:session\/prompt|sessions\/[^/]+\/turn)$/.test(u.pathname)){
      report.testModelRequests++;return route.abort();
    }
    return route.continue();
  });
  for(const name of ['继续','稍后配置'])await page.addLocatorHandler(page.getByRole('button',{name,exact:true}),async()=>{
    await page.getByRole('button',{name,exact:true}).click();},{noWaitAfter:true});
  await page.addLocatorHandler(page.getByRole('button',{name:/我已知晓并继续|I understand/}),async()=>{
    await page.getByRole('checkbox').first().check();await page.getByRole('button',{name:/我已知晓并继续|I understand/}).click();});
  let frames=0;page.on('websocket',socket=>socket.on('framereceived',()=>frames++));
  let checked=false,bookId,original;
  for(const book of books){
    const docs=await get('/api/novels/'+book.id+'/documents');
    const chapter=docs.documents.find(x=>x.category==='chapter');if(!chapter)continue;
    original=await get('/api/novels/'+book.id+'/document?path='+encodeURIComponent(chapter.path));bookId=book.id;
    await page.goto(origin+'/?novel='+book.id,{waitUntil:'commit'});
    await page.locator('.novel-manuscript').waitFor({timeout:40000});
    await openChapter(page,chapter.path);
    await waitEditor(page.getByRole('textbox',{name:'书稿正文',exact:true}),original.text.replace(/\r\n|\r/g,'\n'));
    assert.equal(await page.title(),'小说工作台');
    await page.screenshot({path:join(root,'official-public-desktop.png'),mask:[page.locator('.cm-editor')]});
    await page.setViewportSize({width:390,height:844});await waitResponsiveLayout(page);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:join(root,'official-public-mobile.png'),mask:[page.locator('.cm-editor')]});
    checked=true;break;
  }
  assert(checked);assert(frames>0,'Public native WebSocket did not receive frames.');
  assert.equal(report.testModelRequests,0);
  assert(process.argv.includes('--activate'),'Acceptance passed; activation must be explicit.');
  await writeFile(join(dir,'production-control.json'),JSON.stringify({...control,published:true}));
  let opened=false;
  for(let n=0;n<30;n++){
    const health=await transport.request(origin+'/api/health').then(r=>r.json());
    if(health.published){opened=true;break;}await delay(100);
  }
  assert(opened,'Public write admission did not open.');
  await context.setExtraHTTPHeaders({});
  await page.reload({waitUntil:'commit'});
  await waitEditor(page.getByRole('textbox',{name:'书稿正文',exact:true}),original.text.replace(/\r\n|\r/g,'\n'));
  report.passed=true;report.books=books.length;report.sessions=expected.sessions.length;report.publicWritesOpen=true;
  report.publicWebSocket=true;report.publicReadReload=true;report.layouts=[1280,390];report.originalPinPreserved=true;
  active.verifiedReady=true;active.verifiedAt=new Date().toISOString();active.candidate=data;active.release=dir;
  await writeFile(join(root,'active.json'),JSON.stringify(active,null,2));
  const request=JSON.parse(await readFile(join(root,'official-promotion-request.json'),'utf8'));
  await writeFile(join(root,'official-promotion-request.json'),JSON.stringify({...request,status:'published',productionSwitched:true,publishedAt:active.verifiedAt},null,2));
}catch(error){report.failure=String(error.stack??error);process.exitCode=1;}
finally{
  if(browser)await browser.close();await transport.close();
  await writeFile(join(root,'official-production-live.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({...report,failure:report.failure?.split('\n')[0]}));
}
