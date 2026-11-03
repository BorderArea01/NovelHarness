// One indexed native VFS revision, not a second document store. Every original
// writer (editor, Agent, imports and native file tools) advances this revision.
// The pinned upstream schema owns it; never install triggers or modify its data.
export function readWorkspaceRevision(fs) {
  if (typeof fs.db?.one !== 'function') throw new Error('Native VFS revision unavailable.');
  const row = fs.db.one("SELECT v FROM vfs_meta WHERE k = 'rev'");
  if (!Number.isSafeInteger(row?.v) || row.v < 0) throw new Error('Invalid native VFS revision.');
  return String(row.v);
}

// Bounded, instance-local read-through cache. No persistence, stale-on-error,
// TTL guessing, writes or sharing between Durable Objects/accounts. A cold
// instance and a different VFS revision always require a fresh native read.
export function createReadSnapshots({ maxBytes = 8 * 1024 * 1024, maxEntries = 32 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => {
    const value = entries.get(key);
    if (value) bytes -= value.bytes;
    entries.delete(key);
  };
  return {
    // A sleeping/restarted DO loses its cache, not its durable VFS revision.
    // Random per-process epochs would turn every cold check into a full scan.
    token: (revision) => 'vfs:' + revision,
    get(key, revision) {
      const value = entries.get(key);
      if (!value) return null;
      if (value.revision !== revision) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, value);
      return value.body;
    },
    put(key, revision, result) {
      remove(key);
      const body = JSON.stringify(result);
      const size = new TextEncoder().encode(body).byteLength;
      if (size > maxBytes) return body;
      while (entries.size && (bytes + size > maxBytes || entries.size >= maxEntries))
        remove(entries.keys().next().value);
      entries.set(key, { revision, body, bytes: size });
      bytes += size;
      return body;
    },
  };
}
