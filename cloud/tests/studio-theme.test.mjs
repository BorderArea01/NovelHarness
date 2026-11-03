import test from 'node:test';
import assert from 'node:assert/strict';
import { studioTokens, installStudioTheme } from '../pages/public/novel-assets/studio-theme.mjs';
test('blocked optional browser storage cannot prevent the original application theme from mounting', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  const cleanup = [];
  try {
    const owner = installStudioTheme(
      {
        effect(fn) {
          cleanup.push(fn());
        },
        theme: {
          overrideTokens() {
            return () => {};
          },
        },
        slots: { inject: (_slot, fn) => fn(), register: () => {} },
      },
      {},
    );
    assert.equal(owner.getAccent(), 'neutral');
    owner.select('violet');
    assert.equal(owner.getAccent(), 'violet');
  } finally {
    cleanup.reverse().forEach((fn) => fn?.());
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
test('unified neutral palette composes on original theme owner, retains light/dark/system preference and safely restores device accent', () => {
  const calls = [],
    cleanup = [],
    stored = new Map([['novel-studio-accent', 'blue']]);
  let row;
  const owner = installStudioTheme(
    {
      effect(fn) {
        cleanup.push(fn());
      },
      theme: {
        overrideTokens(source, tokens) {
          calls.push({ source, tokens });
          return () => {};
        },
      },
      slots: {
        inject: (_slot, fn) => fn(),
        register: (options, component) => {
          row = { options, component };
        },
      },
    },
    {},
    { storage: { getItem: (k) => stored.get(k), setItem: (k, v) => stored.set(k, v) } },
  );
  assert.equal(owner.getAccent(), 'blue');
  assert.equal(row.options.name, 'settings.general.item');
  owner.select('neutral');
  assert.equal(stored.get('novel-studio-accent'), 'neutral');
  assert.equal(calls.at(-1).source, 'novel-studio');
  assert.equal(calls.at(-1).tokens['--dsw-alias-bg-base'].dark, '#151619');
  assert.equal(calls.at(-1).tokens['--dsw-alias-bg-base'].light, '#f5f5f7');
  assert.throws(() => owner.select('invalid'));
  assert.deepEqual(studioTokens('unknown'), studioTokens('neutral'));
  cleanup.reverse().forEach((fn) => fn?.());
});
