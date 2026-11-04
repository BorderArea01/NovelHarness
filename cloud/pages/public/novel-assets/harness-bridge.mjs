// Native DSH client-module registration, not an ES module despite the asset suffix.
window.__ModuleLoader__.load({
  id: 'novel-harness-bridge',
  factory: (require) => ({
    inject: [
      'uiWorkspace',
      'workspaces',
      'sessions',
      'conversation',
      'layout',
      'configForms',
      'theme',
      'slots',
      'sidebarRight',
      'sidebarRightTabs',
      'uiConversation',
      'uiSession',
    ],
    apply(ctx) {
      const owner = new AbortController();
      // Catalog subscriptions live with this plugin. A slow first connection
      // must be allowed to recover instead of permanently expiring the owner.
      const signal = owner.signal;
      ctx.effect(() => () => owner.abort(), 'novel-harness: navigation owner');
      const checkSession = async () => {
        if (document.visibilityState === 'hidden' || owner.signal.aborted) return;
        try {
          const response = await fetch('/api/auth/session', {
            credentials: 'same-origin',
            signal: owner.signal,
          });
          if (response.ok && (await response.json()).authenticated === false)
            window.location.replace('/login');
        } catch {
          /* A transient network failure must not discard the current view. */
        }
      };
      const sessionTimer = setInterval(checkSession, 60000);
      document.addEventListener('visibilitychange', checkSession);
      ctx.effect(
        () => () => {
          clearInterval(sessionTimer);
          document.removeEventListener('visibilitychange', checkSession);
        },
        'novel-harness: session epoch check',
      );
      const assetBase = globalThis.__NOVEL_ASSET_BASE__ ?? '/novel-assets/';
      Promise.all([
        import(assetBase + 'bridge-core.mjs'),
        import(assetBase + 'harness-navigation.mjs'),
        import(assetBase + 'manuscript.mjs'),
        import(assetBase + 'application.mjs'),
        import(assetBase + 'task-message.mjs'),
        import(assetBase + 'proposal-tool-view.mjs'),
        import(assetBase + 'studio-theme.mjs'),
      ])
        .then(
          async ([
            { openNovel, ensureDarkDefault, waitForNativeCatalogs },
            { installNavigation },
            { installManuscript },
            { installApplication },
            { installTaskMessages },
            { installProposalToolViews },
            { installStudioTheme },
          ]) => {
            const createPortal = require('react-dom').createPortal;
            installStudioTheme(ctx, require('react'));
            const navigation = installApplication(ctx, require('react'), { createPortal });
            installTaskMessages(ctx, require('react'));
            installProposalToolViews(ctx, require('react'));
            const nativeReady = waitForNativeCatalogs(ctx, { signal }).then(() => navigation.initial());
            installNavigation(ctx, require('react'), { navigation, ready: nativeReady });
            installManuscript(ctx, require('react'), { navigation, createPortal });
            navigation.initial();
            // Theme settings readiness is independent of book navigation.
            const themeReady = ensureDarkDefault(ctx, { signal });
            const url = new URL(window.location.href);
            if (url.searchParams.has('novel')) {
              await Promise.all([
                themeReady,
                nativeReady,
                openNovel(ctx, { url: window.location.href, signal, prepareDraft: false }),
              ]);
              // Settings and author navigation can update the address while
              // startup awaits native services. Never write the captured OLD
              // query back over their newer intent (e.g. consumed ?settings).
              const current = new URL(window.location.href);
              if (current.searchParams.get('novel') === url.searchParams.get('novel')) {
                current.searchParams.delete('novel');
                window.history.replaceState(window.history.state, '', current);
              }
            } else await Promise.all([themeReady, nativeReady]);
            navigation.initial();
          },
        )
        .catch((error) => {
          if (owner.signal.aborted || error.name === 'AbortError') return;
          const alert = document.createElement('aside');
          alert.setAttribute('role', 'alert');
          alert.append(
            document.createTextNode(
              error.name === 'TimeoutError'
                ? '小说工作区加载超时，请从小说库重试。'
                : error.message || '小说衔接失败，原数据未改动。',
            ),
          );
          const link = document.createElement('a');
          link.href = '/novels/';
          link.textContent = ' 返回小说库';
          alert.append(link);
          // Independent recovery notice; do not replace the native React root.
          document.body.prepend(alert);
          ctx.effect(() => () => alert.remove(), 'novel-harness: recovery notice');
        });
    },
  }),
});
