// Read-only control-plane diagnostics. Never deploy, enable tail (which can
// reset live DOs), change credentials, or inspect story/auth storage contents.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const state = JSON.parse(
  await readFile(new URL('../../data/cloud-platform/deployment.json', import.meta.url), 'utf8'),
);
const token =
  process.env.CLOUDFLARE_API_TOKEN ||
  (await readFile(resolve(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8')).match(
    /^oauth_token\s*=\s*"([^"]+)"/m,
  )?.[1];
if (!token) throw new Error('Existing Cloudflare API credential not available.');
async function api(path, body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
const base = '/accounts/' + state.accountId;
const tasks = process.argv.includes('--metrics')
  ? ['metrics', 'subscriptions']
  : ['settings', 'deployments', 'namespaces', 'schema'];
for (const task of tasks) {
  try {
    let response;
    if (task === 'metrics') {
      const from = new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
        to = new Date().toISOString();
      const filter = `datetime_geq: "${from}", datetime_leq: "${to}"`;
      response = await api('/graphql', {
        query: `{ viewer { accounts(filter: {accountTag: "${state.accountId}"}) { durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {${filter}}) { dimensions { status namespaceId } sum { requests } } durableObjectsPeriodicGroups(limit: 100, filter: {${filter}}) { dimensions { namespaceId } sum { cpuTime duration activeTime rowsRead rowsWritten fatalInternalErrors exceededMemoryErrors exceededCpuErrors } } } } }`,
      });
    } else if (task === 'schema') {
      response = await api('/graphql', {
        query:
          '{ dimension: __type(name: "AccountDurableObjectsInvocationsAdaptiveGroupsDimensions") {fields {name}} sums: __type(name: "AccountDurableObjectsPeriodicGroupsSum") {fields {name}} }',
      });
    } else if (task === 'namespaces') response = await api(base + '/workers/durable_objects/namespaces');
    else if (task === 'subscriptions') response = await api(base + '/subscriptions');
    else response = await api(base + '/workers/scripts/' + state.workerName + '/' + task);
    const data = response.data;
    let summary = data.errors?.length
      ? { errors: data.errors.map((e) => ({ code: e.code, message: e.message })) }
      : (data.result ?? data.data);
    if (task === 'settings' && data.result)
      summary = {
        observability: data.result.observability,
        limits: data.result.limits,
        bindings: data.result.bindings?.map((b) => ({
          type: b.type,
          name: b.name,
          class_name: b.class_name,
          namespace_id: b.namespace_id,
        })),
      };
    if (task === 'namespaces' && data.result)
      summary = data.result
        .filter((n) => n.script === state.workerName)
        .map((n) => ({ id: n.id, class: n.class, name: n.name }));
    if (task === 'deployments' && data.result)
      summary = data.result.deployments
        ?.slice(0, 2)
        .map((d) => ({ created_on: d.created_on, source: d.source, versions: d.versions }));
    if (task === 'subscriptions' && data.result)
      summary = data.result.map((s) => ({
        plan: s.rate_plan?.public_name ?? s.rate_plan?.name ?? s.plan?.name,
        status: s.state,
      }));
    console.log(JSON.stringify({ task, status: response.status, summary }));
  } catch (error) {
    console.log(
      JSON.stringify({ task, error: error.message.replaceAll(token, '[redacted]'), code: error.cause?.code }),
    );
  }
}
