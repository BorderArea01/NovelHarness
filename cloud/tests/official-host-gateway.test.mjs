import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../pages/src/official-host-gateway.mjs';
test('formal Pages forwards native HTML/assets/streams unchanged without stale assets or database fallback',async()=>{
  for(const path of ['/','/studio/native/pages/public/novel-assets/app.mjs','/api/session/list']){
    const request=new Request('https://novel.example'+path),response=new Response('native');
    let calls=0;
    assert.equal(await gateway.fetch(request,{HARNESS:{fetch:r=>{calls++;assert.equal(r,request);return response;}},ASSETS:{fetch(){throw new Error('stale assets');}}}),response);
    assert.equal(calls,1);
  }
});
test('formal Pages rejects cross-site writes and sockets before reaching the host',async()=>{
  let calls=0;const env={HARNESS:{fetch(){calls++;}}};
  for(const method of ['POST','GET']){
    const response=await gateway.fetch(new Request('https://novel.example/api/test',{method,headers:{origin:'https://evil.example',...(method==='GET'?{upgrade:'websocket'}:{})}}),env);
    assert.equal(response.status,403);
  }
  assert.equal(calls,0);
  assert.equal((await gateway.fetch(new Request('https://novel.example/'),{})).status,503);
});
