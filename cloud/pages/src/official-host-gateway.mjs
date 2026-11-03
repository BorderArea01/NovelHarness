// Formal native host owns HTML, versioned assets, PIN and all data. Pages is
// only the same-origin service-binding carrier; no database, stale UI or fallback.
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    const fail=(error,status)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});
    if(url.protocol!=='https:')return fail('公网访问必须使用 HTTPS。',400);
    const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
    const socket=request.headers.get('upgrade')?.toLowerCase()==='websocket';
    if((!['GET','HEAD','OPTIONS'].includes(request.method)||socket)&&
      ((origin&&origin!==url.origin&&!(origin==='null'&&site==='same-origin'&&!socket))||site==='cross-site'))
      return fail('不接受跨站请求。',403);
    if(!env.HARNESS?.fetch)return fail('正式主机未连接。',503);
    try{return await env.HARNESS.fetch(request);}
    catch{return fail('本机服务暂时不可用；未切换到旧数据。',503);}
  },
};
