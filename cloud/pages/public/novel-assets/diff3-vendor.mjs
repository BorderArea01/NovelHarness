/* node-diff3 3.2.1 — generated, do not edit.
### The MIT License (MIT)

diff function extracted from Project Synchrotron.

For more detail please visit:
- https://leastfixedpoint.com/tonyg/kcbbs/projects/synchrotron.html
- https://github.com/tonyg/synchrotron

Copyright (c) 2006, 2008 Tony Garnock-Jones &lt;tonyg@lshift.net&gt;<br/>
Copyright (c) 2006, 2008 LShift Ltd. &lt;query@lshift.net&gt;<br/>
Copyright (c) 2019-2026 Bryan Housel &lt;bhousel@gmail.com&gt;<br/>

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files
(the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
function v(o,r){let i=Object.create(null);for(let n=0;n<r.length;n++){let l=r[n];i[l]?i[l].push(n):i[l]=[n]}let f=[{buffer1index:-1,buffer2index:-1,chain:null}];for(let n=0;n<o.length;n++){let l=o[n],b=i[l]||[],t=0,s=f[0];for(let e of b){let u;for(u=t;u<f.length&&!(f[u].buffer2index<e&&(u===f.length-1||f[u+1].buffer2index>e));u++);if(u<f.length){let c={buffer1index:n,buffer2index:e,chain:f[u]};if(t===f.length?f.push(s):f[t]=s,t=u+1,s=c,t===f.length)break}}f[t]=s}return f[f.length-1]}function L(o,r){let i=v(o,r),a=[],f=o.length,n=r.length;for(let l=i;l!==null;l=l.chain){let b=f-l.buffer1index-1,t=n-l.buffer2index-1;f=l.buffer1index,n=l.buffer2index,(b||t)&&a.push({buffer1:[f+1,b],buffer1Content:o.slice(f+1,f+1+b),buffer2:[n+1,t],buffer2Content:r.slice(n+1,n+1+t)})}return a.reverse(),a}function M(o,r,i){let a=[];function f(t,s){a.push({ab:s,oStart:t.buffer1[0],oLength:t.buffer1[1],abStart:t.buffer2[0],abLength:t.buffer2[1]})}L(r,o).forEach(t=>f(t,"a")),L(r,i).forEach(t=>f(t,"b")),a.sort((t,s)=>t.oStart-s.oStart);let n=[],l=0;function b(t){t>l&&(n.push({stable:!0,buffer:"o",bufferStart:l,bufferLength:t-l,bufferContent:r.slice(l,t)}),l=t)}for(;a.length;){let t=a.shift(),s=t.oStart,e=t.oStart+t.oLength,u=[t];for(b(s);a.length;){let c=a[0],d=c.oStart;if(d>e)break;e=Math.max(e,d+c.oLength),u.push(a.shift())}if(u.length===1){if(t.abLength>0){let c=t.ab==="a"?o:i;n.push({stable:!0,buffer:t.ab,bufferStart:t.abStart,bufferLength:t.abLength,bufferContent:c.slice(t.abStart,t.abStart+t.abLength)})}}else{let c={a:[o.length,-1,r.length,-1],b:[i.length,-1,r.length,-1]};for(;u.length;){t=u.shift();let x=t.oStart,p=x+t.oLength,C=t.abStart,E=C+t.abLength,h=c[t.ab];h[0]=Math.min(C,h[0]),h[1]=Math.max(E,h[1]),h[2]=Math.min(x,h[2]),h[3]=Math.max(p,h[3])}let d=c.a[0]+(s-c.a[2]),S=c.a[1]+(e-c.a[3]),g=c.b[0]+(s-c.b[2]),m=c.b[1]+(e-c.b[3]),k={stable:!1,aStart:d,aLength:S-d,aContent:o.slice(d,S),oStart:s,oLength:e-s,oContent:r.slice(s,e),bStart:g,bLength:m-g,bContent:i.slice(g,m)};n.push(k)}l=e}return b(r.length),n}function j(o,r,i,a){a=Object.assign({excludeFalseConflicts:!0,stringSeparator:/\s+/},a),typeof o=="string"&&(o=o.split(a.stringSeparator)),typeof r=="string"&&(r=r.split(a.stringSeparator)),typeof i=="string"&&(i=i.split(a.stringSeparator));let n=[],l=M(o,r,i),b=[];function t(){b.length&&n.push({ok:b}),b=[]}function s(e,u){if(e.length!==u.length)return!1;for(let c=0;c<e.length;c++)if(e[c]!==u[c])return!1;return!0}return l.forEach(e=>{e.stable?b.push(...e.bufferContent):a.excludeFalseConflicts&&s(e.aContent,e.bContent)?b.push(...e.aContent):(t(),n.push({conflict:{a:e.aContent,aIndex:e.aStart,o:e.oContent,oIndex:e.oStart,b:e.bContent,bIndex:e.bStart}}))}),t(),n}export{j as diff3Merge};
