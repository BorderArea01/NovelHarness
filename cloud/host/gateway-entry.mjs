import { handleRequest } from '../pages/src/gateway.mjs';
import harness from '../worker/entry.mjs';
import { prepareHostRequest } from './host-wire.mjs';
export { DshEdgeInstance, PinAuth } from '../worker/entry.mjs';
// Same Pages router and native Harness, one local process and one asset binding.
// Returning original Responses also preserves the native WebSocket carrier.
function nativeFetch(incoming, env, ctx) {
    const path = new URL(incoming.url).pathname;
    // In production the native Worker's assets router serves plugin modules
    // before its API fetch handler. Preserve that boundary in the combined host.
    if (!path.startsWith('/api/') && path !== '/' && path !== '/login'
      && incoming.headers.get('upgrade')?.toLowerCase() !== 'websocket') return env.ASSETS.fetch(incoming);
    return harness.fetch(incoming, env, ctx);
}
export default { async fetch(original, env, ctx) {
  const prepared = prepareHostRequest(original, env);
  if (prepared.failure) return prepared.failure;
  if (prepared.mode === 'harness') return nativeFetch(prepared.request, env, ctx);
  const response = await handleRequest({ request: prepared.request, env: { ...env, HARNESS: { fetch: (incoming) => nativeFetch(incoming, env, ctx) } } });
  if (prepared.insecureLan && response.headers.get('content-type')?.includes('text/html')) {
    return new HTMLRewriter().on('head', { element(head) { head.prepend('<script src="/__host-assets/crypto-boot.js"></script>', { html: true }); } }).transform(response);
  }
  return response;
} };
