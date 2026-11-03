// HTTP LAN compatibility for identifiers and content-integrity hashes only.
// Does NOT make HTTP secure, polyfill isSecureContext, or replace HTTPS crypto.
import { sha256, sha384, sha512 } from '../../node_modules/@noble/hashes/esm/sha2.js';
export function installLanCrypto(target = globalThis) {
  const crypto = target.crypto;
  if (!crypto?.getRandomValues) throw new Error('当前浏览器缺少安全随机数，请使用受支持的浏览器。');
  if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { configurable: true, value() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  } });
  if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', { configurable: true, value: Object.freeze({
    async digest(algorithm, input) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
      const hash = { 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 }[name?.toUpperCase()];
      if (!hash) throw new DOMException('局域网兼容层仅支持内容哈希；其他加密操作需要 HTTPS。', 'NotSupportedError');
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      const result = hash(bytes);
      return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    },
  }) });
}
installLanCrypto();
