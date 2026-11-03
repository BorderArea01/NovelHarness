import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import { studioTokens, ACCENTS } from '../pages/public/novel-assets/studio-theme.mjs';
import { contrast } from './control-contrast.mjs';
import { adaptNativeShell } from '../scripts/native-shell.mjs';

test('button palettes have readable primary/secondary text and visible outlines in every supported theme', () => {
  for (const accent of Object.keys(ACCENTS))
    for (const mode of ['light', 'dark']) {
      const tokens = studioTokens(accent),
        get = (key) => tokens[key][mode];
      assert.ok(
        contrast(get('--dsw-alias-label-primary'), get('--novel-control-bg')) >= 4.5,
        accent + ' ' + mode + ' secondary text',
      );
      assert.ok(
        contrast(get('--dsw-alias-label-primary'), get('--novel-control-hover')) >= 4.5,
        accent + ' ' + mode + ' hovered text',
      );
      assert.ok(
        contrast(get('--dsw-alias-label-primary-foreground'), get('--dsw-alias-state-business-primary')) >=
          4.5,
        accent + ' ' + mode + ' primary text',
      );
      for (const adjacent of ['--novel-control-bg', '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1'])
        assert.ok(
          contrast(get('--novel-control-border'), get(adjacent)) >= 3,
          accent + ' ' + mode + ' outline vs ' + adjacent,
        );
    }
});

test('stylesheet ownership never erases native assistant button surfaces or infers primary actions from child order', async () => {
  const sheets = await Promise.all(
    ['application.css', 'manuscript.css', 'harness-navigation.css'].map((name) =>
      readFile(new URL('../pages/public/novel-assets/' + name, import.meta.url), 'utf8'),
    ),
  );
  for (const source of sheets) {
    const css = postcss.parse(source);
    css.walkRules((rule) => {
      if (rule.selectors?.includes('.novel-desk button'))
        assert.fail('A desk-wide reset overrides native controls.');
      if (rule.selector === '.novel-manuscript button') {
        assert.ok(
          !rule.nodes.some((node) => node.prop === 'touch-action'),
          'A generic button rule must not override drag-handle touch ownership.',
        );
      }
      if (rule.selector === '.novel-mobile-navigation-toggle') {
        const color = rule.nodes.find((node) => node.prop === 'color')?.value;
        assert.ok(
          color?.includes('--dsw-alias-label-primary'),
          'Phone launcher must use the active light/dark text token.',
        );
      }
      if (rule.selector.includes('.novel-ms-actions') && rule.selector.includes(':first-child'))
        assert.fail('Primary actions must be semantic, not inferred from child order.');
    });
  }
  const css = postcss.parse(
    await readFile(new URL('../pages/public/auth-assets/auth.css', import.meta.url), 'utf8'),
  );
  assert.ok(css.nodes.length > 10, 'Login controls remain a real parsed stylesheet.');
});

test('compact reading only reflows the original idle composer and always yields to focus, native menus, running work and questions', async () => {
  const css = postcss.parse(
    await readFile(new URL('../pages/public/novel-assets/application.css', import.meta.url), 'utf8'),
  );
  let rules = 0;
  css.walkRules((rule) => {
    if (!rule.selector?.includes('[data-composer-card] > [data-input-scroll] + div')) return;
    rules++;
    for (const guard of [
      "[data-assistant='closed']",
      "[data-running='false']",
      ":not([data-pending-interaction='true'])",
      ':not(:focus-within)',
      "[aria-expanded='true']",
    ])
      assert.ok(rule.selector.includes(guard), 'Compact controls must respect ' + guard);
    assert.ok(rule.nodes.some((node) => node.prop === 'display' && node.value === 'none'));
  });
  assert.equal(rules, 1);
  const pinned = adaptNativeShell('conversation', await readFile(
    new URL('../tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', import.meta.url),
  ));
  assert.ok(pinned.includes('"data-input-scroll": true'));
  const input = pinned.indexOf(
    '(0, react_jsx_runtime.jsx)(DraftEditor, {',
    pinned.indexOf('"data-composer-card": true'),
  );
  const controls = pinned.indexOf('className: InputBar_module_css_default.row,', input);
  assert.ok(
    input > 0 && controls > input && controls - input < 1200,
    'Verify the pinned native input/control-row seam.',
  );
});

test('collapsed navigation shares one bounded hit area without resetting expanded navigation or native dialogs', async () => {
  const css = postcss.parse(
    await readFile(new URL('../pages/public/novel-assets/application.css', import.meta.url), 'utf8'),
  );
  let controls, launchers;
  css.walkRules((rule) => {
    if (rule.selectors?.includes(".novel-studio-sidebar[data-wide='false'] > button")) controls = rule;
    if (rule.selector?.includes("> [data-slot='sidebar.settings']")) launchers = rule;
  });
  assert.ok(controls);
  for (const selector of controls.selectors)
    assert.ok(selector.startsWith(".novel-studio-sidebar[data-wide='false']"));
  const values = Object.fromEntries(controls.nodes.map((node) => [node.prop, node.value]));
  assert.equal(values['box-sizing'], 'border-box');
  for (const dimension of ['width', 'height', 'min-width', 'min-height'])
    assert.equal(values[dimension], '44px');
  assert.equal(values.padding, '0');
  assert.ok(controls.selector.includes('.novel-native-navigation > button'));
  assert.ok(launchers.selector.includes(':has(.novel-native-navigation)'));
  assert.ok(!launchers.selector.includes('VOzbGW'), 'No generated upstream class dependency.');
});
