// Lossless, versioned structured-value transport for private storage snapshots.
// Never coerce an unknown stored type to JSON: an unsupported value aborts backup.
const views = Object.fromEntries(
  ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array', 'DataView'].map((name) => [name, globalThis[name]]),
);
const hexBytes = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0'));
export function toHex(value) {
  const bytes = new Uint8Array(value), chunks = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    const part = [];
    for (let i = start; i < Math.min(start + 8192, bytes.length); i++) part.push(hexBytes[bytes[i]]);
    chunks.push(part.join(''));
  }
  return chunks.join('');
}
export function fromHex(value) {
  if (typeof value !== 'string' || value.length % 2 || /[^a-f0-9]/.test(value))
    throw new Error('Invalid binary storage value.');
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result.buffer;
}
export function encodeStorageValue(root) {
  const ids = new Map(), nodes = [];
  function encode(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number')
      return Number.isFinite(value) && !Object.is(value, -0) ? value : ['number', String(value), Object.is(value, -0)];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (typeof value !== 'object') throw new Error('Unsupported storage value type.');
    if (ids.has(value)) return ['ref', ids.get(value)];
    if (nodes.length >= 100000) throw new Error('Storage value graph is too large.');
    const id = nodes.length;
    ids.set(value, id);
    nodes.push(null);
    const props = () => Object.keys(value).map((key) => [key, encode(value[key])]);
    let node;
    if (value instanceof ArrayBuffer) node = ['buffer', toHex(value)];
    else if (ArrayBuffer.isView(value)) {
      const name = value instanceof DataView ? 'DataView' : value.constructor.name;
      if (!views[name]) throw new Error('Unsupported binary view.');
      node = ['view', name, encode(value.buffer), value.byteOffset, value instanceof DataView ? value.byteLength : value.length];
    } else if (value instanceof Date) node = ['date', encode(value.getTime())];
    else if (value instanceof Map) node = ['map', [...value].map(([k, v]) => [encode(k), encode(v)])];
    else if (value instanceof Set) node = ['set', [...value].map(encode)];
    else if (value instanceof RegExp) node = ['regexp', value.source, value.flags];
    else if (value instanceof Error) node = ['error', value.name, value.message, value.stack, encode(value.cause), props()];
    else if (Array.isArray(value)) node = ['array', value.length, props()];
    else if ([Object.prototype, null].includes(Object.getPrototypeOf(value)))
      node = ['object', Object.getPrototypeOf(value) === null, props()];
    else throw new Error('Unsupported stored object; backup was not completed.');
    nodes[id] = node;
    return ['ref', id];
  }
  const value = encode(root);
  return { version: 1, value, nodes };
}
export function decodeStorageValue(graph) {
  if (graph?.version !== 1 || !Array.isArray(graph.nodes) || graph.nodes.length > 100000)
    throw new Error('Invalid storage value graph.');
  const cache = new Map();
  const props = (target, entries) => {
    for (const [key, value] of entries)
      Object.defineProperty(target, key, { value: decode(value), writable: true, configurable: true, enumerable: true });
    return target;
  };
  function decode(value) {
    if (!Array.isArray(value)) {
      if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return value;
      throw new Error('Invalid storage primitive.');
    }
    if (value[0] === 'undefined') return undefined;
    if (value[0] === 'bigint') return BigInt(value[1]);
    if (value[0] === 'number') {
      if (value[2]) return -0;
      if (!['NaN', 'Infinity', '-Infinity'].includes(value[1])) throw new Error('Invalid special number.');
      return Number(value[1]);
    }
    const id = value[1];
    if (value[0] !== 'ref' || !Number.isInteger(id) || id < 0 || id >= graph.nodes.length)
      throw new Error('Invalid storage reference.');
    if (cache.has(id)) return cache.get(id);
    const node = graph.nodes[id];
    let out;
    switch (node[0]) {
      case 'buffer': out = fromHex(node[1]); break;
      case 'view': {
        if (!views[node[1]]) throw new Error('Invalid binary view.');
        out = new views[node[1]](decode(node[2]), node[3], node[4]); break;
      }
      case 'date': out = new Date(decode(node[1])); break;
      case 'regexp': out = new RegExp(node[1], node[2]); break;
      case 'array': out = new Array(node[1]); break;
      case 'object': out = Object.create(node[1] ? null : Object.prototype); break;
      case 'map': out = new Map(); break;
      case 'set': out = new Set(); break;
      case 'error': out = new Error(node[2]); out.name = node[1]; out.stack = node[3]; break;
      default: throw new Error('Unsupported storage graph node.');
    }
    cache.set(id, out);
    if (node[0] === 'map') for (const [k, v] of node[1]) out.set(decode(k), decode(v));
    if (node[0] === 'set') for (const v of node[1]) out.add(decode(v));
    if (node[0] === 'object') props(out, node[2]);
    if (node[0] === 'array') props(out, node[2]);
    if (node[0] === 'error') { out.cause = decode(node[4]); props(out, node[5]); }
    return out;
  }
  return decode(graph.value);
}
