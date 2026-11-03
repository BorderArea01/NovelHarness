import jsonPatch, { type Operation } from 'fast-json-patch';

export interface StatePatchPacket {
  operations: Operation[];
  arrays: { path: string; length: number }[];
  missing: string[];
}

export class PatchPreconditionError extends Error {
  constructor() {
    super('增量保存的基准内容已改变');
  }
}

const own = (value: any, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const escapeKey = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = (path: string): string[] => {
  if (path === '') return [];
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw new Error('无效 JSON Pointer');
  const tokens = path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.some((token) => ['__proto__', 'prototype', 'constructor'].includes(token)))
    throw new Error('禁止修改原型路径');
  return tokens;
};
const lookup = (document: any, path: string) => {
  let value = document;
  for (const key of pointer(path)) {
    if (value === null || typeof value !== 'object' || !own(value, key))
      return { exists: false, value: undefined };
    value = value[key];
  }
  return { exists: true, value };
};

// Match the existing SQLite writer's chapter representation and strip only
// runtime/global configuration. Unknown project data is left intact.
export function normalizeStateDocument(input: Record<string, any>): Record<string, any> {
  const data = { ...input };
  for (const key of [
    'baseURL',
    'apiKey',
    'model',
    'models',
    'apiConfigs',
    'activeConfigId',
    'modelRoutes',
    'modelRouteThinking',
    'modelRouteThinkingEffort',
  ])
    delete data[key];
  if (data.memory) {
    data.memory = { ...data.memory };
    delete data.memory.structuredStoryBible;
  }
  if (data.uiDrafts?.inspirationWriter) {
    data.uiDrafts = { ...data.uiDrafts, inspirationWriter: { ...data.uiDrafts.inspirationWriter } };
    delete data.uiDrafts.inspirationWriter.view;
  }
  if (Array.isArray(data.chapters))
    data.chapters = data.chapters
      .map((item: any) => ({
        chapter: Number(item.chapter),
        content: String(item.content ?? ''),
        bridge: item.bridge || null,
      }))
      .sort((a: any, b: any) => a.chapter - b.chapter);
  return JSON.parse(JSON.stringify(data));
}

// Identity-aware array edits avoid resending every old log when a new entry is
// inserted at the front. Generic arrays still retain their exact ordered data.
export function createStatePatch(before: Record<string, any>, after: Record<string, any>): StatePatchPacket {
  const operations: Operation[] = [],
    arrays = new Map<string, number>(),
    missing: string[] = [];
  const emit = (operation: Operation) => {
    pointer(operation.path);
    operations.push(operation);
  };
  const test = (path: string, value: any) => emit({ op: 'test', path, value });
  const remove = (path: string, value: any) => {
    test(path, value);
    emit({ op: 'remove', path });
  };
  const add = (path: string, value: any, objectKey = false, basePath = path) => {
    if (objectKey && !lookup(before, basePath).exists) missing.push(basePath);
    emit({ op: 'add', path, value });
  };
  const walk = (old: any, next: any, path: string, basePath = path) => {
    if (old === next) return;
    if (Array.isArray(old) && Array.isArray(next)) {
      const initial = operations.length;
      const records = [...old, ...next];
      const identity = ['id', 'chapter'].find(
        (key) =>
          records.length &&
          records.every(
            (row) => row && typeof row === 'object' && ['string', 'number'].includes(typeof row[key]),
          ) &&
          new Set(old.map((row) => `${typeof row[key]}:${row[key]}`)).size === old.length &&
          new Set(next.map((row) => `${typeof row[key]}:${row[key]}`)).size === next.length,
      );
      if (identity) {
        const working = [...old];
        const key = (row: any) => `${typeof row[identity]}:${row[identity]}`;
        const indices = new Map(old.map((row: any, index: number) => [key(row), index]));
        for (let i = 0; i < next.length; i++) {
          const index = working.findIndex((row) => key(row) === key(next[i]));
          if (index < 0) {
            add(`${path}/${i}`, next[i]);
            working.splice(i, 0, next[i]);
          } else {
            if (index !== i) {
              test(`${path}/${index}/${escapeKey(identity)}`, working[index][identity]);
              emit({ op: 'move', from: `${path}/${index}`, path: `${path}/${i}` });
              working.splice(i, 0, working.splice(index, 1)[0]);
            }
            walk(working[i], next[i], `${path}/${i}`, `${basePath}/${indices.get(key(working[i]))}`);
          }
        }
        for (let i = working.length - 1; i >= next.length; i--) {
          if (['/chapters', '/chapterSnapshots', '/operationLogs', '/agentEditHistory'].includes(basePath)) {
            test(`${path}/${i}/${escapeKey(identity)}`, working[i][identity]);
            emit({ op: 'remove', path: `${path}/${i}` });
          } else remove(`${path}/${i}`, working[i]);
        }
      } else {
        for (let i = 0; i < Math.min(old.length, next.length); i++)
          walk(old[i], next[i], `${path}/${i}`, `${basePath}/${i}`);
        for (let i = old.length - 1; i >= next.length; i--) remove(`${path}/${i}`, old[i]);
        for (let i = old.length; i < next.length; i++) add(`${path}/${i}`, next[i]);
      }
      if (operations.length !== initial && lookup(before, basePath).exists) arrays.set(basePath, old.length);
    } else if (
      old &&
      next &&
      typeof old === 'object' &&
      typeof next === 'object' &&
      !Array.isArray(old) &&
      !Array.isArray(next)
    ) {
      for (const key of Object.keys(old)) if (!own(next, key)) remove(`${path}/${escapeKey(key)}`, old[key]);
      for (const key of Object.keys(next)) {
        const target = `${path}/${escapeKey(key)}`;
        if (own(old, key)) walk(old[key], next[key], target, `${basePath}/${escapeKey(key)}`);
        else add(target, next[key], true, `${basePath}/${escapeKey(key)}`);
      }
    } else {
      test(path, old);
      emit({ op: 'replace', path, value: next });
    }
  };
  walk(before, after, '');
  return { operations, arrays: [...arrays].map(([path, length]) => ({ path, length })), missing };
}

export function applyStatePatch(document: Record<string, any>, patch: StatePatchPacket): Record<string, any> {
  for (const { path, length } of patch.arrays) {
    const value = lookup(document, path).value;
    if (!Array.isArray(value) || value.length !== length) throw new PatchPreconditionError();
  }
  for (const path of patch.missing) if (lookup(document, path).exists) throw new PatchPreconditionError();
  for (const op of patch.operations) {
    pointer(op.path);
    if ('from' in op) pointer(op.from);
  }
  const result = jsonPatch.applyPatch(
    structuredClone(document),
    patch.operations,
    true,
    true,
    true,
  ).newDocument;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('项目状态必须是对象');
  return result;
}
