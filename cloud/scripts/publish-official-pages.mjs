import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { existingProxyEnvironment, verificationTransport } from './verification-transport.mjs';
assert(process.argv.includes('--owner-requested'));
const deployment=JSON.parse(await readFile('data/cloud-platform/deployment.json','utf8'));
const relay=JSON.parse(await readFile('data/local-host/relay.json','utf8'));
const candidate=resolve('data/local-host/official-runtime');
const preview=JSON.parse(await readFile(join(candidate,'production-preview.json'),'utf8'));
assert.equal(preview.passed,true);
const health=await fetch('http://127.0.0.1:3211/api/health').then(r=>r.json());
assert.equal(health.runtime,'deepseek-harness');
assert.equal(health.published,false,'Keep writes closed until public verification finishes.');
const folder=resolve('data/local-host/official-pages');await mkdir(join(folder,'public'),{recursive:true});
await writeFile(join(folder,'public/_worker.js'),await readFile('cloud/pages/src/official-host-gateway.mjs'));
await writeFile(join(folder,'public/_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]}));
await writeFile(join(folder,'public/index.html'),'<!doctype html><title>小说工作台</title>');
await writeFile(join(folder,'wrangler.toml'),`name = ${JSON.stringify(deployment.pagesProject)}\npages_build_output_dir = "./public"\ncompatibility_date = "2026-08-14"\n[[services]]\nbinding = "HARNESS"\nservice = ${JSON.stringify(relay.worker)}\n`);
const proxy=await existingProxyEnvironment();
// The official CLI refreshes its own expired OAuth session. Do not assume a
// token read from disk is still valid, and never print credentials/account data.
const who=spawn(process.execPath,['--max-old-space-size=192',resolve('cloud/tools/node_modules/wrangler/bin/wrangler.js'),'whoami'],{
  cwd:folder,windowsHide:true,env:{...process.env,...proxy,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
who.stdout.resume();who.stderr.resume();
assert.equal(await new Promise((done,fail)=>{who.once('exit',done);who.once('error',fail);}),0,'Cloud authentication refresh failed.');
const source=await readFile(resolve(process.env.APPDATA,'xdg.config/.wrangler/config/default.toml'),'utf8');
const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(source)?.[1];assert(token);
const transport=await verificationTransport();
const url='https://api.cloudflare.com/client/v4/accounts/'+deployment.accountId+'/pages/projects/'+deployment.pagesProject;
const info=await transport.request(url,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)}).then(r=>r.json());
assert.equal(info.success,true);
assert.equal(info.result.deployment_configs.production.services.HARNESS.service,relay.worker);
const report={at:new Date().toISOString(),previousDeploymentId:info.result.canonical_deployment.id,project:deployment.pagesProject,
  service:relay.worker,publicUrl:deployment.url,published:false};
await writeFile('data/local-host/official-pages-publish.json',JSON.stringify(report,null,2),{mode:0o600});
await transport.close();
await writeFile(join(folder,'wrangler.toml'),`name = ${JSON.stringify(deployment.pagesProject)}\npages_build_output_dir = "./public"\ncompatibility_date = "2026-08-14"\n[[services]]\nbinding = "HARNESS"\nservice = ${JSON.stringify(relay.worker)}\n`);
const child=spawn(process.execPath,['--max-old-space-size=192',resolve('cloud/tools/node_modules/wrangler/bin/wrangler.js'),
  'pages','deploy','public','--project-name',deployment.pagesProject,'--branch','main','--commit-dirty=true'],{
  cwd:folder,windowsHide:true,env:{...process.env,...proxy,CI:'true',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:deployment.accountId},
  stdio:['ignore','pipe','pipe'],
});
let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b).slice(-16000);});
const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done);});
await writeFile(join(folder,'publish.log'),output,{mode:0o600});
assert.equal(code,0,'Pages publication failed; detailed private log retained.');
report.published=true;
await writeFile('data/local-host/official-pages-publish.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({pagesPublished:true,url:deployment.url,previousDeploymentRetained:true}));
