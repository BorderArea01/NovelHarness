// Classic (non-module) bootstrap deliberately runs before the upstream deferred
// module. Extend the published graph; release-built, hash-pinned native UI
// composition adapters provide the novel shell without replacing the engine.
(() => {
  const id = 'novel-harness-bridge';
  const graph = globalThis.__DSH_BOOT__;
  const dependencies = [
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-settings-models',
    '@deepseek-ai/dsh-client-ui-settings-general',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-session',
  ];
  if (
    !graph ||
    !Array.isArray(graph.entries) ||
    !Array.isArray(graph.batches) ||
    !dependencies.every((name) => graph.entries.some((entry) => entry.id === name))
  ) {
    globalThis.addEventListener(
      'DOMContentLoaded',
      () => {
        const alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        alert.textContent = '小说工作台与当前引擎版本不匹配，请刷新或恢复上一正式版本；原书稿未改动。';
        document.body.prepend(alert);
      },
      { once: true },
    );
    return;
  }
  if (graph.entries.some((entry) => entry.id === id)) return;
  const revision = globalThis.document?.currentScript?.dataset?.novelRevision ?? 'development';
  const assetBase = '/studio/' + encodeURIComponent(revision) + '/pages/public/novel-assets/';
  globalThis.__NOVEL_ASSET_BASE__ = assetBase;
  for (const name of [
    'dsh-client-ui-conversation',
    'dsh-client-ui-sidebar',
    'dsh-client-ui-layout',
    'dsh-client-ui-settings-general',
  ]) {
    const nativeId = '@deepseek-ai/' + name;
    for (const entry of graph.entries.filter((entry) => entry.id === nativeId)) {
      entry.url = '/plugins/' + nativeId + '/client.js?novel=' + encodeURIComponent(revision);
      entry.rev = 'novel-shell-' + revision;
    }
    for (const batch of graph.batches.filter((batch) => batch.entries?.includes(nativeId))) {
      if (batch.entries.length !== 1) throw new Error('Unexpected native UI batch; shell bootstrap refused.');
      batch.url = '/plugins/' + nativeId + '/client.js?novel=' + encodeURIComponent(revision);
      batch.rev = 'novel-shell-' + revision;
    }
  }
  const rev = `novel-${revision}`;
  const url = assetBase + 'harness-bridge.mjs';
  graph.entries.push({ id, url, rev, inject: dependencies });
  graph.batches.push({ phase: 'application', url, rev, entries: [id] });
  graph.rev += `-${rev}`;
})();
