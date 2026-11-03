import test from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleViewport,
  bindVisibleViewport,
  revealFocusedControl,
} from '../pages/public/novel-assets/visual-viewport.mjs';

function fixture() {
  const events = new EventTarget(),
    document = new EventTarget(),
    viewport = new EventTarget();
  const values = new Map(),
    attrs = new Map(),
    frames = new Map();
  let next = 0;
  Object.assign(viewport, { height: 360, offsetTop: 24, scale: 1 });
  document.activeElement = { closest: () => true };
  document.documentElement = {
    style: { setProperty: (k, v) => values.set(k, v), removeProperty: (k) => values.delete(k) },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
  const window = Object.assign(events, {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: viewport,
    document,
    requestAnimationFrame: (fn) => {
      frames.set(++next, fn);
      return next;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  return {
    window,
    document,
    viewport,
    values,
    attrs,
    frames,
    flush: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}
test('visible input geometry follows browser dimensions, never treats pinch zoom or a desktop window as keyboard space', () => {
  const f = fixture();
  assert.deepEqual(visibleViewport(f.window), { height: 360, top: 24 });
  f.viewport.scale = 2;
  assert.equal(visibleViewport(f.window), null);
  f.viewport.scale = 1;
  f.window.innerWidth = 1280;
  assert.equal(visibleViewport(f.window), null);
  f.window.innerWidth = 390;
  f.document.activeElement = null;
  assert.deepEqual(
    visibleViewport(f.window),
    { height: 360, top: 24 },
    'Menus retain visible bounds when focus leaves an editor.',
  );
  f.document.activeElement = { closest: () => true };
  f.viewport.height = 844;
  f.viewport.offsetTop = 0;
  assert.equal(visibleViewport(f.window), null);
});
test('viewport bindings coalesce browser events, restore normal layout on full viewport/zoom and cancel owned callbacks at disposal', () => {
  const f = fixture(),
    stop = bindVisibleViewport(f.window);
  assert.equal(f.values.get('--novel-visible-height'), '360px');
  f.viewport.height = 300;
  f.viewport.dispatchEvent(new Event('resize'));
  f.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.values.get('--novel-visible-height'), '300px');
  f.viewport.scale = 2;
  f.viewport.dispatchEvent(new Event('resize'));
  f.flush();
  assert.equal(f.attrs.size, 0);
  assert.equal(f.values.size, 0);
  f.viewport.scale = 1;
  f.viewport.dispatchEvent(new Event('resize'));
  f.flush();
  assert.equal(f.values.size, 2);
  f.document.activeElement = null;
  f.viewport.height = 844;
  f.viewport.offsetTop = 0;
  f.viewport.dispatchEvent(new Event('resize'));
  f.flush();
  assert.equal(f.values.size, 0);
  f.viewport.dispatchEvent(new Event('resize'));
  stop();
  assert.equal(f.frames.size, 0);
  f.flush();
  f.viewport.dispatchEvent(new Event('resize'));
  assert.equal(f.frames.size, 0);
  assert.equal(typeof bindVisibleViewport(undefined), 'function');
});

test('native fields reveal inside their own manuscript scroller without reading text or moving a zoomed page', () => {
  const f = fixture(),
    body = { scrollTop: 0, getBoundingClientRect: () => ({ top: 120, bottom: 320 }) },
    field = {
      matches: (selector) => selector.includes('textarea'),
      closest: (selector) => (selector === '.novel-ms-body' ? body : null),
      getBoundingClientRect: () => ({ top: 400, bottom: 520 }),
      get value() {
        throw new Error('Geometry controller must not read text');
      },
    };
  f.document.activeElement = field;
  const stop = bindVisibleViewport(f.window);
  f.flush();
  assert.equal(body.scrollTop, 200);
  field.getBoundingClientRect = () => ({ top: 40, bottom: 100 });
  f.viewport.dispatchEvent(new Event('resize'));
  f.flush();
  f.flush();
  assert.equal(body.scrollTop, 120);
  f.viewport.dispatchEvent(new Event('resize'));
  f.flush();
  f.viewport.scale = 2; // Pinch starts before the queued reveal.
  f.flush();
  assert.equal(body.scrollTop, 120);
  f.viewport.scale = 1;
  f.viewport.dispatchEvent(new Event('resize'));
  f.flush();
  stop();
  f.flush();
  assert.equal(body.scrollTop, 120);
});

test('native settings geometry reveals horizontal sections and focused fields without changing focus or reading values', () => {
  const f = fixture(),
    nav = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 12, right: 588 }) },
    options = { scrollTop: 0, getBoundingClientRect: () => ({ top: 140, bottom: 326 }) };
  const control = {
    matches: (selector) => selector.includes('> nav'),
    parentElement: nav,
    getBoundingClientRect: () => ({ left: 584, right: 698 }),
    get value() {
      throw Error('Must not read native settings values');
    },
    focus() {
      throw Error('Original modal owns focus');
    },
  };
  f.document.activeElement = control;
  revealFocusedControl(f.window);
  assert.equal(nav.scrollLeft, 110);
  control.getBoundingClientRect = () => ({ left: -20, right: 90 });
  revealFocusedControl(f.window);
  assert.equal(nav.scrollLeft, 78);
  control.matches = (selector) => selector.includes('textarea');
  control.closest = (selector) => (selector.startsWith('[data-shortcut-modal=') ? options : null);
  control.getBoundingClientRect = () => ({ top: 400, bottom: 440 });
  revealFocusedControl(f.window);
  assert.equal(options.scrollTop, 114);
  f.viewport.scale = 2;
  revealFocusedControl(f.window);
  assert.equal(options.scrollTop, 114);
  f.viewport.scale = 1;
  f.window.innerWidth = 1280;
  revealFocusedControl(f.window);
  assert.equal(options.scrollTop, 114);
  f.window.innerWidth = 390;
  f.window.getComputedStyle = () => ({ scrollPaddingTop: '12px', scrollPaddingBottom: '12px' });
  revealFocusedControl(f.window);
  assert.equal(options.scrollTop, 240);
});

test('native settings focus callbacks coalesce and are released without changing the original field focus', () => {
  const f = fixture(),
    nav = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 12, right: 588 }) },
    control = {
      matches: (selector) => selector.includes('> nav'),
      closest: () => ({}),
      parentElement: nav,
      getBoundingClientRect: () => ({ left: 584, right: 698 }),
    };
  const stop = bindVisibleViewport(f.window);
  f.document.activeElement = control;
  const focus = () => {
    const event = new Event('focusin');
    Object.defineProperty(event, 'target', { value: control });
    f.document.dispatchEvent(event);
  };
  focus();
  focus();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(nav.scrollLeft, 110);
  assert.equal(f.document.activeElement, control);
  focus();
  stop();
  assert.equal(f.frames.size, 0);
  focus();
  assert.equal(f.frames.size, 0);
});
