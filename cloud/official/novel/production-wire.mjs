// Same fixed secret/origin relay boundary as the existing formal host. This
// adapter never trusts client forwarding metadata or exposes the native cookie.
import { prepareHostRequest } from '../../host/host-wire.mjs';
export function productionAuthority(req, { ownerKey, publicOrigin, port, authorities }) {
  const headers = new Headers(req.headers);
  const forwarded = ['x-novel-host-auth', 'x-novel-forwarded-origin', 'x-novel-forward-as'].some(k => headers.has(k));
  if (!forwarded) {
    if (!authorities.has(req.headers.host)) return null;
    const outside = new URL('http://' + req.headers.host);
    const origin = headers.get('origin'), site = headers.get('sec-fetch-site');
    if (origin && origin !== outside.origin && !(origin === 'null' && site === 'same-origin')) return null;
    if (site === 'cross-site') return null;
    return { outside, inside: 'http://localhost:' + port, secure: false };
  }
  const probe = prepareHostRequest(new Request('http://localhost' + req.url, { headers }), {
    DSH_EDGE_ACCESS_KEY: ownerKey, NOVEL_PUBLIC_ORIGIN: publicOrigin,
  });
  if (probe.failure) return null;
  const outside = new URL(probe.request.url), origin = headers.get('origin'), site = headers.get('sec-fetch-site');
  if (origin && origin !== outside.origin && !(origin === 'null' && site === 'same-origin' && !headers.has('upgrade'))) return null;
  if (site === 'cross-site') return null;
  return { outside, inside: 'http://localhost:' + port, secure: true };
}
export function productionCookies(value, outgoing = false) {
  if (!outgoing) return value.split(';').map(p=>p.trim()).filter(p => !/^(?:dsh_edge_owner|novel_pin)=/.test(p))
    .join('; ').replace(/(^|;\s*)__Host-(dsh_edge_owner|novel_pin)=/g, '$1$2=');
  const next = value.replace(/^(dsh_edge_owner|novel_pin)=/, '__Host-$1=');
  return next + (/;\s*Secure(?:;|$)/i.test(next) ? '' : '; Secure');
}
