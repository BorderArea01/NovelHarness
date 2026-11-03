// Palette composition uses the ORIGINAL theme owner and original Appearance
// preference. Only the optional device-local accent is stored in the browser.
export const ACCENTS = Object.freeze({
  neutral: { label: '中性', light: '#353942', dark: '#d0d2d9' },
  blue: { label: '雾蓝', light: '#365aa3', dark: '#a4bdf2' },
  violet: { label: '浅紫', light: '#7550a2', dark: '#c8b1e8' },
  amber: { label: '琥珀', light: '#876019', dark: '#dcc38b' },
});
const key = 'novel-studio-accent';
const pair = (light, dark) => ({ light, dark });
export function studioTokens(accent = 'neutral') {
  const color = ACCENTS[accent] ?? ACCENTS.neutral;
  return {
    '--dsw-alias-bg-base': pair('#f5f5f7', '#151619'),
    '--dsw-alias-bg-layer-1': pair('#ffffff', '#1b1e24'),
    '--dsw-alias-bg-layer-2': pair('#f9fafb', '#242830'),
    '--dsw-alias-bg-layer-3': pair('#f0f2f5', '#2e333d'),
    '--dsw-alias-bg-module-platform': pair('#eceef1', '#1b1c20'),
    '--dsw-alias-border-l2': pair('#dfe1e6', '#303239'),
    '--dsw-alias-border-l3': pair('#d9dce2', '#36383f'),
    '--dsw-alias-label-primary': pair('#24262b', '#e8e9ed'),
    '--dsw-alias-label-secondary': pair('#565b66', '#b5b8c2'),
    '--dsw-alias-label-tertiary': pair('#636773', '#9a9da6'),
    '--dsw-alias-state-business-primary': pair(color.light, color.dark),
    '--dsw-alias-brand-primary': pair(color.light, color.dark),
    '--dsw-alias-link': pair(color.light, color.dark),
    '--dsw-alias-label-primary-foreground': pair('#ffffff', '#18191c'),
    '--dsw-alias-interactive-bg-hover': pair('#24262b0a', '#e8e9ed0b'),
    '--dsw-alias-interactive-bg-active': pair('#24262b12', '#e8e9ed14'),
    '--novel-control-bg': pair('#ffffff', '#292c34'),
    '--novel-control-border': pair('#7b818e', '#7d8494'),
    '--novel-control-hover': pair('#ebeef4', '#343947'),
    '--novel-control-disabled-bg': pair('#eceef2', '#24262c'),
    '--novel-surface-shadow': pair('0 4px 20px #1c243008', '0 4px 20px #00000018'),
  };
}
export function installStudioTheme(ctx, React, { storage } = {}) {
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null;
    }
  }
  let accent = 'neutral',
    release;
  try {
    const saved = storage?.getItem(key);
    if (Object.hasOwn(ACCENTS, saved)) accent = saved;
  } catch {}
  const listeners = new Set();
  const apply = () => {
    const old = release;
    release = ctx.theme.overrideTokens('novel-studio', studioTokens(accent));
    old?.(); // Original owner ignores an obsolete layer disposer.
    for (const listener of listeners) listener();
  };
  ctx.effect(() => {
    apply();
    return () => release?.();
  }, 'novel: unified native theme palette');
  const select = (value) => {
    if (!Object.hasOwn(ACCENTS, value)) throw new Error('未知强调色。');
    try {
      storage?.setItem(key, value);
    } catch {
      /* Palette still works for this visit. */
    }
    accent = value;
    apply();
  };
  ctx.effect(() => {
    const changed = (event) => {
      if (event.key === key) {
        accent = Object.hasOwn(ACCENTS, event.newValue) ? event.newValue : 'neutral';
        apply();
      }
    };
    globalThis.addEventListener?.('storage', changed);
    return () => globalThis.removeEventListener?.('storage', changed);
  }, 'novel: device accent synchronization');
  function AccentRow() {
    const selected = React.useSyncExternalStore(
      (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      () => accent,
    );
    return React.createElement(
      'fieldset',
      { className: 'novel-theme-accents' },
      React.createElement('legend', null, '强调色'),
      ...Object.entries(ACCENTS).map(([id, value]) =>
        React.createElement(
          'button',
          {
            key: id,
            type: 'button',
            'aria-pressed': selected === id,
            onClick: () => select(id),
          },
          value.label,
        ),
      ),
      React.createElement('small', null, '仅影响本设备；明暗模式沿用上方外观设置。'),
    );
  }
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'novel-accent',
        order: 10.5,
      },
      AccentRow,
    ),
  );
  return { select, getAccent: () => accent };
}
