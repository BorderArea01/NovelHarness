import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as rawScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(rawScrypt);

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(pin, salt, 64)) as Buffer;
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [saltText, hashText] = stored.split(':');
  if (!saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64');
  const actual = (await scrypt(pin, Buffer.from(saltText, 'base64'), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function loadOrCreateKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('server.key 必须为 32 字节');
  return key;
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptJson<T>(payload: string, key: Buffer): T {
  const [version, ivText, tagText, dataText] = payload.split('.');
  if (version !== 'v1' || !ivText || !tagText || !dataText) throw new Error('无法识别的加密设置格式');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
