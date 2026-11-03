import test from 'node:test';
import assert from 'node:assert/strict';
import { productionAuthority, productionCookies } from '../official/novel/production-wire.mjs';
const config={ownerKey:'formal-secret-only-for-synthetic-tests-0123456789',publicOrigin:'https://novel.example',port:3211,
  authorities:new Set(['localhost:3211','192.0.2.10:3211'])};
test('formal native relay accepts only the existing fixed secret and public origin',()=>{
  const headers={host:'localhost','x-novel-host-auth':config.ownerKey,'x-novel-forwarded-origin':config.publicOrigin,
    'x-novel-forward-as':'harness',origin:config.publicOrigin};
  assert.equal(productionAuthority({url:'/api/test',headers},config).secure,true);
  for(const key of ['x-novel-host-auth','x-novel-forwarded-origin','x-novel-forward-as','origin'])
    assert.equal(productionAuthority({url:'/',headers:{...headers,[key]:'spoofed'}},config),null);
  assert.equal(productionAuthority({url:'/',headers:{host:'evil.invalid:3211'}},config),null);
  assert.equal(productionAuthority({url:'/',headers:{host:'192.0.2.10:3211',origin:'https://evil.invalid'}},config),null);
});
test('formal secure cookies cannot be substituted with staging or insecure owner cookies',()=>{
  assert.equal(productionCookies('dsh_edge_owner=evil; __Host-dsh_edge_owner=good; __Host-novel_pin=gate'),'dsh_edge_owner=good; novel_pin=gate');
  assert.equal(productionCookies('novel_pin=x; Path=/; HttpOnly',true),'__Host-novel_pin=x; Path=/; HttpOnly; Secure');
  assert.equal(productionCookies('novel_pin=x; Path=/; Secure',true),'__Host-novel_pin=x; Path=/; Secure');
});
