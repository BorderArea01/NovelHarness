import { createStatePatch, normalizeStateDocument } from '@novel-writer/shared/state-patch';

(globalThis as typeof globalThis & { novelStatePatch: unknown }).novelStatePatch = Object.freeze({
  create: createStatePatch,
  normalize: normalizeStateDocument,
});
