import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawerFocusables,
  focusNativeDrawer,
  handleNativeDrawerKey,
} from '../scripts/drawer-presentation.mjs';

function fixture() {
  const focused = [],
    scrolled = [];
  const node = (name, options = {}) => ({
    name,
    tabIndex: 0,
    disabled: false,
    matches: () => false,
    closest: () => null,
    getClientRects: () => [{}],
    focus: (options) => focused.push([name, options]),
    scrollIntoView: (options) => scrolled.push([name, options]),
    ...options,
  });
  const first = node('first'),
    last = node('last'),
    launcher = node('launcher');
  const document = { body: {}, activeElement: first };
  const sidebar = {
    querySelectorAll: () => [first, last],
    querySelector: () => first,
    contains: (target) => target === first || target === last,
    focus: (options) => focused.push(['sidebar', options]),
  };
  const frame = {
    ownerDocument: document,
    querySelector: (selector) =>
      selector === '.novel-native-sidebar-column'
        ? sidebar
        : selector === '.novel-mobile-navigation-toggle'
          ? launcher
          : null,
  };
  for (const target of [first, last, launcher]) {
    Object.defineProperty(target, 'value', {
      get: () => {
        throw Error('Must not read author input');
      },
    });
    Object.defineProperty(target, 'textContent', {
      get: () => {
        throw Error('Must not read author text');
      },
    });
  }
  return { first, last, sidebar, frame, document, focused, scrolled, node };
}
test('drawer focus helpers filter untabbable/hidden controls without reading author data', () => {
  const f = fixture();
  f.sidebar.querySelectorAll = () => [
    f.first,
    f.node('disabled', { disabled: true }),
    f.node('negative', { tabIndex: -1 }),
    f.node('hidden', { closest: () => ({}) }),
    f.node('unrendered', { getClientRects: () => [] }),
    f.last,
  ];
  assert.deepEqual(drawerFocusables(f.sidebar), [f.first, f.last]);
});
test('drawer focuses its close control and restores its launcher but never steals native dialog focus', () => {
  const f = fixture();
  focusNativeDrawer(f.frame, true, false);
  assert.deepEqual(f.focused, [['first', { preventScroll: true }]]);
  assert.deepEqual(f.scrolled, [['first', { block: 'nearest', inline: 'nearest', behavior: 'instant' }]]);
  f.focused.length = 0;
  f.document.activeElement = { nativeSettingsDialog: true };
  focusNativeDrawer(f.frame, false, true);
  assert.deepEqual(f.focused, []);
  f.document.activeElement = f.document.body;
  focusNativeDrawer(f.frame, false, true);
  assert.deepEqual(f.focused, [['launcher', { preventScroll: true }]]);
});
test('drawer keyboard boundaries wrap locally, honour handled keys and leave foreign modal keys alone', () => {
  const f = fixture();
  let closed = 0,
    prevented = 0;
  const event = (extra) => ({
    target: f.first,
    key: 'Tab',
    shiftKey: true,
    preventDefault: () => prevented++,
    stopPropagation() {},
    ...extra,
  });
  handleNativeDrawerKey(event(), f.frame, () => closed++);
  assert.equal(f.focused.at(-1)[0], 'last');
  f.document.activeElement = f.last;
  handleNativeDrawerKey(event({ target: f.last, shiftKey: false }), f.frame, () => closed++);
  assert.equal(f.focused.at(-1)[0], 'first');
  handleNativeDrawerKey(event({ key: 'Escape', target: {} }), f.frame, () => closed++);
  handleNativeDrawerKey(event({ key: 'Escape', defaultPrevented: true }), f.frame, () => closed++);
  assert.equal(closed, 0);
  handleNativeDrawerKey(event({ key: 'Escape' }), f.frame, () => closed++);
  assert.equal(closed, 1);
  assert.equal(prevented, 3);
});
