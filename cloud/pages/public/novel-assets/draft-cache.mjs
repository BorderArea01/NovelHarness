// Only UNCOMMITTED local recovery data. Published books remain in original VFS.
const DATABASE = 'novel-unsubmitted-v1',
  STORE = 'drafts',
  owner = crypto.randomUUID();
let opening;
const queues = new Map();
const valid = (v) =>
  v && typeof v.text === 'string' && typeof v.baseText === 'string' && /^[a-f0-9]{64}$/.test(v.hash ?? '');
function legacy(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}
function removeLegacy(key, value) {
  const old = legacy(key);
  if (old && old.hash === value.hash && old.text === value.text && old.baseText === value.baseText)
    try {
      localStorage.removeItem(key);
    } catch {
      /* old recovery copy stays */
    }
}
function open() {
  if (opening) return opening;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('本机草稿数据库不可用；请保存云端或下载本地稿。'));
      }
    };
    const timer = setTimeout(fail, 5000);
    let request;
    try {
      request = indexedDB.open(DATABASE, 1);
    } catch {
      fail();
      return;
    }
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction.abort();
        return;
      }
      request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => {
        db.close();
        if (opening === promise) opening = null;
      };
      resolve(db);
    };
  });
  opening = promise;
  promise.catch(() => {
    if (opening === promise) opening = null;
  });
  return promise;
}
function queued(key, action) {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}
async function transaction(key, mutate) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, mutate ? 'readwrite' : 'readonly', mutate ? { durability: 'strict' } : {});
    } catch {
      reject(new Error('无法创建本机草稿事务；请保存云端或下载本地稿。'));
      return;
    }
    let result;
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {}
    }, 5000);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve(result);
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(new Error('本机草稿保存失败，修改仍在编辑区；请保存或下载。'));
    };
    const store = tx.objectStore(STORE),
      request = store.get(key);
    request.onsuccess = () => {
      result = request.result;
      if (mutate) {
        try {
          result = mutate(store, result);
        } catch {
          tx.abort();
        }
      }
    };
  });
}
export function readDraft(key) {
  return queued(key, async () => {
    const old = legacy(key);
    let value;
    try {
      value = await transaction(key);
      if (value && !valid(value)) throw new Error('本机草稿记录损坏，未覆盖；请保留本地备份。');
      if (!value && old) {
        value = { key, hash: old.hash, baseText: old.baseText, text: old.text, owner };
        await transaction(key, (store, current) => {
          if (current) {
            value = current;
            return current;
          }
          store.put(value);
          return value;
        });
        // Do not delete the prior copy merely because put() was requested.
        const verified = await transaction(key);
        if (
          !verified ||
          verified.hash !== value.hash ||
          verified.text !== value.text ||
          verified.baseText !== value.baseText
        )
          throw new Error('草稿迁移后校验不一致，旧缓存未清理。');
        removeLegacy(key, value);
      }
    } catch (e) {
      if (!old) throw e;
      return { ...old, warning: '已从旧缓存恢复；新草稿缓存不可用，请及时保存或下载。' };
    }
    if (!valid(value)) return null;
    const alternative = legacy(key);
    return {
      ...value,
      ...(alternative && (alternative.hash !== value.hash || alternative.text !== value.text)
        ? { legacyAlternative: alternative }
        : {}),
    };
  });
}
export function writeDraft(key, value) {
  if (!valid(value)) return Promise.reject(new Error('本机草稿内容无效。'));
  return queued(key, async () => {
    await transaction(key, (store) => {
      store.put({ key, owner, hash: value.hash, baseText: value.baseText, text: value.text });
    });
    removeLegacy(key, value);
  });
}
export function settledRecord(current, { previousHash, hash, text }, writer) {
  if (!valid(current)) return current;
  if (current.text === text) return null;
  return current.owner === writer && current.hash === previousHash
    ? { ...current, hash, baseText: text }
    : current;
}
export function settleDraft(key, saved) {
  return queued(key, async () => {
    await transaction(key, (store, current) => {
      const next = settledRecord(current, saved, owner);
      if (next === null) store.delete(key);
      else if (next !== current) store.put(next);
    });
    const old = legacy(key);
    if (old?.text === saved.text) removeLegacy(key, old);
  });
}
