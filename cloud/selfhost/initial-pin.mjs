import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import Database from 'better-sqlite3';
import { storageDirectory } from './config.mjs';

export function pinIsConfigured(dataRoot) {
  const path = join(dataRoot, 'home/web-pin.sqlite');
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT value FROM pin_kv WHERE key=?').get('pin-state');
    return !!(row && JSON.parse(row.value).pin);
  } finally {
    db.close();
  }
}

function hiddenPin(label) {
  const input = process.stdin,
    output = process.stdout;
  return new Promise((done, fail) => {
    let value = '';
    const raw = input.isRaw,
      paused = input.isPaused();
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(label);
    function close() {
      input.off('keypress', receive);
      input.setRawMode(raw);
      if (paused) input.pause();
      output.write('\n');
    }
    function receive(text, key) {
      if (key?.ctrl && key.name === 'c') {
        close();
        fail(new Error('初始化已取消。'));
      } else if (key?.name === 'return') {
        close();
        done(value);
      } else if (key?.name === 'backspace' && value.length) {
        value = value.slice(0, -1);
        output.write('\b \b');
      } else if (/^[0-9]$/.test(text ?? '') && value.length < 12) {
        value += text;
        output.write('*');
      }
    }
    input.on('keypress', receive);
  });
}

export async function initialPinForCli(config) {
  if (config.mode !== 'shared' || config.initialPin !== undefined || !process.stdin.isTTY)
    return config.initialPin;
  const root = storageDirectory(config);
  if (pinIsConfigured(root)) return undefined;
  console.log('首次启动私人共享空间。PIN 用于电脑和手机登录，以后可在「数据与访问」修改。');
  while (true) {
    const pin = await hiddenPin('设置 PIN（4–12 位数字）：');
    if (!/^[0-9]{4,12}$/.test(pin)) {
      console.log('请输入 4–12 位数字。');
      continue;
    }
    if (pin === (await hiddenPin('再次输入 PIN：'))) return pin;
    console.log('两次输入不同，请重新设置。');
  }
}
