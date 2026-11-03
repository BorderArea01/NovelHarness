// just-bash 3.6.0's original formatter already decodes contiguous hex UTF-8
// escapes, but treats octal UTF-8 bytes as separate Unicode characters. Keep
// its formatting, limits and variable assignment; normalize only explicit,
// valid UTF-8 octal runs into its supported hex-escape representation.
import { printfCommand } from '../node_modules/just-bash/dist/bundle/chunks/printf-V42QCPHL.js';

export function normalizeOctalUtf8(value, argument = false) {
  let output = '';
  for (let i = 0; i < value.length;) {
    if (value[i] !== '\\') {
      output += value[i++];
      continue;
    }
    if (value[i + 1] === '\\') {
      output += value.slice(i, i + 2);
      i += 2;
      continue;
    }
    const start = i,
      bytes = [];
    while (value[i] === '\\') {
      const match = value
        .slice(i)
        .match(argument ? /^\\(?:0([0-7]{1,3})|([1-7][0-7]{0,2}))/ : /^\\([0-7]{1,3})/);
      if (!match) break;
      bytes.push(parseInt(match[1] ?? match[2], 8) & 255);
      i += match[0].length;
    }
    if (!bytes.length) {
      output += value.slice(i, i + 2);
      i += 2;
      continue;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
      output += bytes.map((byte) => '\\x' + byte.toString(16).padStart(2, '0')).join('');
    } catch {
      output += value.slice(start, i);
    }
  }
  return output;
}

export const utf8Printf = {
  name: 'printf',
  async execute(args, ctx) {
    const fixed = [...args];
    let at = 0;
    if (fixed[at] === '-v') at += 2;
    if (fixed[at] === '--') at++;
    if (at >= fixed.length || fixed[at]?.startsWith('-')) return printfCommand.execute(args, ctx);
    const format = fixed[at];
    fixed[at] = normalizeOctalUtf8(format);
    // Select %b arguments exactly; literal %s arguments must remain literal.
    const specs = [...format.matchAll(/%%|%[-+0 #' ]*(\*|\d*)(?:\.(\*|\d*))?(?:\([^)]*\)T|[hlL]?[a-zA-Z])/g)];
    let next = at + 1;
    while (next < fixed.length) {
      const previous = next;
      for (const spec of specs) {
        if (spec[0] === '%%') continue;
        if (spec[1] === '*') next++;
        if (spec[2] === '*') next++;
        if (spec[0].endsWith('b') && next < fixed.length) fixed[next] = normalizeOctalUtf8(fixed[next], true);
        next++;
      }
      if (next === previous) break;
    }
    return printfCommand.execute(fixed, ctx);
  },
};
