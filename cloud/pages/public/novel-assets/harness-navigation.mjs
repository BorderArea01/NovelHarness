// Settings own their renderer/store. Use the native shell's section callback;
// do not rehost model forms, inspect the DOM or submit model requests.

export function installNavigation(
  ctx,
  React,
  {
    url = window.location.href,
    replaceUrl = (next) => window.history.replaceState(window.history.state, '', next),
    navigation,
    ready,
  } = {},
) {
  const h = React.createElement;
  const icon = (kind) =>
    h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: 18,
        height: 18,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        'aria-hidden': true,
      },
      h('path', {
        d:
          kind === 'book'
            ? 'M12 5v15M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z'
            : 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
      }),
    );
  function LibraryLink({ wide }) {
    return h(
      'nav',
      {
        className: 'novel-native-navigation',
        'data-wide': wide ? 'true' : 'false',
        'aria-label': '小说导航',
      },
      h(
        'a',
        {
          href: '/novels/',
          title: '小说库',
          'aria-label': '小说库',
          onClick: navigation
            ? (event) => {
                event.preventDefault();
                navigation.library();
              }
            : undefined,
        },
        icon('book'),
        wide ? h('span', null, '小说库') : null,
      ),
      globalThis.document?.body?.dataset.novelAuth === 'anonymous' ? null : h(
        'a',
        {
          href: '/account/',
          title: '账号与 PIN',
          'aria-label': '账号与 PIN',
          onClick: navigation
            ? (event) => {
                event.preventDefault();
                navigation.account();
              }
            : undefined,
        },
        icon('models'),
        wide ? h('span', null, '账号') : null,
      ),
    );
  }
  function SettingsLauncher({ wide, settingsOpen, openSettings, openSettingsSection, settingsShortcut }) {
    const initial = React.useRef(false);
    React.useEffect(() => navigation?.bindModels(() => openSettingsSection('models')), [openSettingsSection]);
    React.useEffect(() => {
      if (initial.current) return;
      if (new URL(url).searchParams.get('settings') !== 'models') return;
      initial.current = 'pending';
      const activate = () => {
        if (initial.current !== 'pending') return;
        initial.current = true;
        // Consume only our query on the CURRENT address. Startup or the author
        // may already have selected a main view while catalogs were loading.
        const next = new URL(globalThis.location?.href ?? url);
        if (next.searchParams.get('settings') === 'models') {
          next.searchParams.delete('settings');
          replaceUrl(next);
        }
        openSettingsSection('models');
      };
      if (ready)
        ready.then(activate, () => {}); // bridge owns startup errors
      else activate();
      return () => {
        initial.current = true;
      };
    }, [openSettingsSection]);
    return h(
      'div',
      { className: 'novel-native-navigation', 'data-wide': wide ? 'true' : 'false' },
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            initial.current = true;
            openSettingsSection('models');
          },
          title: '模型设置',
          'aria-label': '模型设置',
          'aria-haspopup': 'dialog',
        },
        icon('models'),
        wide ? h('span', null, '模型') : null,
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            initial.current = true;
            openSettings();
          },
          title: '设置',
          'aria-label': '设置',
          'aria-haspopup': 'dialog',
          'aria-expanded': settingsOpen,
          'aria-keyshortcuts': settingsShortcut?.aria,
        },
        h('span', { 'aria-hidden': true }, '⚙'),
        wide ? h('span', null, '设置') : null,
      ),
    );
  }
  ctx.slots.inject('settings.launcher', () =>
    ctx.slots.register({ name: 'settings.launcher' }, SettingsLauncher),
  );
  if (!navigation)
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({ name: 'sidebar.footer.action', id: 'novel-navigation', order: -10 }, LibraryLink),
    );
}
