import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { installLanCrypto } from '../host/lan-crypto.mjs';
test('LAN content hashing matches standard SHA vectors, binary slices and secure UUID v4; HTTPS crypto is untouched', async () => {
  const fake = { crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } };
  installLanCrypto(fake);
  for (const name of ['SHA-256', 'SHA-384', 'SHA-512']) {
    const bytes = new TextEncoder().encode('x雨\r\n🌧️y'), input = bytes.subarray(1, bytes.length - 1);
    const actual = Buffer.from(await fake.crypto.subtle.digest({ name }, input)).toString('hex');
    assert.equal(actual, createHash(name.replace('-', '').toLowerCase()).update(input).digest('hex'));
  }
  assert.match(fake.crypto.randomUUID(), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const original = { subtle: {}, randomUUID() {}, getRandomValues() {} }, target = { crypto: original };
  installLanCrypto(target); assert.equal(target.crypto, original); assert.equal(target.crypto.subtle, original.subtle);
  await assert.rejects(() => fake.crypto.subtle.digest('MD5', new Uint8Array()), /需要 HTTPS/);
});
